// The Curator's local atproto repo engine.
//
// Slice 3 (repo engine): a signed atproto repository held locally, the same data
// structure (MST + signed commits, CID-addressed) the eventual serve/pull/diff
// RPC operates over. This is the in-process proof that the engine runs in the
// Curator: create a repo under a stable signing identity, write a record, read
// it back, and report the repo's DID + root commit CID.
//
// Two deliberate scope limits for this cut, both flagged for follow-ups:
//   1. The blockstore is in-memory (MemoryBlockStore) — the repo's *content* is
//      recreated each session. Only the SIGNING KEY is persisted, so the repo's
//      DID is stable. On-disk repo persistence (CAR file) is the next step.
//   2. The signing key is a local stub (a fresh P-256 key, did:key). The REAL
//      Pin identity is did:plc (the atproto account), whose signing key lives
//      server-side at the PDS today — bridging that into the backend is the
//      identity-binding / bsky→keeper-migration slice. Until then the repo runs
//      under its own local key, kept beside the iroh key for the future vault.

use std::fs;
use std::path::Path;

use atrium_api::types::string::Did;
use atrium_crypto::keypair::{Did as _, Export as _, P256Keypair};
use atrium_repo::{blockstore::MemoryBlockStore, Repository};
use serde::{Deserialize, Serialize};

/// What the repo engine reports back to the Curator's diagnostics.
pub struct RepoInfo {
    /// The repo's did:key (stable across restarts — derived from the persisted
    /// signing key).
    pub did: String,
    /// The signed root commit CID after the marker write.
    pub root: String,
}

/// A tiny marker record, written and read back to prove the engine round-trips
/// a custom-lexicon record end to end.
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
fn load_or_create_signing_key(path: Option<&Path>) -> P256Keypair {
    if let Some(path) = path {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(kp) = P256Keypair::import(&bytes) {
                return kp;
            }
            log::warn!("curator repo key malformed; regenerating");
        }
        let kp = P256Keypair::create(&mut rand::thread_rng());
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(path, kp.export()).is_err() {
            log::warn!("curator could not persist repo key at {}", path.display());
        }
        return kp;
    }
    P256Keypair::create(&mut rand::thread_rng())
}

/// Bring up the local repo: create it under the (stable) signing identity, write
/// and read back a marker record, and report the DID + root commit CID.
pub async fn init_repo(key_path: Option<&Path>) -> Result<RepoInfo, String> {
    let keypair = load_or_create_signing_key(key_path);
    let did_str = keypair.did();
    let did = Did::new(did_str.clone()).map_err(|e| format!("did: {e}"))?;

    let mut bs = MemoryBlockStore::new();
    let builder = Repository::create(&mut bs, did)
        .await
        .map_err(|e| format!("create: {e}"))?;
    let sig = keypair
        .sign(&builder.bytes())
        .map_err(|e| format!("sign root: {e}"))?;
    let mut repo = builder
        .finalize(sig)
        .await
        .map_err(|e| format!("finalize root: {e}"))?;

    // Write a marker record (custom lexicon, via add_raw — no Collection impl
    // needed), sign the resulting commit, and finalize it.
    let path = "dev.sia.pin.marker/self";
    let marker = Marker {
        typ: "dev.sia.pin.marker".to_string(),
        note: "curator repo engine online".to_string(),
    };
    let (commit_builder, _record_cid) = repo
        .add_raw(path, &marker)
        .await
        .map_err(|e| format!("add_raw: {e}"))?;
    let sig = keypair
        .sign(&commit_builder.bytes())
        .map_err(|e| format!("sign commit: {e}"))?;
    commit_builder
        .finalize(sig)
        .await
        .map_err(|e| format!("finalize commit: {e}"))?;

    // Read it back to prove the round-trip.
    let got: Option<Marker> = repo
        .get_raw(path)
        .await
        .map_err(|e| format!("get_raw: {e}"))?;
    if got.is_none() {
        return Err("marker record did not round-trip".to_string());
    }

    Ok(RepoInfo {
        did: did_str,
        root: repo.root().to_string(),
    })
}
