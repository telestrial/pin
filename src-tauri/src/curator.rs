// The Curator — Pin's optional always-on backend agent.
//
// Slice 2: the Curator now brings up an iroh endpoint when started — Pin's
// network identity and reachability layer. This is the transport the eventual
// serve / pull / reconcile loops dial and answer over. It still does no real
// work (no repo, no Sia, no RPC yet); the point of this slice is that "Enable
// curation" produces a real, reachable node with a stable id, and that we can
// read its status in detail. The base desktop app works with this off.
//
// The Curate view surfaces these diagnostics verbatim — it's dev-facing for now
// (eventually user-facing), so we expose as much as is cheap to read: node id,
// relay connection, discovered direct addresses, phase, uptime, last error.
//
// The Curator runs on its OWN owned multi-thread tokio runtime in a dedicated
// thread, rather than Tauri's runtime, so a tokio time driver is guaranteed and
// the agent's lifecycle is fully ours to start and stop.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use std::str::FromStr as _;

use futures_lite::StreamExt as _;
use iroh::endpoint::presets;
use iroh::{Endpoint, SecretKey};
use iroh_docs::api::protocol::{AddrInfoOptions, ShareMode};
use iroh_docs::store::Query;
use iroh_docs::DocTicket;
// Shared with pin-core (the browser engine): both write into the SAME synced doc, so
// the record-key spelling can't diverge — a divergence is a data bug, not untidiness.
use pin_derive::{collection_prefix, record_key};
use tauri::Manager;

use crate::docstore::DocEngine;

/// Shared handle to the running Curator's doc engine. Populated by the Curator loop
/// when the engine comes up and cleared on stop; the `docs_*` IPC commands read it to
/// serve the frontend's record CRUD against the SAME persistent replica the Curator
/// serves over iroh. `None` whenever curation is off / the engine hasn't come up.
type DocSlot = Arc<Mutex<Option<Arc<DocEngine>>>>;

/// What the frontend reads. snake_case fields are renamed to camelCase on the
/// wire for the TS client.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CuratorStatus {
    /// Whether the Curator agent is currently running.
    pub running: bool,
    /// Coarse lifecycle phase: off | binding | connecting | online | stopping | error.
    pub phase: String,
    /// The iroh EndpointId — this node's stable public-key identity (dial-by-key).
    pub node_id: Option<String>,
    /// Whether we're connected to a relay (reachable for holepunch/fallback).
    pub online: bool,
    /// Relay transport addresses (typically the single home relay).
    pub relays: Vec<String>,
    /// Direct IP transport addresses discovered (LAN + public via STUN).
    pub direct_addrs: Vec<String>,
    /// Any non-relay, non-IP transport addresses (custom transports).
    pub other_addrs: Vec<String>,
    /// Seconds since the endpoint bound, if running.
    pub uptime_secs: Option<u64>,
    /// The Curator's resolvable `did:dht` identity (ed25519, derived from the
    /// recovery phrase — stable across restarts, recoverable on any device).
    pub did_dht: Option<String>,
    /// Result of publishing the did:dht document to Mainline DHT + self-resolve
    /// ("ok …" or "failed: …"); None if not attempted (e.g. docs engine down).
    pub did_dht_published: Option<String>,
    /// The iroh-docs replica namespace ID (the local repo's identifier).
    pub docs_namespace: Option<String>,
    /// Whether the docs store was reopened from disk (true) or created fresh this
    /// run (false) — the visible proof that content survives a restart.
    pub docs_reopened: bool,
    /// Whether the RPC server (ALPN pin-keeper/0) is accepting connections.
    pub rpc_serving: bool,
    /// Result of the one-shot RPC self-test: "ok …" or an error string.
    pub rpc_selftest: Option<String>,
    /// Number of inbound `hey` knocks parked in the inbox awaiting reconcile.
    pub hey_queued: u64,
    /// Sia mirror lifecycle: off | up-to-date | pushed | error | no-session.
    pub mirror_state: String,
    /// The repo root currently mirrored to Sia.
    pub mirror_root: Option<String>,
    /// The mirror object's share URL (where a peer fallback-fetch would read).
    pub mirror_url: Option<String>,
    /// The mirror error, if the push failed (the node keeps running).
    pub mirror_error: Option<String>,
    /// The last bind/runtime error, if the Curator failed.
    pub last_error: Option<String>,
}

