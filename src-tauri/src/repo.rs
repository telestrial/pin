// The Curator's local atproto repo engine.
//
// Slice 3 brought the engine up in memory (signed MST + commits, CID-addressed)
// under a stable signing key. Slice 5 makes the repo's *content* durable: it now
// lives in a CAR file on disk, so records — and the signed root they hang from —
// survive a restart. The engine is also kept LIVE for the Curator's lifetime
// (wrapped in an async mutex) so the RPC `record` verb can read it on demand,
// rather than being created, sampled, and dropped.
//
// Persistence model: the repo's blockstore IS an on-disk CAR (`repo.car`), opened
// read+write so commits append. The current signed root commit CID is the one
// thing a reopen needs that the CAR header doesn't carry (the header's roots are
// fixed at create time; ours moves per commit), so we persist it beside the CAR
// as `repo_root`. On start: if both are present and valid we reopen the existing
// repo; otherwise we create a fresh one and write the marker. Finding the marker
// after a reopen is the proof that content survived the restart.
//
// Identity (rung 6a, native genesis): the repo's signing key is now DERIVED from
// the Sia recovery phrase — HKDF-SHA256 over the AppKey bytes the frontend hands
// over, info "pin:atproto-signing:v1" (the same one-root-secret move settings
// encryption uses). So the repo's DID is recoverable on any device from the
// recovery phrase alone, and nothing secret about the identity persists on disk —
// the only stored secret is the per-device iroh node key. The repo is authored
// under the keeper's did:dht (see identity.rs) — that P-256 key signs commits and
// is the did:dht document's verification method. Resolving a stranger's did:dht to
// their keeper's iroh address is the resolver (identity.rs) + the pull loop.

use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use atrium_api::types::string::Did;
use atrium_crypto::keypair::{Did as _, P256Keypair};
use atrium_repo::blockstore::CarStore;
use atrium_repo::{Cid, Repository};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::fs::{File, OpenOptions};
use tokio::sync::Mutex;

/// The repo's on-disk blockstore: an append-only CAR file.
type RepoStore = CarStore<File>;
/// The live repository, held for the Curator's lifetime.
type LiveRepo = Repository<RepoStore>;
/// The shared, lockable repo handed to the RPC handler. `get_raw` takes `&mut`,
/// so reads serialize behind the async mutex — fine at friend-scale.
pub type SharedRepo = Arc<Mutex<LiveRepo>>;

/// The path of the marker record (collection/rkey). Written once at creation,
/// then expected to survive every reopen — the persistence self-check.
const MARKER_PATH: &str = "dev.sia.pin.marker/self";

/// What the repo engine hands back to the Curator: the live repo plus the facts
/// the diagnostics + RPC `head` verb report.
pub struct RepoHandle {
    /// The live repo, shared with the RPC handler.
    pub repo: SharedRepo,
    /// The repo's P-256 verification-method did:key (the commit-signing key,
    /// derived from the recovery phrase via HKDF). The repo's OWNER DID is the
    /// `did_dht` below; this key is what that DID's document authorizes to sign.
    pub did: String,
    /// The keeper's `did:dht` identifier (ed25519, same phrase) — the resolvable
    /// decentralized identity AND the repo's OWNER DID (the repo is authored under
    /// it). The P-256 `did` above is its verification method.
    pub did_dht: String,
    /// The ed25519 did:dht keypair itself — needed to sign the DID document
    /// published to the DHT. Derived from the recovery phrase, held only in memory.
    pub identity: pkarr::Keypair,
    /// The signed root commit CID.
    pub root: String,
    /// The signature over the current commit (served by the RPC `head` verb).
    pub commit_sig: Vec<u8>,
    /// True if the repo was reopened from an existing on-disk CAR, false if it
    /// was created fresh this run. Lets the UI show that content survived.
    pub reopened: bool,
    /// Path to the on-disk CAR. The RPC `diff` verb opens a fresh read-only view
    /// of it (shared-read alongside the live handle) to walk arbitrary roots and
    /// read blocks — things the encapsulated live repo doesn't expose.
    pub car_path: PathBuf,
}

/// A tiny marker record, written at creation and read back to prove the engine
/// round-trips a custom-lexicon record — and, after a restart, that it persisted.
#[derive(Serialize, Deserialize)]
struct Marker {
    #[serde(rename = "$type")]
    typ: String,
    note: String,
}

