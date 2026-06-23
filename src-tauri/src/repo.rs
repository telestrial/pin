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
// One deliberate scope limit still stands (flagged for the identity slice): the
// signing key is a local stub (a persisted P-256 key → did:key). The REAL Pin
// identity is did:plc (the atproto account), whose key lives at the PDS today;
// binding the repo to that DID is the identity / bsky→keeper-migration slice.
// Until then the repo runs under its own local key, kept beside the iroh node key
// and the CAR under `curator/` for the future encrypted local vault.

use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use atrium_api::types::string::Did;
use atrium_crypto::keypair::{Did as _, Export as _, P256Keypair};
use atrium_repo::blockstore::CarStore;
use atrium_repo::{Cid, Repository};
use serde::{Deserialize, Serialize};
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
    /// The repo's did:key (stable across restarts — derived from the persisted
    /// signing key).
    pub did: String,
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

/// Load the persisted P-256 signing key, or generate one and persist it. We own
/// the raw key bytes (export/import) so it survives restarts — giving the repo a
/// stable DID. Kept beside the iroh node key under `curator/` for the future
/// encrypted local vault.
fn load_or_create_signing_key(path: &Path) -> P256Keypair {
    if let Ok(bytes) = fs::read(path) {
        if let Ok(kp) = P256Keypair::import(&bytes) {
            return kp;
        }
        log::warn!("curator repo key malformed; regenerating");
    }
    let kp = P256Keypair::create(&mut rand::thread_rng());
    if fs::write(path, kp.export()).is_err() {
        log::warn!("curator could not persist repo key at {}", path.display());
    }
    kp
}

/// Bring up the local repo from `data_dir`: reopen the on-disk CAR if present,
/// otherwise create a fresh one (and write the marker). Returns the live repo,
/// its DID + signed root, and whether it was reopened.
pub async fn init_repo(data_dir: Option<&Path>) -> Result<RepoHandle, String> {
    let dir = data_dir.ok_or_else(|| "no curator data dir; repo persistence unavailable".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("create data dir: {e}"))?;
    let key_path = dir.join("repo_key");
    let car_path = dir.join("repo.car");
    let root_path = dir.join("repo_root");

    let keypair = load_or_create_signing_key(&key_path);
    let did_str = keypair.did();
    let did = Did::new(did_str.clone()).map_err(|e| format!("did: {e}"))?;

    // Reopen the existing repo if both the CAR and its root pointer are present
    // and valid; otherwise create a fresh one under the (stable) signing key.
    let (mut repo, reopened) = match open_existing(&car_path, &root_path).await {
        Some((store, root)) => {
            let repo = Repository::open(store, root)
                .await
                .map_err(|e| format!("open repo: {e}"))?;
            (repo, true)
        }
        None => (create_fresh(&car_path, &root_path, did, &keypair).await?, false),
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
        did: did_str,
        root,
        commit_sig,
        reopened,
        car_path,
    })
}

/// Open the on-disk CAR + its persisted root, if both are present and valid.
/// Any missing/corrupt piece returns None, so the caller falls back to creating
/// a fresh repo (a lost repo rebuilds rather than wedging).
async fn open_existing(car_path: &Path, root_path: &Path) -> Option<(RepoStore, Cid)> {
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
/// marker record, and the persisted root pointer.
async fn create_fresh(
    car_path: &Path,
    root_path: &Path,
    did: Did,
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
    Ok(repo)
}

/// Persist the repo's current signed root CID beside the CAR. Must be called
/// after any commit so a reopen lands on the latest root (today: just creation).
fn persist_root(root_path: &Path, repo: &LiveRepo) -> Result<(), String> {
    fs::write(root_path, repo.root().to_string()).map_err(|e| format!("persist root: {e}"))
}