/// Live diagnostics the Curator task writes and `curator_status` reads. `started`
/// is kept here (not serialized) so uptime is computed at read time.
struct Diag {
    phase: &'static str,
    node_id: Option<String>,
    online: bool,
    relays: Vec<String>,
    direct_addrs: Vec<String>,
    other_addrs: Vec<String>,
    did_dht: Option<String>,
    did_dht_published: Option<String>,
    docs_namespace: Option<String>,
    docs_reopened: bool,
    rpc_serving: bool,
    rpc_selftest: Option<String>,
    hey_queued: u64,
    mirror_state: &'static str,
    mirror_root: Option<String>,
    mirror_url: Option<String>,
    mirror_error: Option<String>,
    /// The Curator's shareable DocTicket — a browser peer imports it to sync the
    /// Curator's iroh-docs replica. Read out-of-band via `curator_doc_ticket` (kept
    /// off the status payload since it's large and only fetched on demand).
    doc_ticket: Option<String>,
    last_error: Option<String>,
    started: Option<Instant>,
}

impl Diag {
    fn off() -> Self {
        Diag {
            phase: "off",
            node_id: None,
            online: false,
            relays: Vec::new(),
            direct_addrs: Vec::new(),
            other_addrs: Vec::new(),
            did_dht: None,
            did_dht_published: None,
            docs_namespace: None,
            docs_reopened: false,
            rpc_serving: false,
            rpc_selftest: None,
            hey_queued: 0,
            mirror_state: "off",
            mirror_root: None,
            mirror_url: None,
            mirror_error: None,
            doc_ticket: None,
            last_error: None,
            started: None,
        }
    }
}

#[derive(Default)]
struct Inner {
    running: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    diag: Option<Arc<Mutex<Diag>>>,
    /// Live handle to the running engine's doc, for the `docs_*` commands. A fresh
    /// slot is minted per start (like `diag`), so a stopped loop clearing its old
    /// slot can't clear the current one.
    doc_slot: DocSlot,
}

/// Tauri-managed state holding the running Curator, if any.
#[derive(Default)]
pub struct CuratorState(Mutex<Inner>);

impl CuratorState {
    fn snapshot(inner: &Inner) -> CuratorStatus {
        let running = inner.running.load(Ordering::SeqCst);
        match &inner.diag {
            Some(diag) => {
                let d = diag.lock().unwrap();
                CuratorStatus {
                    running,
                    phase: d.phase.to_string(),
                    node_id: d.node_id.clone(),
                    online: d.online,
                    relays: d.relays.clone(),
                    direct_addrs: d.direct_addrs.clone(),
                    other_addrs: d.other_addrs.clone(),
                    uptime_secs: d.started.map(|t| t.elapsed().as_secs()),
                    did_dht: d.did_dht.clone(),
                    did_dht_published: d.did_dht_published.clone(),
                    docs_namespace: d.docs_namespace.clone(),
                    docs_reopened: d.docs_reopened,
                    rpc_serving: d.rpc_serving,
                    rpc_selftest: d.rpc_selftest.clone(),
                    hey_queued: d.hey_queued,
                    mirror_state: d.mirror_state.to_string(),
                    mirror_root: d.mirror_root.clone(),
                    mirror_url: d.mirror_url.clone(),
                    mirror_error: d.mirror_error.clone(),
                    last_error: d.last_error.clone(),
                }
            }
            None => CuratorStatus {
                running,
                phase: "off".to_string(),
                node_id: None,
                online: false,
                relays: Vec::new(),
                direct_addrs: Vec::new(),
                other_addrs: Vec::new(),
                uptime_secs: None,
                did_dht: None,
                did_dht_published: None,
                docs_namespace: None,
                docs_reopened: false,
                rpc_serving: false,
                rpc_selftest: None,
                hey_queued: 0,
                mirror_state: "off".to_string(),
                mirror_root: None,
                mirror_url: None,
                mirror_error: None,
                last_error: None,
            },
        }
    }
}