/// HKDF `info` for the repo signing key — domain-separates it from settings
/// encryption (`pin:settings:v1`) and any other key derived from the same AppKey.
const SIGNING_KEY_INFO: &[u8] = b"pin:atproto-signing:v1";

/// Derive the repo's P-256 signing key from the Sia AppKey via HKDF-SHA256 — the
/// "one root secret" move: recovery phrase → AppKey → signing key, deterministic,
/// stored nowhere. Same key on every device that holds the phrase, so the repo's
/// DID is recoverable rather than backed up.
///
/// This derives the DEFAULT identity. Multiple identities are NOT foreclosed:
/// per-persona `info` variants yield independent, separately-recoverable DIDs
/// (HD-wallet style) — the path for the parked persona-as-DID reframe — so the
/// bare `info` here stays reserved for the default and must not be repurposed
/// (changing it would move the default DID).
///
/// The bare `info` is the canonical derivation. A 32-byte HKDF output is a valid
/// P-256 scalar with overwhelming probability (~1 - 2^-32); on the vanishing
/// chance it isn't, we deterministically retry with a counter appended to `info`,
/// so the derivation never fails on an unlucky AppKey.
fn derive_signing_key(app_key: &[u8]) -> Result<P256Keypair, String> {
    let hk = Hkdf::<Sha256>::new(None, app_key);
    let mut okm = [0u8; 32];
    hk.expand(SIGNING_KEY_INFO, &mut okm)
        .map_err(|e| format!("hkdf expand: {e}"))?;
    if let Ok(kp) = P256Keypair::import(&okm) {
        return Ok(kp);
    }
    for counter in 0u8..=u8::MAX {
        let mut info = SIGNING_KEY_INFO.to_vec();
        info.push(counter);
        hk.expand(&info, &mut okm)
            .map_err(|e| format!("hkdf expand: {e}"))?;
        if let Ok(kp) = P256Keypair::import(&okm) {
            return Ok(kp);
        }
    }
    Err("could not derive a valid P-256 signing key from the app key".to_string())
}

