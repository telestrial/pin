// The desktop's Sia commands — thin Tauri wrappers over `pin_sia`, the same crate
// the browser reaches through wasm. What differs between the two is the hop, not the
// behaviour: the walk, the descriptors and the connect flow have one definition.
//
// WHY THE DESKTOP HAS ITS OWN HOP AT ALL: the browser SDK's download path fails in
// WebView2 ("readable byte streams not supported"). Running Sia in this process
// instead — native QUIC, no browser byte-stream dependency — is the fix, and it also
// means Sia keeps working when the window is closed to the tray.
//
// EXECUTION MODEL: a dedicated multi-thread tokio runtime with the full driver set
// (`enable_all`), so the net/IO driver Sia's QUIC needs is guaranteed regardless of
// what Tauri's own runtime enables. Async commands run off the main thread on Tauri's
// runtime and dispatch the Sia futures onto ours via `rt.spawn(..).await` — the future
// is polled by a runtime known to have the driver, and awaiting the JoinHandle is a
// plain future poll.
//
// BYTES OVER IPC: raw both ways, no base64. Downloads return raw bytes via
// `tauri::ipc::Response` (an ArrayBuffer in JS). Uploads receive the raw request body
// via `tauri::ipc::Request` — Tauri v2 async commands do accept a borrowed `Request`,
// so the bytes are read off it before the first await. A `Vec<u8>` typed arg from a
// raw body is broken upstream (tauri #9948: raw→typed runs serde_json::from_slice),
// which is why it is a `Request` rather than an argument. Packed uploads carry N
// buffers in one raw body via a little-endian [u32 count][u32 len][bytes]... frame,
// because a raw body is a single blob (see `unframe`).

use std::sync::Arc;

use pin_sia::{AccountSnapshot, PinnedObjectInfo, Session, Uploaded};

/// Split a framed raw payload — [u32 count][u32 len][bytes]... little-endian — back
/// into the individual buffers.
fn unframe(data: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let read_u32 = |o: usize| -> Result<u32, String> {
        data.get(o..o + 4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
            .ok_or_else(|| "framed payload truncated".to_string())
    };
    let mut off = 0usize;
    let count = read_u32(off)? as usize;
    off += 4;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let len = read_u32(off)? as usize;
        off += 4;
        let chunk = data
            .get(off..off + len)
            .ok_or_else(|| "framed payload truncated".to_string())?
            .to_vec();
        off += len;
        out.push(chunk);
    }
    Ok(out)
}

fn raw_body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(v) => Ok(v.clone()),
        _ => Err("this command requires a raw byte body".to_string()),
    }
}

/// Tauri-managed state: the dedicated Sia runtime plus the session it drives.
pub struct SiaState {
    rt: tokio::runtime::Runtime,
    session: Arc<Session>,
}

impl Default for SiaState {
    fn default() -> Self {
        SiaState {
            rt: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("sia tokio runtime"),
            session: Arc::new(Session::new()),
        }
    }
}

impl SiaState {
    /// Run a Sia call on the dedicated runtime.
    ///
    /// Takes a closure rather than a future so the session `Arc` is cloned on this
    /// side and moved in, keeping every command below to a single line of plumbing.
    pub(crate) async fn run<T, F, Fut>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(Arc<Session>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<T, String>> + Send,
        T: Send + 'static,
    {
        let session = self.session.clone();
        self.rt
            .spawn(async move { f(session).await })
            .await
            .map_err(|e| format!("task: {e}"))?
    }
}

// --- commands ------------------------------------------------------------------

/// Connect from the AppKey the frontend already unlocked. Overwrites any previous
/// connection, so re-onboarding lands cleanly.
#[tauri::command]
pub async fn sia_connect(
    state: tauri::State<'_, SiaState>,
    app_key_hex: String,
    indexer_url: String,
) -> Result<(), String> {
    let recognized = state
        .run(move |s| async move { s.connect(&app_key_hex, &indexer_url).await })
        .await?;
    if !recognized {
        return Err("indexer did not recognize this app key".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn sia_upload_item(
    state: tauri::State<'_, SiaState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Uploaded, String> {
    let bytes = raw_body(&request)?;
    state
        .run(move |s| async move { s.upload_item(bytes, None).await })
        .await
}

#[tauri::command]
pub async fn sia_upload_items_packed(
    state: tauri::State<'_, SiaState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<Uploaded>, String> {
    let buffers = unframe(&raw_body(&request)?)?;
    state
        .run(move |s| async move { s.upload_items_packed(buffers, None).await })
        .await
}

/// Returns raw bytes as an ArrayBuffer — the subscriber read path WebView2's browser
/// SDK rejects, done natively.
#[tauri::command]
pub async fn sia_download_item(
    state: tauri::State<'_, SiaState>,
    url: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = state
        .run(move |s| async move { s.download_item(&url).await })
        .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn sia_pin_from_share_url(
    state: tauri::State<'_, SiaState>,
    url: String,
) -> Result<String, String> {
    state
        .run(move |s| async move { s.pin_from_share_url(&url).await })
        .await
}

#[tauri::command]
pub async fn sia_resolve_object_id(
    state: tauri::State<'_, SiaState>,
    url: String,
) -> Result<String, String> {
    state
        .run(move |s| async move { s.resolve_object_id(&url).await })
        .await
}

#[tauri::command]
pub async fn sia_delete_object(
    state: tauri::State<'_, SiaState>,
    id: String,
) -> Result<(), String> {
    state
        .run(move |s| async move { s.delete_object(&id).await })
        .await
}

#[tauri::command]
pub async fn sia_prune_slabs(state: tauri::State<'_, SiaState>) -> Result<(), String> {
    state
        .run(move |s| async move { s.prune_slabs().await })
        .await
}

#[tauri::command]
pub async fn sia_account_snapshot(
    state: tauri::State<'_, SiaState>,
) -> Result<AccountSnapshot, String> {
    state
        .run(move |s| async move { s.account_snapshot().await })
        .await
}

#[tauri::command]
pub async fn sia_list_pinned_objects(
    state: tauri::State<'_, SiaState>,
) -> Result<Vec<PinnedObjectInfo>, String> {
    state
        .run(move |s| async move { s.list_pinned_objects().await })
        .await
}

#[tauri::command]
pub async fn sia_get_object_slabs(
    state: tauri::State<'_, SiaState>,
    object_id: String,
) -> Result<Option<PinnedObjectInfo>, String> {
    state
        .run(move |s| async move { s.get_object_slabs(&object_id).await })
        .await
}
