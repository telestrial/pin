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

use iroh::endpoint::presets;
use iroh::{Endpoint, SecretKey};
use tauri::Manager;

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
    /// The local repo's did:key — derived from the recovery phrase, so stable
    /// across restarts and recoverable on any device.
    pub repo_did: Option<String>,
    /// The keeper's resolvable `did:dht` identity (ed25519, same phrase). The
    /// `repo_did` above is carried in this DID's document as a verification method.
    pub did_dht: Option<String>,
    /// Result of publishing the did:dht document to Mainline DHT + self-resolve
    /// ("ok …" or "failed: …"); None if not attempted (e.g. repo down).
    pub did_dht_published: Option<String>,
    /// The local repo's signed root commit CID.
    pub repo_root: Option<String>,
    /// Whether the repo was reopened from an on-disk CAR (true) or created fresh
    /// this run (false) — the visible proof that content survives a restart.
    pub repo_reopened: bool,
    /// The repo engine error, if it failed to come up (iroh still runs).
    pub repo_error: Option<String>,
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
    repo_did: Option<String>,
    did_dht: Option<String>,
    did_dht_published: Option<String>,
    repo_root: Option<String>,
    repo_reopened: bool,
    repo_error: Option<String>,
    rpc_serving: bool,
    rpc_selftest: Option<String>,
    hey_queued: u64,
    mirror_state: &'static str,
    mirror_root: Option<String>,
    mirror_url: Option<String>,
    mirror_error: Option<String>,
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
            repo_did: None,
            did_dht: None,
            did_dht_published: None,
            repo_root: None,
            repo_reopened: false,
            repo_error: None,
            rpc_serving: false,
            rpc_selftest: None,
            hey_queued: 0,
            mirror_state: "off",
            mirror_root: None,
            mirror_url: None,
            mirror_error: None,
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
                    repo_did: d.repo_did.clone(),
                    did_dht: d.did_dht.clone(),
                    did_dht_published: d.did_dht_published.clone(),
                    repo_root: d.repo_root.clone(),
                    repo_reopened: d.repo_reopened,
                    repo_error: d.repo_error.clone(),
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
                repo_did: None,
                did_dht: None,
                did_dht_published: None,
                repo_root: None,
                repo_reopened: false,
                repo_error: None,
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

