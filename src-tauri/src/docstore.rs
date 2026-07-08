// The iroh-docs engine — the repo/sync layer replacing the atrium repo + the
// hand-rolled 4-verb RPC (see CLAUDE.md 2026-07-05). iroh-docs is a multi-author
// synced KV: range-based set reconciliation (ships only the delta), live-sync over
// gossip, content-addressed values via iroh-blobs. Importing a peer's doc and
// letting it sync IS "network surfacing" — the pull loop collapses into the engine.
//
// Step 2 proved surfacing works inside the real keeper (two namespaces reconcile,
// live write propagates, delta-only transfer). Step 3a (this slice) stands the
// engine up for real: a PERSISTENT store (redb via iroh-blobs' fs-store, on disk)
// mounted on the keeper's OWN endpoint, running ALONGSIDE the atrium repo. The
// persistence proof is the "reopened from disk" state — the marker entry written on
// first run survives restarts. Removing atrium (and the head/record/diff verbs) is
// the next slice; this one adds without subtracting.
//
// Identity binding: the namespace + author keys derive from the same Sia AppKey the
// rest of the keeper's identity hangs off (HKDF, domain-separated `info`), so the
// keeper's doc is recoverable from the recovery phrase — the same one-root-secret
// move as the did:dht key and settings encryption.

use std::path::Path;

use hkdf::Hkdf;
use iroh::Endpoint;
use iroh_blobs::store::fs::FsStore;
use iroh_docs::{protocol::Docs, Author, Capability, NamespaceSecret};
use iroh_gossip::net::Gossip;
use sha2::Sha256;

/// HKDF `info`s for the doc keys — domain-separated from the did:dht identity
/// (`pin:did-dht:v1`), the atproto signing key (`pin:atproto-signing:v1`), and
/// settings (`pin:settings:v1`), all off the same AppKey root.
const NS_INFO: &[u8] = b"pin:iroh-docs-namespace:v1";
const AUTHOR_INFO: &[u8] = b"pin:iroh-docs-author:v1";

/// The keeper's marker entry, mirroring the atrium repo's marker record — written
/// once, then expected to survive every reopen (the persistence self-check).
const MARKER_KEY: &[u8] = b"dev.sia.pin.marker/self";

/// HKDF-SHA256 → 32 bytes. 32 is always a valid output length.
fn hkdf32(ikm: &[u8], info: &[u8]) -> Result<[u8; 32], String> {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut okm = [0u8; 32];
    hk.expand(info, &mut okm)
        .map_err(|e| format!("hkdf expand: {e}"))?;
    Ok(okm)
}

/// Decode the 32-byte Sia AppKey from its hex form (the HKDF IKM).
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

/// The persistent iroh-docs engine, brought up on the keeper's endpoint and ready
/// to mount on its Router. Held for the Curator's lifetime; `docs`/`gossip` are
/// `Clone` and `blobs` derefs to the blobs `Store`, so the Router takes clones/refs
/// and this struct stays whole.
pub struct DocEngine {
    /// The docs protocol handler (mount on `iroh_docs::ALPN`; also the API for
    /// reading/writing the keeper's doc).
    pub docs: Docs,
    /// The persistent blobs store (mount on `iroh_blobs::ALPN`; holds record
    /// values content-addressed).
    pub blobs: FsStore,
    /// The gossip overlay (mount on `iroh_gossip::ALPN`; drives live-sync).
    pub gossip: Gossip,
    /// The keeper's doc namespace id (the doc's public identifier).
    pub namespace_id: String,
    /// True if the marker was already present on load — i.e. the doc persisted from
    /// a prior run. False on first-ever creation. This is the persistence proof.
    pub reopened: bool,
}

/// Bring up (or reopen) the keeper's persistent iroh-docs engine on `endpoint`,
/// under a namespace + author derived from the Sia AppKey. Stores live on disk under
/// `<data_dir>/docs` (`blobs.db`, `docs.redb`, `default-author`). Writes the marker
/// entry on first creation; finding it on a later run is what proves persistence.
pub async fn open_or_create(
    endpoint: &Endpoint,
    data_dir: &Path,
    app_key_hex: &str,
) -> Result<DocEngine, String> {
    let app_key = decode_app_key(app_key_hex).ok_or("app key hex must be 32 bytes")?;
    let ns_seed = hkdf32(&app_key, NS_INFO)?;
    let author_seed = hkdf32(&app_key, AUTHOR_INFO)?;

    let dir = data_dir.join("docs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create docs dir: {e}"))?;

    // Persistent stack on the keeper's endpoint: fs blobs store + redb-backed docs
    // replica + gossip. `(*blobs).clone()` hands `spawn` the blobs `Store` (FsStore
    // derefs to it); `gossip.clone()` because gossip is also mounted on the Router.
    let gossip = Gossip::builder().spawn(endpoint.clone());
    let blobs = FsStore::load(&dir)
        .await
        .map_err(|e| format!("blobs store load: {e}"))?;
    let docs = Docs::persistent(dir.clone())
        .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
        .await
        .map_err(|e| format!("docs spawn: {e}"))?;

    // Deterministic author + namespace from the recovery-phrase-derived AppKey.
    let author = Author::from_bytes(&author_seed);
    let author_id = author.id();
    docs.author_import(author)
        .await
        .map_err(|e| format!("author import: {e}"))?;
    let ns = NamespaceSecret::from_bytes(&ns_seed);
    let namespace_id = ns.id().to_string();
    // import_namespace attaches to the persisted replica if it already exists in
    // redb, or creates it fresh — either way the entries persisted last run are here.
    let doc = docs
        .import_namespace(Capability::Write(ns))
        .await
        .map_err(|e| format!("import namespace: {e}"))?;

    // Marker present → the doc persisted across a restart. Absent → first run, so
    // write it now (so the next run reopens).
    let existing = doc
        .get_exact(author_id, MARKER_KEY, false)
        .await
        .map_err(|e| format!("get marker: {e}"))?;
    let reopened = existing.is_some();
    if !reopened {
        doc.set_bytes(author_id, MARKER_KEY.to_vec(), b"curator doc online".to_vec())
            .await
            .map_err(|e| format!("set marker: {e}"))?;
    }

    Ok(DocEngine {
        docs,
        blobs,
        gossip,
        namespace_id,
        reopened,
    })
}
