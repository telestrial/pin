// Native Sia I/O over the `sia_storage` crate, exposed to the frontend as Tauri
// commands — the desktop implementation of the `SiaClient` seam (src/core/siaClient.ts).
//
// WHY: on the web, Sia runs as the WASM SDK inside the page. In the desktop
// WebView2 shell that WASM `download` path fails ("readable byte streams not
// supported"). Moving Sia into this native backend (native QUIC, no browser
// byte-stream dependency) is the documented fix. The frontend `makeTauriSiaClient`
// (src/lib/tauriSiaClient.ts) invokes these commands; every op is coarse — plain
// data in/out — so no live `Object` handle ever crosses the IPC boundary.
//
// EXECUTION MODEL: we hold ONE `Sdk` (built at connect from the AppKey the
// frontend already unlocked) plus a dedicated multi-thread tokio runtime with the
// full driver set (`enable_all` → the net/IO driver Sia's QUIC needs is
// guaranteed, independent of whatever Tauri's own runtime enables). Async commands
// run off the main thread on Tauri's runtime, and dispatch the actual Sia futures
// onto our dedicated runtime via `rt.spawn(..).await` — the future is polled by a
// runtime we know has the net driver, and awaiting the JoinHandle from Tauri's
// runtime is a plain future poll.
//
// BYTES OVER IPC: raw both ways, no base64. Downloads return raw bytes via
// `tauri::ipc::Response` (JS gets an ArrayBuffer). Uploads RECEIVE the raw request
// body via `tauri::ipc::Request` (`InvokeBody::Raw`) — Tauri v2 async commands DO
// accept a borrowed `Request`, so we read the bytes off it before the first await.
// A `Vec<u8>` typed arg from a raw body is broken upstream (tauri #9948: raw→typed
// does `serde_json::from_slice`), which is why it's `Request`, not a `Vec<u8>` arg.
// Packed uploads carry N buffers in one raw body via a little-endian
// [u32 count][u32 len][bytes]... frame (see `unframe`).

use std::io::Cursor;
use std::sync::Arc;

use sia_storage::{
    app_id, AppKey, AppMetadata, Builder, DateTime, DownloadOptions, Hash256, Object,
    ObjectsCursor, Sdk, Slab, UploadOptions, Utc,
};
use tokio::sync::Mutex;

// Must match the frontend's APP_META (src/lib/constants.ts) exactly — the AppID
// derives the encryption scope, so a mismatch reads/writes a different scope.
fn app_meta() -> AppMetadata {
    AppMetadata {
        id: app_id!("f6b7539e181e45ee750a491a58aa8392830a17c402115cf47c6e7dfe9f7ffcb0"),
        name: "Pin",
        description: "A Sia storage app",
        service_url: "https://sia.storage",
        logo_url: None,
        callback_url: None,
    }
}

// Year-9999 makes item share URLs effectively permanent (mirrors core/sia.ts FAR_FUTURE).
fn far_future() -> DateTime<Utc> {
    "9999-12-31T00:00:00Z".parse().expect("valid timestamp")
}

fn hex_to_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

// Split a framed raw payload — [u32 count][u32 len][bytes]... little-endian — back
// into the individual buffers. The frontend frames N packed-upload buffers into
// one raw IPC body (a raw request body is a single blob, so N buffers get framed).
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

/// Tauri-managed state: the dedicated Sia runtime + the connected Sdk (if any).
pub struct SiaState {
    rt: tokio::runtime::Runtime,
    sdk: Mutex<Option<Arc<Sdk>>>,
}

impl Default for SiaState {
    fn default() -> Self {
        SiaState {
            rt: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("sia tokio runtime"),
            sdk: Mutex::new(None),
        }
    }
}

async fn current_sdk(state: &SiaState) -> Result<Arc<Sdk>, String> {
    state
        .sdk
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Sia is not connected".to_string())
}

// --- DTOs (serde camelCase → the shapes the TS client reads) -----------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadDto {
    id: String,
    item_url: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshotDto {
    pinned_data: u64,
    pinned_size: u64,
    raw_content_bytes: u64,
    max_pinned_data: u64,
    remaining_storage: u64,
    fetched_at: String,
}

// `slabs` reuses the SDK's own `Slab` — its serde (camelCase, EncryptionKey→base64,
// Hash256/PublicKey→string) produces byte-for-byte the TS `Slab` interface, so the
// repack / slab-inspector consumers read it unchanged.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedObjectDto {
    id: String,
    created_at: String,
    slabs: Vec<Slab>,
}

/// One current (non-deleted) object, owned so it survives past the event borrow.
struct CurrentObj {
    id: String,
    created_at: DateTime<Utc>,
    slabs: Vec<Slab>,
}

const EVENTS_PAGE_LIMIT: usize = 200;
// Defensive cap — 200 × 50 = 10000 events covers any plausible scope.
const EVENTS_MAX_PAGES: usize = 50;