/// The Sia identity the keeper mirrors under, handed over by the frontend (which
/// already unlocked it). Both are needed; absent one, the mirror is disabled.
pub struct SiaCreds {
    pub app_key_hex: String,
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
    // keeper can mirror under the user's own identity. Both or neither.
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
    {
        let mut d = diag.lock().unwrap();
        d.phase = "binding";
    }
    inner.running = running.clone();
    inner.diag = Some(diag.clone());
    inner.handle = Some(thread::spawn(move || run_curator(running, diag, data_dir, creds)));

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

/// Owns a dedicated tokio runtime for the Curator's lifetime and drives the
/// async endpoint loop on it.
fn run_curator(
    running: Arc<AtomicBool>,
    diag: Arc<Mutex<Diag>>,
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
    rt.block_on(curator_loop(running, diag, data_dir, creds));
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

/// One-shot Sia mirror reconcile on load, surfacing the outcome in diagnostics.
/// Best-effort: any failure is logged + shown but never stops the node. Needs
/// both the handed-over Sia creds and a data dir; without either, the mirror is
/// simply off (e.g. not signed into Sia).
async fn run_mirror(
    diag: &Arc<Mutex<Diag>>,
    repo: &crate::repo::SharedRepo,
    data_dir: Option<&Path>,
    creds: Option<&SiaCreds>,
) {
    let (Some(creds), Some(dir)) = (creds, data_dir) else {
        diag.lock().unwrap().mirror_state = "no-session";
        return;
    };
    let sdk = match crate::mirror::connect_sdk(&creds.indexer_url, &creds.app_key_hex).await {
        Ok(sdk) => sdk,
        Err(e) => {
            log::warn!("curator mirror: sia connect failed: {e}");
            let mut d = diag.lock().unwrap();
            d.mirror_state = "error";
            d.mirror_error = Some(e);
            return;
        }
    };
    let mirror_path = dir.join("mirror.json");
    match crate::mirror::mirror_if_stale(&sdk, repo, &mirror_path).await {
        Ok(crate::mirror::MirrorOutcome::UpToDate) => {
            log::info!("curator mirror: up to date");
            let mut d = diag.lock().unwrap();
            d.mirror_state = "up-to-date";
            d.mirror_root = d.repo_root.clone();
            d.mirror_error = None;
        }
        Ok(crate::mirror::MirrorOutcome::Pushed { url }) => {
            log::info!("curator mirror: pushed ({url})");
            let mut d = diag.lock().unwrap();
            d.mirror_state = "pushed";
            d.mirror_root = d.repo_root.clone();
            d.mirror_url = Some(url);
            d.mirror_error = None;
        }
        Err(e) => {
            log::warn!("curator mirror: push failed: {e}");
            let mut d = diag.lock().unwrap();
            d.mirror_state = "error";
            d.mirror_error = Some(e);
        }
    }
}

async fn curator_loop(
    running: Arc<AtomicBool>,
    diag: Arc<Mutex<Diag>>,
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

    // Bring up the local repo engine. Best-effort: if it fails, iroh keeps
    // running and the error surfaces in diagnostics rather than killing the node.
    // On success, serve the RPC over iroh and self-test it.
    let mut router = None;
    let mut hey_inbox: Option<crate::rpc::HeyInbox> = None;
    // The repo identity is derived from the Sia recovery phrase (via the AppKey the
    // frontend handed over), so pass it through to the repo engine.
    let app_key_hex = creds.as_ref().map(|c| c.app_key_hex.as_str());
    match crate::repo::init_repo(data_dir.as_deref(), app_key_hex).await {
        Ok(handle) => {
            log::info!(
                "curator repo online: did={} root={} ({})",
                handle.did,
                handle.root,
                if handle.reopened {
                    "reopened from disk"
                } else {
                    "created fresh"
                }
            );
            log::info!("curator did:dht identity: {}", handle.did_dht);
            let root = handle.root.clone();
            // Capture the repo's did:key before `handle.did` is moved into Head —
            // it's the verification method we publish in the did:dht document.
            let repo_did_str = handle.did.clone();
            {
                let mut d = diag.lock().unwrap();
                d.repo_did = Some(handle.did.clone());
                d.did_dht = Some(handle.did_dht.clone());
                d.repo_root = Some(handle.root.clone());
                d.repo_reopened = handle.reopened;
            }

            let head = crate::rpc::Head {
                did: handle.did,
                root: handle.root,
                sig: handle.commit_sig,
            };
            let inbox: crate::rpc::HeyInbox = Arc::new(Mutex::new(Vec::new()));
            // The mirror also needs the live repo, so the handler gets a clone.
            let handler = crate::rpc::RpcHandler::new(
                head,
                handle.repo.clone(),
                inbox.clone(),
                handle.car_path,
            );
            let r = iroh::protocol::Router::builder(endpoint.clone())
                .accept(crate::rpc::ALPN, handler)
                .spawn();
            diag.lock().unwrap().rpc_serving = true;
            log::info!("curator rpc serving (alpn pin-keeper/0)");

            // One-shot self-test: a throwaway client dials us and calls head +
            // record + hey + diff. The hey it sends is synthetic, so clear the
            // inbox afterward — real knocks should start the count from zero.
            match crate::rpc::self_test(endpoint.addr(), &root).await {
                Ok(msg) => {
                    log::info!("curator rpc self-test: {msg}");
                    diag.lock().unwrap().rpc_selftest = Some(msg);
                }
                Err(e) => {
                    log::warn!("curator rpc self-test failed: {e}");
                    diag.lock().unwrap().rpc_selftest = Some(format!("failed: {e}"));
                }
            }
            inbox.lock().unwrap().clear();
            hey_inbox = Some(inbox);
            router = Some(r);

            // Reconcile the Sia mirror (push-on-change, keyed on root CID). On a
            // static post-init repo this pushes once on first run, then no-ops.
            // Best-effort: a mirror failure surfaces in diagnostics but the node
            // keeps serving. Needs the handed-over Sia creds + a data dir.
            run_mirror(&diag, &handle.repo, data_dir.as_deref(), creds.as_ref()).await;

            // Publish the did:dht document to Mainline DHT so the identity is
            // resolvable, then self-resolve to verify. Compact doc: the iroh node
            // id (where to dial) + the repo's did:key (verification method). The
            // Sia mirror URL is omitted for now — long enough to strain a TXT
            // string / the BEP44 packet-size limit; conveying it is a later slice.
            // Best-effort: a failure leaves the node serving over iroh.
            let records = vec![
                ("_iroh".to_string(), endpoint.id().to_string()),
                ("_vm".to_string(), repo_did_str),
            ];
            match crate::identity::publish_doc(&handle.identity, &records).await {
                Ok(msg) => {
                    log::info!("curator did:dht doc: {msg}");
                    diag.lock().unwrap().did_dht_published = Some(msg);
                }
                Err(e) => {
                    log::warn!("curator did:dht doc publish failed: {e}");
                    diag.lock().unwrap().did_dht_published = Some(format!("failed: {e}"));
                }
            }
        }
        Err(e) => {
            log::error!("curator repo engine failed: {e}");
            diag.lock().unwrap().repo_error = Some(e);
        }
    }

    // Poll the endpoint's address set so relay connection + discovered direct
    // addresses (LAN, then public via STUN) surface as they come up.
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
