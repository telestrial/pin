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
    /// The local repo's did:key (stable across restarts).
    pub repo_did: Option<String>,
    /// The local repo's signed root commit CID.
    pub repo_root: Option<String>,
    /// The repo engine error, if it failed to come up (iroh still runs).
    pub repo_error: Option<String>,
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
    repo_root: Option<String>,
    repo_error: Option<String>,
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
            repo_root: None,
            repo_error: None,
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
                    repo_root: d.repo_root.clone(),
                    repo_error: d.repo_error.clone(),
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
                repo_root: None,
                repo_error: None,
                last_error: None,
            },
        }
    }
}

#[tauri::command]
pub fn start_curator(app: tauri::AppHandle, state: tauri::State<CuratorState>) -> CuratorStatus {
    let mut inner = state.0.lock().unwrap();
    if inner.running.load(Ordering::SeqCst) {
        return CuratorState::snapshot(&inner);
    }
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
    inner.handle = Some(thread::spawn(move || run_curator(running, diag, data_dir)));

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
fn run_curator(running: Arc<AtomicBool>, diag: Arc<Mutex<Diag>>, data_dir: Option<PathBuf>) {
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
    rt.block_on(curator_loop(running, diag, data_dir));
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

async fn curator_loop(running: Arc<AtomicBool>, diag: Arc<Mutex<Diag>>, data_dir: Option<PathBuf>) {
    let node_key_path = data_dir.as_ref().map(|d| d.join("node_key"));
    let repo_key_path = data_dir.as_ref().map(|d| d.join("repo_key"));

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
    match crate::repo::init_repo(repo_key_path.as_deref()).await {
        Ok(info) => {
            log::info!("curator repo online: did={} root={}", info.did, info.root);
            let mut d = diag.lock().unwrap();
            d.repo_did = Some(info.did);
            d.repo_root = Some(info.root);
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
        {
            let mut d = diag.lock().unwrap();
            d.online = online;
            d.relays = relays;
            d.direct_addrs = direct;
            d.other_addrs = other;
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
    endpoint.close().await;
    log::info!("curator stopped");
    {
        let mut d = diag.lock().unwrap();
        *d = Diag::off();
    }
}