/// The Sia identity handed over by the frontend (which already unlocked it). The
/// AppKey derives the docs namespace + the did:dht identity.
pub struct SiaCreds {
    pub app_key_hex: String,
    // Was used by the Sia mirror, removed at the iroh-docs cutover pending a rebuild
    // against the doc format; kept plumbed so it returns without frontend churn.
    #[allow(dead_code)]
    pub indexer_url: String,
}

#[tauri::command]
pub fn start_curator(
    app: tauri::AppHandle,
    state: tauri::State<CuratorState>,
    app_key_hex: Option<String>,
    indexer_url: Option<String>,
) -> CuratorStatus {
    let mut inner = state.0.lock().unwrap();
    if inner.running.load(Ordering::SeqCst) {
        return CuratorState::snapshot(&inner);
    }
    // The frontend passes the already-unlocked Sia AppKey + indexer URL so the
    // Curator can mirror under the user's own identity. Both or neither.
    let creds = match (app_key_hex, indexer_url) {
        (Some(app_key_hex), Some(indexer_url)) if !app_key_hex.is_empty() => Some(SiaCreds {
            app_key_hex,
            indexer_url,
        }),
        _ => None,
    };
    // Reap any previously-stopped thread before starting fresh.
    if let Some(handle) = inner.handle.take() {
        let _ = handle.join();
    }

    // The Curator's local data dir — local (not roaming) app data, so the
    // per-machine secrets (iroh node key, repo signing key) live here and are
    // never synced to a second device. Kept in one dir for the future encrypted
    // local vault.
    let data_dir = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join("curator"));

    let running = Arc::new(AtomicBool::new(true));
    let diag = Arc::new(Mutex::new(Diag::off()));
    let doc_slot: DocSlot = Arc::new(Mutex::new(None));
    {
        let mut d = diag.lock().unwrap();
        d.phase = "binding";
    }
    inner.running = running.clone();
    inner.diag = Some(diag.clone());
    inner.doc_slot = doc_slot.clone();
    inner.handle = Some(thread::spawn(move || {
        run_curator(running, diag, doc_slot, data_dir, creds)
    }));

    CuratorState::snapshot(&inner)
}

#[tauri::command]
pub fn stop_curator(state: tauri::State<CuratorState>) -> CuratorStatus {
    let mut inner = state.0.lock().unwrap();
    inner.running.store(false, Ordering::SeqCst);
    if let Some(handle) = inner.handle.take() {
        let _ = handle.join();
    }
    CuratorState::snapshot(&inner)
}

#[tauri::command]
pub fn curator_status(state: tauri::State<CuratorState>) -> CuratorStatus {
    CuratorState::snapshot(&state.0.lock().unwrap())
}

/// The Curator's shareable DocTicket, or `None` until the doc engine is up and has
/// produced one. A browser peer imports this to sync the Curator's iroh-docs replica.
#[tauri::command]
pub fn curator_doc_ticket(state: tauri::State<CuratorState>) -> Option<String> {
    let inner = state.0.lock().unwrap();
    inner
        .diag
        .as_ref()
        .and_then(|d| d.lock().unwrap().doc_ticket.clone())
}

// --- Record CRUD over IPC (the desktop transport for src/lib/docs.ts) --------
//
// These serve the frontend's doc-engine surface against the Curator's OWN persistent
// replica — the same one it serves over iroh — instead of the ephemeral in-webview
// wasm replica. Record identity + value semantics MUST match pin-core (src/lib.rs):
// key = `collection/rkey` bytes, value = opaque bytes (the app's encrypted blob),
// scoped to the doc's derived author. Every command errors cleanly ("Curator is not
// running") when the engine is down, so callers degrade rather than hang.
//
// Slice A: these exist and are proven by a dev self-test; docs.ts doesn't route here
// yet. Byte values ride as plain JSON arrays — fine at record scale (settings /
// channel manifests are KB, media bytes live on Sia) — not the raw-body path sia.rs
// needs for multi-MB uploads.

