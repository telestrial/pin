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
use tauri::{Emitter, Manager};

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
    /// A handle the identity loop reports through, so its result reaches the Curate
    /// page's diagnostics the same way the startup publish used to.
    fn report_handle(&self) -> impl Fn(String) + Send + Sync + 'static {
        let diag = self.0.lock().unwrap().diag.clone();
        move |note: String| {
            if let Some(d) = &diag {
                d.lock().unwrap().did_dht_published = Some(note);
            }
        }
    }

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
                last_error: None,
            },
        }
    }
}

/// The Sia identity handed over by the frontend (which already unlocked it). The
/// AppKey is the one root secret: it derives the docs namespace + author and the
/// did:dht identity keypair.
///
/// No indexer URL here on purpose. The Curator does no Sia I/O of its own — doc
/// durability on Sia is the encrypted snapshot in `lib/docsMirror.ts` (which reads
/// the doc through the same `docs.ts` seam that routes to this replica on desktop,
/// and publishes a pkarr locator so it's recoverable from the recovery phrase
/// alone), and cross-user reads go through per-channel locators. If the Curator
/// ever does need native Sia access, `sia.rs` already owns a connected `Sdk`.
pub struct SiaCreds {
    pub app_key_hex: String,
}

#[tauri::command]
pub fn start_curator(
    app: tauri::AppHandle,
    state: tauri::State<CuratorState>,
    app_key_hex: Option<String>,
) -> CuratorStatus {
    let mut inner = state.0.lock().unwrap();
    if inner.running.load(Ordering::SeqCst) {
        return CuratorState::snapshot(&inner);
    }
    // The frontend passes the already-unlocked Sia AppKey; it's the seed the docs
    // namespace and the did:dht identity derive from. Without it the node still
    // binds, it just has no repo (surfaced in diagnostics, not fatal).
    let creds = match app_key_hex {
        Some(app_key_hex) if !app_key_hex.is_empty() => Some(SiaCreds { app_key_hex }),
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
pub async fn docs_list_all(state: tauri::State<'_, CuratorState>) -> Result<Vec<String>, String> {
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

// --- Channel-doc CRUD over IPC (author half) ---------------------------------
//
// The desktop transport for the channel-doc surface pin-core exports to the browser.
// Same record keys, same opaque values, same read semantics — desktop and web sync the
// SAME channel docs, so these can't drift from pin-core (the logic lives in
// docstore.rs; these are thin wrappers). The subscriber half (importing a read ticket
// and surfacing live events) needs an event channel out to the frontend and lands next.

#[tauri::command]
pub async fn docs_open_channel(
    state: tauri::State<'_, CuratorState>,
    ns_seed_hex: String,
) -> Result<String, String> {
    current_engine(&state)?.open_channel(&ns_seed_hex).await
}

#[tauri::command]
pub async fn docs_share_channel(
    state: tauri::State<'_, CuratorState>,
    ns_id: String,
) -> Result<String, String> {
    current_engine(&state)?.share_channel(&ns_id).await
}

#[tauri::command]
pub async fn docs_put_channel_record(
    state: tauri::State<'_, CuratorState>,
    ns_id: String,
    collection: String,
    rkey: String,
    value: Vec<u8>,
) -> Result<(), String> {
    current_engine(&state)?
        .put_channel_record(&ns_id, &collection, &rkey, value)
        .await
}

#[tauri::command]
pub async fn docs_get_channel_record(
    state: tauri::State<'_, CuratorState>,
    ns_id: String,
    collection: String,
    rkey: String,
) -> Result<Option<Vec<u8>>, String> {
    current_engine(&state)?
        .get_channel_record(&ns_id, &collection, &rkey)
        .await
}

#[tauri::command]
pub async fn docs_delete_channel_record(
    state: tauri::State<'_, CuratorState>,
    ns_id: String,
    collection: String,
    rkey: String,
) -> Result<(), String> {
    current_engine(&state)?
        .delete_channel_record(&ns_id, &collection, &rkey)
        .await
}

/// The Tauri event a channel doc's `LiveEvent`s are forwarded on. The desktop
/// counterpart of the JS callback pin-core invokes in the browser — IPC can't take a
/// callback, so the frontend listens for this instead. Same three fields either way,
/// so one handler serves both transports.
pub const CHANNEL_DOC_EVENT: &str = "pin:channel-doc";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChannelDocEvent {
    ns_id: String,
    /// One of `pin_derive`'s `EV_*` kinds — the shared vocabulary, so the frontend's
    /// switch behaves identically whichever engine produced the event.
    kind: String,
    /// The entry key the event concerns, empty when it isn't about one entry.
    key: String,
}

/// Subscriber side: import a channel's read ticket into the Curator's engine and
/// live-sync it. `LiveEvent`s are forwarded to the frontend as `CHANNEL_DOC_EVENT`.
///
/// A channel doc's whole point is that the frontend reacts to a remote write, so the
/// events have to get out. Doing this by polling on desktop instead would leave web
/// on push and desktop on poll. (The identity doc has its own feed — see
/// `docs_subscribe_changes` — which is why `curator_start_sync` doesn't surface
/// events of its own: reconciling and reporting are separate jobs.)
#[tauri::command]
pub async fn docs_import_channel(
    app: tauri::AppHandle,
    state: tauri::State<'_, CuratorState>,
    ticket: String,
) -> Result<String, String> {
    let engine = current_engine(&state)?;
    engine
        .import_channel(&ticket, move |ns_id, kind, key| {
            // A failed emit (no window yet, window torn down) is not worth killing the
            // pump for — the next event tries again, and the frontend re-reads on its
            // own cadence regardless.
            let _ = app.emit(
                CHANNEL_DOC_EVENT,
                ChannelDocEvent {
                    ns_id: ns_id.to_string(),
                    kind: kind.to_string(),
                    key: key.to_string(),
                },
            );
        })
        .await
}

/// The Tauri event the Curator's own doc changes are reported on — the desktop
/// transport for pin-core's `subscribe_doc_changes` callback. Same three fields
/// either way, so one frontend handler serves both.
pub const DOC_CHANGE_EVENT: &str = "pin:doc-change";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DocChangeEvent {
    /// The record's collection, or empty for stream-level events.
    collection: String,
    /// The record's key within its collection, or empty for stream-level events.
    rkey: String,
    /// One of `pin_derive`'s `EV_*` kinds — the shared vocabulary.
    kind: String,
}

/// Start reporting changes to the Curator's own doc on `DOC_CHANGE_EVENT`.
///
/// This is what lets the frontend stop polling. The Curator writes to its doc on its
/// own schedule — syncing a peer device in, and increasingly its own background work —
/// and before this the only way for the UI to notice was a timer per interested
/// feature. Now the engine says what moved and the UI re-reads that.
///
/// Idempotent (the engine keeps one pump), so a remounting caller can just call it.
#[tauri::command]
pub async fn docs_subscribe_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, CuratorState>,
) -> Result<(), String> {
    current_engine(&state)?
        .subscribe_changes(move |collection, rkey, kind| {
            // A failed emit (window hidden to tray, torn down, not up yet) isn't worth
            // killing the pump for. It does mean changes during that window go
            // unannounced — which is why consumers still read once on mount: push for
            // speed, pull for truth.
            let _ = app.emit(
                DOC_CHANGE_EVENT,
                DocChangeEvent {
                    collection: collection.to_string(),
                    rkey: rkey.to_string(),
                    kind: kind.to_string(),
                },
            );
        })
        .await
}

/// How often a pull pass runs. Slow on purpose: a pass is network work per subscribed
/// channel, and the ladder's top rung (a live-synced channel doc) already delivers a
/// reachable author's writes by push. This is the floor under the authors who aren't.
const PULL_CADENCE: std::time::Duration = std::time::Duration::from_secs(90);

/// Start the Curator's subscription pull loop.
///
/// This is the half of the Curator that stopped working when the window closed, back
/// when the loop was a React effect. Here it outlives the webview: the desktop keeps
/// subscribed channels current while hidden to tray, which is what makes a phone or a
/// browser tab find the cache already warm.
///
/// Placed on the Sia runtime rather than Tauri's, because a pass downloads manifests
/// and the SDK's background work has to land somewhere with the IO drivers to serve it.
///
/// Idempotent (the engine keeps one loop), so a remounting caller can just call it.
#[tauri::command]
pub async fn curator_start_pull(
    curator: tauri::State<'_, CuratorState>,
    sia: tauri::State<'_, crate::sia::SiaState>,
    app_key_hex: String,
) -> Result<(), String> {
    let engine = current_engine(&curator)?;
    if engine.pull_started() {
        return Ok(());
    }
    let app_key = pin_derive::decode_app_key(&app_key_hex).ok_or("app key hex must be 32 bytes")?;
    let ctx = pin_curator::PullContext {
        doc: engine.doc.clone(),
        blobs: (*engine.blobs).clone(),
        author_id: engine.author_id,
        sia: sia.session(),
        app_key,
    };
    sia.detach(async move {
        pin_curator::run_pull_loop(ctx, PULL_CADENCE, |result| match result {
            Ok(o) => {
                if o.cached > 0 || o.dropped > 0 || o.failed > 0 {
                    println!(
                        "curator pull: cached {} unresolved {} failed {} dropped {}",
                        o.cached, o.unresolved, o.failed, o.dropped
                    );
                }
            }
            // Expected while the engine warms up (no settings record yet, Sia not
            // connected), so this is a note rather than an alarm.
            Err(e) => println!("curator pull: {e}"),
        })
        .await
    });
    Ok(())
}

/// How often a keep-alive pass runs.
///
/// Sized against the DHT, not against how often anything changes: a pkarr record ages
/// off Mainline in a couple of hours, so this has to come round several times inside
/// that window to survive a missed pass or two. A pass re-signs one small packet per
/// owned channel and touches no bytes, so being early costs nothing and being late
/// costs the channel its discoverability.
const KEEP_ALIVE_CADENCE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Start the Curator's locator keep-alive loop.
///
/// Needs no Sia session: republishing re-signs a pointer that already names its object.
/// Still placed on the Sia runtime, which is the long-lived one the Curator owns.
///
/// Idempotent (the engine keeps one loop), so a remounting caller can just call it.
#[tauri::command]
pub async fn curator_start_keep_alive(
    curator: tauri::State<'_, CuratorState>,
    sia: tauri::State<'_, crate::sia::SiaState>,
    app_key_hex: String,
) -> Result<(), String> {
    let engine = current_engine(&curator)?;
    if engine.keep_alive_started() {
        return Ok(());
    }
    let app_key = pin_derive::decode_app_key(&app_key_hex).ok_or("app key hex must be 32 bytes")?;
    let ctx = pin_curator::KeepAliveContext {
        doc: engine.doc.clone(),
        blobs: (*engine.blobs).clone(),
        author_id: engine.author_id,
        app_key,
    };
    sia.detach(async move {
        pin_curator::run_keep_alive_loop(ctx, KEEP_ALIVE_CADENCE, |result| match result {
            Ok(o) => {
                if o.refreshed > 0 || o.failed > 0 {
                    println!(
                        "curator keep-alive: refreshed {} unknown {} failed {}",
                        o.refreshed, o.unknown, o.failed
                    );
                }
            }
            // Expected while the engine warms up (no settings record yet).
            Err(e) => println!("curator keep-alive: {e}"),
        })
        .await
    });
    Ok(())
}

/// How often this instance re-registers its dial coordinates. Well under
/// `INSTANCE_TTL_SECS`, so a missed pass doesn't drop a running instance out of the
/// identity's published endpoints.
const INSTANCE_CADENCE: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Start this instance's registration loop — a heartbeat saying "this node id is a
/// live endpoint for this identity", so whoever publishes the identity's coordinates
/// publishes the whole set rather than only its own.
///
/// Marks itself `durable`: the desktop is the always-on one, which is the property a
/// peer choosing among endpoints cares about.
///
/// Idempotent (the engine keeps one loop), so a remounting caller can just call it.
#[tauri::command]
pub async fn curator_start_instance(
    curator: tauri::State<'_, CuratorState>,
    sia: tauri::State<'_, crate::sia::SiaState>,
) -> Result<(), String> {
    let engine = current_engine(&curator)?;
    if engine.instance_started() {
        return Ok(());
    }
    let ctx = pin_curator::InstanceContext {
        doc: engine.doc.clone(),
        blobs: (*engine.blobs).clone(),
        author_id: engine.author_id,
        node_id: engine.node_id.clone(),
        durable: true,
    };
    sia.detach(async move {
        pin_curator::run_instance_loop(ctx, INSTANCE_CADENCE, now_secs, |result| match result {
            Ok(o) => {
                if o.pruned > 0 {
                    println!("curator instance: {} live, {} pruned", o.live, o.pruned);
                }
            }
            Err(e) => println!("curator instance: {e}"),
        })
        .await
    });
    Ok(())
}

/// How often the identity's coordinates are republished. Same reasoning as the locator
/// keep-alive: a pkarr record ages off Mainline in a couple of hours, and an identity
/// nobody republishes stops resolving.
const IDENTITY_CADENCE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Start the identity-publishing loop — one packet under the did:dht key carrying the
/// directory pointer, the doc namespace, and every live endpoint.
///
/// The one writer of that record. It used to be two (this process at startup, a React
/// effect seconds later), each publishing a whole packet over the other.
///
/// Idempotent (the engine keeps one loop), so a remounting caller can just call it.
#[tauri::command]
pub async fn curator_start_identity(
    curator: tauri::State<'_, CuratorState>,
    sia: tauri::State<'_, crate::sia::SiaState>,
    app_key_hex: String,
) -> Result<(), String> {
    let engine = current_engine(&curator)?;
    if engine.identity_started() {
        return Ok(());
    }
    let app_key = pin_derive::decode_app_key(&app_key_hex).ok_or("app key hex must be 32 bytes")?;
    let ctx = pin_curator::IdentityContext {
        doc: engine.doc.clone(),
        blobs: (*engine.blobs).clone(),
        author_id: engine.author_id,
        sia: sia.session(),
        app_key,
        namespace_id: engine.namespace_id.clone(),
    };
    let report = curator.report_handle();
    sia.detach(async move {
        pin_curator::run_identity_loop(ctx, IDENTITY_CADENCE, now_iso, now_secs, move |result| {
            let note = match &result {
                Ok(o) if o.empty => "nothing to advertise yet".to_string(),
                Ok(o) => format!(
                    "ok (published{}, {} endpoint(s))",
                    if o.uploaded { " + uploaded" } else { "" },
                    o.endpoints
                ),
                Err(e) => format!("failed: {e}"),
            };
            println!("curator identity: {note}");
            report(note);
        })
        .await
    });
    Ok(())
}

/// Wall-clock seconds. Passed into the shared loop rather than read inside it, because
/// `SystemTime::now()` panics on the wasm target the same crate compiles for.
fn now_iso() -> String {
    // RFC 3339 with milliseconds, matching `new Date().toISOString()` — the directory's
    // `updatedAt` is read by clients that expect that shape.
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let (y, mo, da, h, mi, s) = civil_from_unix(secs);
    format!("{y:04}-{mo:02}-{da:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Days-from-civil, inverted (Howard Hinnant's algorithm). Cheaper than a date crate
/// for the one timestamp this process formats.
fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (
        y,
        m,
        d,
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    )
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The namespace ids of every channel doc the Curator currently holds. Empty when the
/// engine is down, rather than an error — callers treat it as "none open yet".
#[tauri::command]
pub fn docs_channel_namespaces(state: tauri::State<CuratorState>) -> Vec<String> {
    current_engine(&state)
        .map(|e| e.channel_namespaces())
        .unwrap_or_default()
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
    let inbox = crate::rpc::new_inbox();
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
    crate::rpc::clear(&inbox);
    // Held past here for the poll loop (inbox depth) and shutdown (router).
    let hey_inbox = Some(inbox);
    let router = Some(r);

    // The Curator's did:dht identity (ed25519, derived from the AppKey), for the
    // diagnostics panel.
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
        // Just the DID for diagnostics. PUBLISHING it is the identity loop's job now
        // (pin_curator::run_identity_loop): it goes out on a cadence rather than once
        // at startup, and it carries `_dir` and every live endpoint alongside `_ns` —
        // one packet from one writer, assembled from the doc.
        diag.lock().unwrap().did_dht = Some(crate::identity::did_dht(kp));
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
            .map(|i| crate::rpc::queued(i) as u64)
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