/// Decode the 32-byte Sia AppKey from its hex form (the IKM for `derive_signing_key`).
fn decode_app_key(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Bring up the local repo from `data_dir` under the identity derived from
/// `app_key_hex` (the Sia recovery phrase, via the AppKey). Reopen the on-disk CAR
/// if it was created under this same identity, otherwise create a fresh one (and
/// write the marker). Returns the live repo, its DID + signed root, and whether it
/// was reopened.
pub async fn init_repo(
    data_dir: Option<&Path>,
    app_key_hex: Option<&str>,
) -> Result<RepoHandle, String> {
    let dir = data_dir.ok_or_else(|| "no curator data dir; repo persistence unavailable".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("create data dir: {e}"))?;
    let car_path = dir.join("repo.car");
    let root_path = dir.join("repo_root");
    let did_path = dir.join("repo_did");

    // The identity is derived from the recovery phrase (via the AppKey), not stored.
    let app_key_hex = app_key_hex
        .ok_or_else(|| "no Sia identity available to derive the repo signing key".to_string())?;
    let app_key =
        decode_app_key(app_key_hex).ok_or_else(|| "app key hex must be 32 bytes".to_string())?;
    let keypair = derive_signing_key(&app_key)?;
    // The P-256 did:key is now the repo's VERIFICATION METHOD, not its owner — the
    // repo is authored under the did:dht below; this key signs commits and the
    // did:dht document lists it as the verification method.
    let verification_did = keypair.did();

    // The repo's OWNER DID is the resolvable did:dht identity (ed25519, derived
    // from the same phrase via a domain-separated HKDF info), so a peer who resolves
    // this did:dht finds a repo that claims it.
    let identity = crate::identity::derive_identity(&app_key)?;
    let did_dht = crate::identity::did_dht(&identity);
    let owner_did = Did::new(did_dht.clone()).map_err(|e| format!("did: {e}"))?;

    // A signing key stored by a pre-derivation build is now dead weight — the only
    // persisted secret should be the per-device node key. Best-effort cleanup.
    let _ = fs::remove_file(dir.join("repo_key"));

    // Reopen only if the on-disk repo was created under THIS owner DID; a mismatch
    // (e.g. the one-time switch from did:key authoring to did:dht) means the CAR is
    // stale, so recreate fresh under the did:dht.
    let (mut repo, reopened) =
        match open_existing(&car_path, &root_path, &did_path, &did_dht).await {
            Some((store, root)) => {
                let repo = Repository::open(store, root)
                    .await
                    .map_err(|e| format!("open repo: {e}"))?;
                (repo, true)
            }
            None => (
                create_fresh(&car_path, &root_path, &did_path, owner_did, &did_dht, &keypair).await?,
                false,
            ),
        };

    // The marker must round-trip: freshly written if created, survived the
    // restart if reopened. Either way, no marker means the engine is broken.
    let got: Option<Marker> = repo
        .get_raw(MARKER_PATH)
        .await
        .map_err(|e| format!("get_raw: {e}"))?;
    if got.is_none() {
        return Err("marker record did not round-trip".to_string());
    }

    let root = repo.root().to_string();
    let commit_sig = repo.commit().sig().to_vec();
    Ok(RepoHandle {
        repo: Arc::new(Mutex::new(repo)),
        did: verification_did,
        did_dht,
        identity,
        root,
        commit_sig,
        reopened,
        car_path,
    })
}

/// Open the on-disk CAR + its persisted root, if present, valid, AND created under
/// `expected_did`. Any missing/corrupt/mismatched piece returns None, so the caller
/// falls back to creating a fresh repo (a lost or re-keyed repo rebuilds rather
/// than wedging or signing new commits under the wrong identity).
async fn open_existing(
    car_path: &Path,
    root_path: &Path,
    did_path: &Path,
    expected_did: &str,
) -> Option<(RepoStore, Cid)> {
    // Reopen only if the persisted identity matches the derived one.
    if fs::read_to_string(did_path).ok()?.trim() != expected_did {
        return None;
    }
    let root_str = fs::read_to_string(root_path).ok()?;
    let root = Cid::from_str(root_str.trim()).ok()?;
    // Read+write so subsequent commits can append; no `create`, so a missing
    // file yields None rather than an empty repo.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(car_path)
        .await
        .ok()?;
    let store = CarStore::open(file).await.ok()?;
    Some((store, root))
}

/// Create a fresh repo on disk: a new (truncated) CAR, a signed root commit, the
/// marker record, and the persisted root + DID pointers.
async fn create_fresh(
    car_path: &Path,
    root_path: &Path,
    did_path: &Path,
    did: Did,
    did_str: &str,
    keypair: &P256Keypair,
) -> Result<LiveRepo, String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(car_path)
        .await
        .map_err(|e| format!("open car: {e}"))?;
    let store = CarStore::create(file)
        .await
        .map_err(|e| format!("create car: {e}"))?;

    let builder = Repository::create(store, did)
        .await
        .map_err(|e| format!("create: {e}"))?;
    let sig = keypair
        .sign(&builder.bytes())
        .map_err(|e| format!("sign root: {e}"))?;
    let mut repo = builder
        .finalize(sig)
        .await
        .map_err(|e| format!("finalize root: {e}"))?;

    // Write the marker (custom lexicon, via add_raw — no Collection impl needed),
    // sign the resulting commit, and finalize it.
    let marker = Marker {
        typ: "dev.sia.pin.marker".to_string(),
        note: "curator repo engine online".to_string(),
    };
    let (commit_builder, _record_cid) = repo
        .add_raw(MARKER_PATH, &marker)
        .await
        .map_err(|e| format!("add_raw: {e}"))?;
    let sig = keypair
        .sign(&commit_builder.bytes())
        .map_err(|e| format!("sign commit: {e}"))?;
    commit_builder
        .finalize(sig)
        .await
        .map_err(|e| format!("finalize commit: {e}"))?;

    persist_root(root_path, &repo)?;
    // Record the identity this CAR was created under, so a later reopen can confirm
    // the derived key still matches before signing new commits over it.
    fs::write(did_path, did_str).map_err(|e| format!("persist did: {e}"))?;
    Ok(repo)
}

/// Persist the repo's current signed root CID beside the CAR. Must be called
/// after any commit so a reopen lands on the latest root (today: just creation).
fn persist_root(root_path: &Path, repo: &LiveRepo) -> Result<(), String> {
    fs::write(root_path, repo.root().to_string()).map_err(|e| format!("persist root: {e}"))
}