/// Clone out the running engine handle without holding the state lock across an await.
/// `Err` when curation is off / the engine hasn't come up.
fn current_engine(state: &CuratorState) -> Result<Arc<DocEngine>, String> {
    let slot = state.0.lock().unwrap().doc_slot.clone();
    let engine = slot.lock().unwrap().clone();
    engine.ok_or_else(|| "Curator is not running".to_string())
}

/// The running engine's namespace id (the doc's public identifier), or `None` if the
/// engine isn't up — the desktop equivalent of pin-core's `open` return value.
#[tauri::command]
pub fn docs_namespace(state: tauri::State<CuratorState>) -> Option<String> {
    current_engine(&state).ok().map(|e| e.namespace_id.clone())
}

#[tauri::command]
pub async fn docs_put_record(
    state: tauri::State<'_, CuratorState>,
    collection: String,
    rkey: String,
    value: Vec<u8>,
) -> Result<(), String> {
    let engine = current_engine(&state)?;
    engine
        .doc
        .set_bytes(engine.author_id, record_key(&collection, &rkey), value)
        .await
        .map_err(|e| format!("set_bytes: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn docs_get_record(
    state: tauri::State<'_, CuratorState>,
    collection: String,
    rkey: String,
) -> Result<Option<Vec<u8>>, String> {
    let engine = current_engine(&state)?;
    let entry = engine
        .doc
        .get_exact(engine.author_id, record_key(&collection, &rkey), false)
        .await
        .map_err(|e| format!("get_exact: {e}"))?;
    match entry {
        None => Ok(None),
        Some(e) => {
            let bytes = engine
                .blobs
                .get_bytes(e.content_hash())
                .await
                .map_err(|e| format!("get_bytes: {e}"))?;
            Ok(Some(bytes.to_vec()))
        }
    }
}

#[tauri::command]
pub async fn docs_delete_record(
    state: tauri::State<'_, CuratorState>,
    collection: String,
    rkey: String,
) -> Result<(), String> {
    let engine = current_engine(&state)?;
    engine
        .doc
        .del(engine.author_id, record_key(&collection, &rkey))
        .await
        .map_err(|e| format!("del: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn docs_list_records(
    state: tauri::State<'_, CuratorState>,
    collection: String,
) -> Result<Vec<String>, String> {
    let engine = current_engine(&state)?;
    let prefix = collection_prefix(&collection);
    let mut stream = Box::pin(
        engine
            .doc
            .get_many(Query::all().build())
            .await
            .map_err(|e| format!("get_many: {e}"))?,
    );
    let mut out = Vec::new();
    while let Some(res) = stream.next().await {
        let entry = res.map_err(|e| format!("entry: {e}"))?;
        let key = String::from_utf8_lossy(entry.key());
        if let Some(rkey) = key.strip_prefix(&prefix) {
            out.push(rkey.to_string());
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn docs_list_all(
    state: tauri::State<'_, CuratorState>,
) -> Result<Vec<String>, String> {
    let engine = current_engine(&state)?;
    let mut stream = Box::pin(
        engine
            .doc
            .get_many(Query::all().build())
            .await
            .map_err(|e| format!("get_many: {e}"))?,
    );
    let mut out = Vec::new();
    while let Some(res) = stream.next().await {
        let entry = res.map_err(|e| format!("entry: {e}"))?;
        out.push(String::from_utf8_lossy(entry.key()).to_string());
    }
    Ok(out)
}

/// Actively sync the Curator's replica with the peer(s) in `ticket` — the desktop
/// equivalent of pin-core's `start_sync` (which the in-webview wasm engine can't run
/// on desktop). The ticket only supplies WHERE to dial; the namespace is already ours
/// (same identity → same namespace). One import reconciles BOTH directions, so this is
/// what lets a desktop actively pull from a peer (its own other device, a web tab)
/// rather than only being synced-from — the piece that makes desktop and web fully
/// symmetric. Sync runs in the Curator's engine; LiveEvents aren't surfaced over IPC
/// (reconciliation doesn't need a subscriber), so the frontend's onEvent stays quiet
/// on desktop.
#[tauri::command]
pub async fn curator_start_sync(
    state: tauri::State<'_, CuratorState>,
    ticket: String,
) -> Result<(), String> {
    let engine = current_engine(&state)?;
    let ticket = DocTicket::from_str(&ticket).map_err(|e| format!("bad ticket: {e}"))?;
    engine
        .doc
        .start_sync(ticket.nodes)
        .await
        .map_err(|e| format!("start_sync: {e}"))?;
    Ok(())
}

/// Owns a dedicated tokio runtime for the Curator's lifetime and drives the
/// async endpoint loop on it.
fn run_curator(
    running: Arc<AtomicBool>,
    diag: Arc<Mutex<Diag>>,
    doc_slot: DocSlot,
    data_dir: Option<PathBuf>,
    creds: Option<SiaCreds>,
) {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            let mut d = diag.lock().unwrap();
            d.phase = "error";
            d.last_error = Some(format!("tokio runtime: {e}"));
            return;
        }
    };
    rt.block_on(curator_loop(running, diag, doc_slot, data_dir, creds));
}

/// Load the persisted iroh secret key, or generate one and persist it. The key
/// IS the node's network identity (its EndpointId / dial-by-key address), so it
/// must be stable across restarts. Returns the key and whether it's durable
/// (false = we couldn't read or write the file and are running ephemerally).
fn load_or_create_key(path: Option<&Path>) -> (SecretKey, bool) {
    let Some(path) = path else {
        return (SecretKey::generate(), false);
    };
    if let Ok(bytes) = fs::read(path) {
        if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return (SecretKey::from_bytes(&arr), true);
        }
        log::warn!("curator key file malformed; regenerating");
    }
    let key = SecretKey::generate();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let persisted = fs::write(path, key.to_bytes()).is_ok();
    if !persisted {
        log::warn!("curator could not persist key at {}", path.display());
    }
    (key, persisted)
}

async fn curator_loop(
    running: Arc<AtomicBool>,
    diag: Arc<Mutex<Diag>>,
    doc_slot: DocSlot,
    data_dir: Option<PathBuf>,
    creds: Option<SiaCreds>,
) {
    let node_key_path = data_dir.as_ref().map(|d| d.join("node_key"));

    let (secret, persisted) = load_or_create_key(node_key_path.as_deref());
    log::info!(
        "curator binding iroh endpoint (identity: {})",
        if persisted { "persisted" } else { "ephemeral" }
    );
    let endpoint = match Endpoint::builder(presets::N0)
        .secret_key(secret)
        .bind()
        .await
    {
        Ok(ep) => ep,
        Err(e) => {
            log::error!("curator endpoint bind failed: {e}");
            let mut d = diag.lock().unwrap();
            d.phase = "error";
            d.last_error = Some(format!("{e}"));
            return;
        }
    };

    let node_id = endpoint.id().to_string();
    log::info!("curator online as {node_id}");
    {
        let mut d = diag.lock().unwrap();
        d.node_id = Some(node_id);
        d.phase = "connecting";
        d.started = Some(Instant::now());
    }

    // The persistent iroh-docs engine on the Curator's endpoint (step 3a: alongside
    // atrium, mounted on the same Router below). It doesn't depend on the atrium
    // repo, so it comes up here; held for the loop's lifetime so its redb + fs blobs
    // stores (FsStore owns its own runtime) stay open as long as the Router serves
    // them. "reopened from disk" is the persistence proof — the marker written on
    // first run survives restarts. Best-effort; needs the AppKey (the doc's identity
    // derives from it) and a data dir.
    let doc_engine: Option<Arc<DocEngine>> = match (creds.as_ref(), data_dir.as_deref()) {
        (Some(c), Some(dir)) => {
            match crate::docstore::open_or_create(&endpoint, dir, &c.app_key_hex).await {
                Ok(engine) => {
                    log::info!(
                        "curator docs engine online: ns={} ({})",
                        engine.namespace_id,
                        if engine.reopened {
                            "reopened from disk"
                        } else {
                            "created fresh"
                        }
                    );
                    Some(Arc::new(engine))
                }
                Err(e) => {
                    log::warn!("curator docs engine failed: {e}");
                    None
                }
            }
        }
        _ => {
            log::info!("curator docs engine: skipped (no Sia session / data dir)");
            None
        }
    };
    // Feed the repo diagnostics from the docs engine, and publish the engine handle
    // so the `docs_*` IPC commands serve the frontend against this same replica.
    if let Some(engine) = doc_engine.as_ref() {
        let mut d = diag.lock().unwrap();
        d.docs_namespace = Some(engine.namespace_id.clone());
        d.docs_reopened = engine.reopened;
    }
    *doc_slot.lock().unwrap() = doc_engine.clone();

    // Serve the /hey inbox over iroh, plus the iroh-docs / blobs / gossip protocols
    // when the docs engine is up — one ALPN-multiplexed Router. The atrium repo and
    // its head/record/diff verbs are gone; iroh-docs' own sync subsumes them.
    let inbox: crate::rpc::HeyInbox = Arc::new(Mutex::new(Vec::new()));
    let mut rb = iroh::protocol::Router::builder(endpoint.clone())
        .accept(crate::rpc::ALPN, crate::rpc::HeyHandler::new(inbox.clone()));
    if let Some(engine) = doc_engine.as_ref() {
        rb = rb
            .accept(
                iroh_blobs::ALPN,
                iroh_blobs::BlobsProtocol::new(&engine.blobs, None),
            )
            .accept(iroh_gossip::ALPN, engine.gossip.clone())
            .accept(iroh_docs::ALPN, engine.docs.clone());
    }
    let r = rb.spawn();
    diag.lock().unwrap().rpc_serving = true;
    log::info!("curator serving (alpn pin-keeper/0: /hey; iroh-docs when up)");

    // One-shot self-test: a throwaway client dials us and sends a /hey knock. The
    // knock is synthetic, so clear the inbox afterward — real knocks start from zero.
    match crate::rpc::self_test(endpoint.addr()).await {
        Ok(msg) => {
            log::info!("curator hey self-test: {msg}");
            diag.lock().unwrap().rpc_selftest = Some(msg);
        }
        Err(e) => {
            log::warn!("curator hey self-test failed: {e}");
            diag.lock().unwrap().rpc_selftest = Some(format!("failed: {e}"));
        }
    }
    inbox.lock().unwrap().clear();
    // Held past here for the poll loop (inbox depth) and shutdown (router).
    let hey_inbox = Some(inbox);
    let router = Some(r);

    // The Curator's did:dht identity (ed25519, derived from the AppKey) — was carried
    // on the atrium repo handle; now derived directly, since identity is independent
    // of the repo engine. Publish the DID document to Mainline DHT (just `_iroh`, the
    // node to dial — binding the doc namespace via `_ns` is the next slice) and
    // self-resolve to verify. Best-effort: a failure leaves the node serving.
    let identity = creds
        .as_ref()
        .and_then(|c| pin_derive::decode_app_key(&c.app_key_hex))
        .and_then(|k| match crate::identity::derive_identity(&k) {
            Ok(kp) => Some(kp),
            Err(e) => {
                log::warn!("curator identity derive failed: {e}");
                None
            }
        });
    if let Some(kp) = &identity {
        let did_dht = crate::identity::did_dht(kp);
        diag.lock().unwrap().did_dht = Some(did_dht.clone());
        let node_id_str = endpoint.id().to_string();
        // The doc's namespace id — what a peer resolving this DID needs to import +
        // sync the Curator's iroh-docs replica (alongside `_iroh`, where to dial).
        let namespace = doc_engine.as_ref().map(|e| e.namespace_id.clone());
        let mut records = vec![("_iroh".to_string(), node_id_str.clone())];
        if let Some(ns) = &namespace {
            records.push(("_ns".to_string(), ns.clone()));
        }
        match crate::identity::publish_doc(kp, &records).await {
            Ok(msg) => {
                log::info!("curator did:dht doc: {msg}");
                let note = match crate::identity::resolve_did(&did_dht).await {
                    Ok(r) => {
                        let node_ok = r.iroh_node.as_deref() == Some(node_id_str.as_str());
                        let ns_ok = r.namespace == namespace;
                        log::info!(
                            "curator did:dht resolver: iroh={:?} ns={:?} (node matches: {node_ok}, ns matches: {ns_ok})",
                            r.iroh_node,
                            r.namespace
                        );
                        format!(
                            "; resolved back (iroh {}, ns {})",
                            if r.iroh_node.is_some() { "ok" } else { "—" },
                            if r.namespace.is_some() { "ok" } else { "—" }
                        )
                    }
                    Err(e) => {
                        log::warn!("curator did:dht resolver failed: {e}");
                        format!("; resolve failed: {e}")
                    }
                };
                diag.lock().unwrap().did_dht_published = Some(format!("{msg}{note}"));
            }
            Err(e) => {
                log::warn!("curator did:dht doc publish failed: {e}");
                diag.lock().unwrap().did_dht_published = Some(format!("failed: {e}"));
            }
        }
    }

    // Poll the endpoint's address set so relay connection + discovered direct
    // addresses (LAN, then public via STUN) surface as they come up.
    let mut ticket_logged = false;
    while running.load(Ordering::SeqCst) {
        let addr = endpoint.addr();
        let mut relays = Vec::new();
        let mut direct = Vec::new();
        let mut other = Vec::new();
        for a in &addr.addrs {
            let s = format!("{a:?}");
            if a.is_relay() {
                relays.push(s);
            } else if a.is_ip() {
                direct.push(s);
            } else {
                other.push(s);
            }
        }
        let online = !relays.is_empty();
        let hey_queued = hey_inbox
            .as_ref()
            .map(|i| i.lock().unwrap().len() as u64)
            .unwrap_or(0);
        {
            let mut d = diag.lock().unwrap();
            d.online = online;
            d.relays = relays;
            d.direct_addrs = direct;
            d.other_addrs = other;
            d.hey_queued = hey_queued;
            d.phase = if online { "online" } else { "connecting" };
        }

        // Refresh the shareable DocTicket so a browser peer can import + sync the
        // Curator's replica. Recomputed each poll so late-discovered direct addrs land
        // in it; `share` is a pure read of the capability + current addrs (the Router
        // is what actually serves the doc), so recomputing is cheap and side-effect
        // free. A browser reaches us relay-first regardless.
        if let Some(engine) = doc_engine.as_ref() {
            match engine
                .doc
                .share(ShareMode::Write, AddrInfoOptions::RelayAndAddresses)
                .await
            {
                Ok(ticket) => {
                    let ticket = ticket.to_string();
                    if !ticket_logged {
                        log::info!("curator doc ticket ready ({} chars)", ticket.len());
                        ticket_logged = true;
                    }
                    diag.lock().unwrap().doc_ticket = Some(ticket);
                }
                Err(e) => log::warn!("curator doc share failed: {e}"),
            }
        }

        // ~2s between polls, in short slices so stop is honored promptly.
        for _ in 0..8 {
            if !running.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    {
        let mut d = diag.lock().unwrap();
        d.phase = "stopping";
    }
    // Doc goes unavailable to the `docs_*` commands the moment teardown begins.
    *doc_slot.lock().unwrap() = None;
    if let Some(r) = router {
        r.shutdown().await.ok();
    }
    endpoint.close().await;
    log::info!("curator stopped");
    {
        let mut d = diag.lock().unwrap();
        *d = Diag::off();
    }
}
