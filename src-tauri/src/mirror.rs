// The Curator's Sia mirror — Slice 5.
//
// Sia is the keeper's durability + offline-serve fallback: while the keeper is
// online peers read the live repo over iroh (always current), but when the
// machine is asleep they can fall back to a copy on Sia. So the mirror's job is
// to keep Sia *eventually equal* to the local repo, with a bound that's fine for
// a fallback read.
//
// Because the repo's identity IS its root commit CID, "is the mirror stale?" is a
// pure equality check (`mirrored_root == current_root`) — no clock. The trigger
// is therefore a *change*, not a poll: reconcile on load now, and (once the repo
// gains writers — the identity/migration slice) a debounced push after each
// commit. `mirror_if_stale` is the reconcile both call; today, with a static
// post-init repo, it pushes once on first run and no-ops thereafter.
//
// The mirror artifact is the CURRENT-STATE repo as a compacted CAR (via
// `export_into`, which walks only blocks reachable from the current root — so the
// mirror is clean even though the on-disk `repo.car` is append-only). That's the
// same CAR a peer would import. Commit history / the did:plc op-log mirror are
// separate identity-slice artifacts, deliberately not preserved here.
//
// Auth: the keeper runs inside an authenticated Pin instance, so the frontend
// hands it the already-unlocked Sia AppKey + indexer URL over IPC. We rebuild the
// SAME identity the app uses — same AppMetadata/AppID (so encryption keys match)
// and the user's AppKey — so the mirror lands in the user's own Sia scope
// alongside their pins ("yours over theirs"), not a separate account.

use std::fs;
use std::io::Cursor;
use std::path::Path;

use atrium_repo::blockstore::CarStore;
use serde::{Deserialize, Serialize};
use sia_storage::{
    app_id, AppKey, AppMetadata, Builder, DateTime, DownloadOptions, Hash256, Object, Sdk,
    UploadOptions, Utc,
};

use crate::repo::SharedRepo;

/// The Pin app's Sia identity — must match the frontend's `APP_META`
/// (`lib/constants.ts`) exactly. The AppID derives the user's encryption keys, so
/// a mismatch would put the mirror in a different encryption scope than the app's
/// own objects. name/description/serviceURL are display-only on the indexer.
fn app_meta() -> AppMetadata {
    AppMetadata {
        id: app_id!("f6b7539e181e45ee750a491a58aa8392830a17c402115cf47c6e7dfe9f7ffcb0"),
        name: "Pin",
        description: "A Sia storage app",
        service_url: "https://sia.storage",
        logo_url: None,
        callback_url: None,
    }
}

/// What was last mirrored, persisted beside the repo as `curator/mirror.json`.
/// The `root` is what makes the staleness check a CID equality; the `object_id`
/// lets us delete the superseded mirror after a fresh push.
#[derive(Serialize, Deserialize)]
struct MirrorState {
    /// The repo root commit CID this mirror reflects.
    root: String,
    /// The Sia object holding the CAR (to delete when superseded).
    object_id: Hash256,
    /// The object's share URL — the address a peer would fetch the fallback from
    /// (the peer-fetch path itself is a later slice).
    url: String,
}

/// Outcome of a reconcile, surfaced in diagnostics.
pub enum MirrorOutcome {
    /// `mirrored_root == current_root` — nothing to do.
    UpToDate,
    /// A fresh CAR was pushed; carries its share URL.
    Pushed { url: String },
}

/// Rebuild the app's Sia SDK from the handed-over AppKey + indexer URL. The same
/// restore path the frontend runs (`Builder::connected`), in Rust.
pub async fn connect_sdk(indexer_url: &str, app_key_hex: &str) -> Result<Sdk, String> {
    let bytes = hex_to_32(app_key_hex).ok_or("app key hex must be 32 bytes")?;
    let app_key = AppKey::import(bytes);
    let builder = Builder::new(indexer_url, app_meta()).map_err(|e| format!("builder: {e}"))?;
    builder
        .connected(&app_key)
        .await
        .map_err(|e| format!("connect: {e}"))?
        .ok_or_else(|| "indexer did not recognize this app key".to_string())
}