// Walk objectEvents, keep the latest event per id, drop deleted, return owned
// descriptors. Single home for the walk the metering / repack / reset / slab
// sites need (mirrors walkPinnedObjects in core/siaClient.ts).
async fn walk_current(sdk: &Sdk) -> Result<Vec<CurrentObj>, String> {
    use std::collections::HashMap;
    let mut latest: HashMap<String, sia_storage::ObjectEvent> = HashMap::new();
    let mut cursor: Option<ObjectsCursor> = None;
    for _ in 0..EVENTS_MAX_PAGES {
        let events = sdk
            .object_events(cursor.take(), Some(EVENTS_PAGE_LIMIT))
            .await
            .map_err(|e| format!("object_events: {e}"))?;
        let n = events.len();
        if n == 0 {
            break;
        }
        let last_after = events[n - 1].updated_at;
        let last_id = events[n - 1].id.clone();
        for ev in events {
            let key = ev.id.to_string();
            match latest.get(&key) {
                Some(prev) if prev.updated_at >= ev.updated_at => {}
                _ => {
                    latest.insert(key, ev);
                }
            }
        }
        if n < EVENTS_PAGE_LIMIT {
            break;
        }
        cursor = Some(ObjectsCursor {
            after: last_after,
            id: last_id,
        });
    }
    let mut out = Vec::new();
    for ev in latest.into_values() {
        if ev.deleted {
            continue;
        }
        if let Some(obj) = ev.object {
            out.push(CurrentObj {
                id: ev.id.to_string(),
                created_at: *obj.created_at(),
                slabs: obj.slabs().to_vec(),
            });
        }
    }
    Ok(out)
}

// --- commands ----------------------------------------------------------------

/// Build the Sdk from the AppKey the frontend already unlocked, and hold it.
/// Overwrites any previous connection (e.g. after a re-onboard).
#[tauri::command]
pub async fn sia_connect(
    state: tauri::State<'_, SiaState>,
    app_key_hex: String,
    indexer_url: String,
) -> Result<(), String> {
    let bytes = hex_to_32(&app_key_hex).ok_or("app key must be 32-byte hex (64 chars)")?;
    let sdk = state
        .rt
        .spawn(async move {
            let app_key = AppKey::import(bytes);
            let builder =
                Builder::new(&indexer_url, app_meta()).map_err(|e| format!("builder: {e}"))?;
            builder
                .connected(&app_key)
                .await
                .map_err(|e| format!("connect: {e}"))?
                .ok_or_else(|| "indexer did not recognize this app key".to_string())
        })
        .await
        .map_err(|e| format!("task: {e}"))??;
    *state.sdk.lock().await = Some(Arc::new(sdk));
    Ok(())
}

