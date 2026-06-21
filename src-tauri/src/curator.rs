// The Curator — Pin's optional always-on backend agent.
//
// Slice 1 is the lifecycle seam only: a long-lived native task the frontend can
// start, stop, and observe over IPC, behind a Settings/sidebar toggle. It does
// nothing useful yet (a heartbeat) — the point is to prove the on/off boundary,
// the persistent-process lifecycle, and the status contract before any of the
// real capability (iroh endpoint, repo engine, the serve/pull/reconcile loops)
// lands on top. The base desktop app works with this off; turning it on is what
// "runs more of itself."
//
// Deliberately zero heavy crates here: a std thread + an atomic flag, no async
// runtime, no iroh/repo/Sia yet. Those arrive in later slices inside this task.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// What the frontend reads. A struct (not a bare bool) so later slices can add
/// fields — node id, peer count, last-crawl time — without changing the shape.
#[derive(serde::Serialize, Clone)]
pub struct CuratorStatus {
    pub running: bool,
}

#[derive(Default)]
struct Inner {
    /// The flag the heartbeat thread watches; flipping it to false stops it.
    running: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

/// Tauri-managed state holding the running Curator task, if any.
#[derive(Default)]
pub struct CuratorState(Mutex<Inner>);

impl CuratorState {
    fn status(inner: &Inner) -> CuratorStatus {
        CuratorStatus {
            running: inner.running.load(Ordering::SeqCst),
        }
    }
}

#[tauri::command]
pub fn start_curator(state: tauri::State<CuratorState>) -> CuratorStatus {
    let mut inner = state.0.lock().unwrap();
    if inner.running.load(Ordering::SeqCst) {
        return CuratorState::status(&inner);
    }

    let running = Arc::new(AtomicBool::new(true));
    inner.running = running.clone();
    inner.handle = Some(thread::spawn(move || {
        log::info!("curator started");
        let mut ticks: u64 = 0;
        while running.load(Ordering::SeqCst) {
            ticks += 1;
            log::info!("curator heartbeat #{ticks}");
            // Sleep in short slices so a stop request is honored promptly
            // rather than after a full heartbeat interval.
            for _ in 0..50 {
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
        log::info!("curator stopped");
    }));

    CuratorState::status(&inner)
}

#[tauri::command]
pub fn stop_curator(state: tauri::State<CuratorState>) -> CuratorStatus {
    let mut inner = state.0.lock().unwrap();
    inner.running.store(false, Ordering::SeqCst);
    if let Some(handle) = inner.handle.take() {
        let _ = handle.join();
    }
    CuratorState::status(&inner)
}

#[tauri::command]
pub fn curator_status(state: tauri::State<CuratorState>) -> CuratorStatus {
    CuratorState::status(&state.0.lock().unwrap())
}