/// Reconcile the Sia mirror with the local repo: if the mirrored root already
/// equals the current root, do nothing; otherwise export the current state as a
/// compacted CAR, push it to the user's Sia scope, verify the round-trip, record
/// it, and delete the superseded object.
pub async fn mirror_if_stale(
    sdk: &Sdk,
    repo: &SharedRepo,
    mirror_path: &Path,
) -> Result<MirrorOutcome, String> {
    let prior = read_state(mirror_path);

    // Export the current state as a compacted CAR — but only if we're actually
    // stale. The lock is held just long enough to read the root and (if needed)
    // walk it; an up-to-date check costs nothing beyond the root read.
    let (root_str, car_bytes) = {
        let mut r = repo.lock().await;
        let root = r.root();
        let root_str = root.to_string();
        if prior.as_ref().map(|m| m.root.as_str()) == Some(root_str.as_str()) {
            return Ok(MirrorOutcome::UpToDate);
        }
        let mut buf = Vec::new();
        {
            let mut car = CarStore::create_with_roots(Cursor::new(&mut buf), [root])
                .await
                .map_err(|e| format!("create car: {e}"))?;
            r.export_into(&mut car)
                .await
                .map_err(|e| format!("export: {e}"))?;
        }
        (root_str, buf)
    };

    // Push to Sia (the user's own scope), then pin so it stays alive.
    let object = sdk
        .upload(Object::default(), Cursor::new(car_bytes), UploadOptions::default())
        .await
        .map_err(|e| format!("upload: {e}"))?;
    sdk.pin_object(&object)
        .await
        .map_err(|e| format!("pin: {e}"))?;

    // Verify the round-trip before trusting the mirror: download it back and
    // confirm it parses as a CAR rooted at the repo's root. `CarStore::open`
    // hash-validates every block, so a successful open + matching root means the
    // bytes are intact. (Strong check for the first live native-Sia exercise; a
    // later refinement can drop the per-push verify once it's proven in the wild.)
    verify_round_trip(sdk, &object, &root_str).await?;

    let url = sdk
        .share_object(&object, far_future())
        .map_err(|e| format!("share: {e}"))?
        .to_string();

    write_state(
        mirror_path,
        &MirrorState {
            root: root_str,
            object_id: object.id(),
            url: url.clone(),
        },
    )?;

    // Delete the superseded mirror (best-effort — a lingering old object is
    // wasted space, not a correctness problem; the next push retries the delete
    // indirectly by never re-recording it).
    if let Some(p) = prior {
        if let Err(e) = sdk.delete_object(&p.object_id).await {
            log::warn!("curator mirror: could not delete prior object: {e}");
        }
    }

    Ok(MirrorOutcome::Pushed { url })
}

async fn verify_round_trip(sdk: &Sdk, object: &Object, expected_root: &str) -> Result<(), String> {
    let mut dl = sdk
        .download(object, DownloadOptions::default())
        .map_err(|e| format!("verify download: {e}"))?;
    let mut got = Vec::new();
    tokio::io::copy(&mut dl, &mut got)
        .await
        .map_err(|e| format!("verify read: {e}"))?;
    let car = CarStore::open(Cursor::new(got))
        .await
        .map_err(|e| format!("verify open: {e}"))?;
    if car.roots().any(|r| r.to_string() == expected_root) {
        Ok(())
    } else {
        Err("verify: downloaded CAR root does not match".to_string())
    }
}

/// Year-9999, matching the frontend's `FAR_FUTURE` — effectively-permanent share.
fn far_future() -> DateTime<Utc> {
    "9999-12-31T00:00:00Z"
        .parse()
        .expect("valid far-future timestamp")
}

fn read_state(path: &Path) -> Option<MirrorState> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_state(path: &Path, state: &MirrorState) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|e| format!("encode mirror state: {e}"))?;
    fs::write(path, bytes).map_err(|e| format!("write mirror state: {e}"))
}

fn hex_to_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}