#[tauri::command]
pub async fn sia_upload_item(
    state: tauri::State<'_, SiaState>,
    request: tauri::ipc::Request<'_>,
) -> Result<UploadDto, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(v) => v.clone(),
        _ => return Err("upload requires a raw byte body".to_string()),
    };
    let sdk = current_sdk(&state).await?;
    state
        .rt
        .spawn(async move {
            let obj = sdk
                .upload(
                    Object::default(),
                    Cursor::new(bytes),
                    UploadOptions::default(),
                )
                .await
                .map_err(|e| format!("upload: {e}"))?;
            sdk.pin_object(&obj)
                .await
                .map_err(|e| format!("pin: {e}"))?;
            let url = sdk
                .share_object(&obj, far_future())
                .map_err(|e| format!("share: {e}"))?
                .to_string();
            Ok::<UploadDto, String>(UploadDto {
                id: obj.id().to_string(),
                item_url: url,
            })
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}

#[tauri::command]
pub async fn sia_upload_items_packed(
    state: tauri::State<'_, SiaState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<UploadDto>, String> {
    let buffers = match request.body() {
        tauri::ipc::InvokeBody::Raw(v) => unframe(v)?,
        _ => return Err("packed upload requires a raw byte body".to_string()),
    };
    let sdk = current_sdk(&state).await?;
    state
        .rt
        .spawn(async move {
            let mut packed = sdk
                .upload_packed(UploadOptions::default())
                .map_err(|e| format!("packed: {e}"))?;
            for b in buffers {
                packed
                    .add(Cursor::new(b))
                    .await
                    .map_err(|e| format!("packed add: {e}"))?;
            }
            let objects = packed
                .finalize()
                .await
                .map_err(|e| format!("packed finalize: {e}"))?;
            let mut out = Vec::with_capacity(objects.len());
            for obj in &objects {
                sdk.pin_object(obj).await.map_err(|e| format!("pin: {e}"))?;
                let url = sdk
                    .share_object(obj, far_future())
                    .map_err(|e| format!("share: {e}"))?
                    .to_string();
                out.push(UploadDto {
                    id: obj.id().to_string(),
                    item_url: url,
                });
            }
            Ok::<Vec<UploadDto>, String>(out)
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}

/// Returns raw bytes as an ArrayBuffer — the subscriber read path that WebView2's
/// WASM SDK rejects, done natively.
#[tauri::command]
pub async fn sia_download_item(
    state: tauri::State<'_, SiaState>,
    url: String,
) -> Result<tauri::ipc::Response, String> {
    let sdk = current_sdk(&state).await?;
    let bytes = state
        .rt
        .spawn(async move {
            let obj = sdk
                .shared_object(&url)
                .await
                .map_err(|e| format!("shared_object: {e}"))?;
            let mut dl = sdk
                .download(&obj, DownloadOptions::default())
                .map_err(|e| format!("download start: {e}"))?;
            let mut out = Vec::new();
            tokio::io::copy(&mut dl, &mut out)
                .await
                .map_err(|e| format!("download read: {e}"))?;
            Ok::<Vec<u8>, String>(out)
        })
        .await
        .map_err(|e| format!("task: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn sia_pin_from_share_url(
    state: tauri::State<'_, SiaState>,
    url: String,
) -> Result<String, String> {
    let sdk = current_sdk(&state).await?;
    state
        .rt
        .spawn(async move {
            let obj = sdk
                .shared_object(&url)
                .await
                .map_err(|e| format!("shared_object: {e}"))?;
            sdk.pin_object(&obj)
                .await
                .map_err(|e| format!("pin: {e}"))?;
            Ok::<String, String>(obj.id().to_string())
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}

#[tauri::command]
pub async fn sia_resolve_object_id(
    state: tauri::State<'_, SiaState>,
    url: String,
) -> Result<String, String> {
    let sdk = current_sdk(&state).await?;
    state
        .rt
        .spawn(async move {
            let obj = sdk
                .shared_object(&url)
                .await
                .map_err(|e| format!("shared_object: {e}"))?;
            Ok::<String, String>(obj.id().to_string())
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}

#[tauri::command]
pub async fn sia_delete_object(
    state: tauri::State<'_, SiaState>,
    id: String,
) -> Result<(), String> {
    let hash: Hash256 = id.parse().map_err(|e| format!("bad object id: {e:?}"))?;
    let sdk = current_sdk(&state).await?;
    state
        .rt
        .spawn(async move {
            sdk.delete_object(&hash)
                .await
                .map_err(|e| format!("delete: {e}"))
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}

#[tauri::command]
pub async fn sia_prune_slabs(state: tauri::State<'_, SiaState>) -> Result<(), String> {
    let sdk = current_sdk(&state).await?;
    state
        .rt
        .spawn(async move { sdk.prune_slabs().await.map_err(|e| format!("prune: {e}")) })
        .await
        .map_err(|e| format!("task: {e}"))?
}

#[tauri::command]
pub async fn sia_account_snapshot(
    state: tauri::State<'_, SiaState>,
) -> Result<AccountSnapshotDto, String> {
    let sdk = current_sdk(&state).await?;
    state
        .rt
        .spawn(async move {
            let acct = sdk.account().await.map_err(|e| format!("account: {e}"))?;
            let objs = walk_current(&sdk).await?;
            let raw: u64 = objs
                .iter()
                .flat_map(|o| o.slabs.iter())
                .map(|s| s.length as u64)
                .sum();
            Ok::<AccountSnapshotDto, String>(AccountSnapshotDto {
                pinned_data: acct.pinned_data,
                pinned_size: acct.pinned_size,
                raw_content_bytes: raw,
                max_pinned_data: acct.max_pinned_data,
                remaining_storage: acct.remaining_storage,
                fetched_at: Utc::now().to_rfc3339(),
            })
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}

#[tauri::command]
pub async fn sia_list_pinned_objects(
    state: tauri::State<'_, SiaState>,
) -> Result<Vec<PinnedObjectDto>, String> {
    let sdk = current_sdk(&state).await?;
    state
        .rt
        .spawn(async move {
            let objs = walk_current(&sdk).await?;
            Ok::<Vec<PinnedObjectDto>, String>(
                objs.into_iter()
                    .map(|o| PinnedObjectDto {
                        id: o.id,
                        created_at: o.created_at.to_rfc3339(),
                        slabs: o.slabs,
                    })
                    .collect(),
            )
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}

#[tauri::command]
pub async fn sia_get_object_slabs(
    state: tauri::State<'_, SiaState>,
    object_id: String,
) -> Result<Option<PinnedObjectDto>, String> {
    let hash: Hash256 = object_id
        .parse()
        .map_err(|e| format!("bad object id: {e:?}"))?;
    let sdk = current_sdk(&state).await?;
    state
        .rt
        .spawn(async move {
            // Not found → None (matches the WASM getObjectSlabs try/catch → null).
            match sdk.object(&hash).await {
                Ok(obj) => Ok::<Option<PinnedObjectDto>, String>(Some(PinnedObjectDto {
                    id: hash.to_string(),
                    created_at: obj.created_at().to_rfc3339(),
                    slabs: obj.slabs().to_vec(),
                })),
                Err(_) => Ok(None),
            }
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}
