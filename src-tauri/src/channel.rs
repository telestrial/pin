//! The channel locator's round-trip, run natively.
//!
//! Same crate the browser reaches through wasm (`pin_channel`), reached here over IPC
//! for the same reason Sia itself is: the connected session lives in THIS process, not
//! in the WebView. The wasm session is never connected on desktop — `connectSiaClient`
//! hands the AppKey to this backend instead — so a channel read attempted in the WebView
//! fails instantly with "Sia is not connected".
//!
//! Running it here also means the round-trip gets the good transports on both halves:
//! native QUIC for the Sia object (no WebView2 byte-stream wart) and the Mainline DHT
//! directly for the pointer, rather than public relays whose read-after-write lag is
//! measured in minutes.

use crate::sia::SiaState;

fn key32(channel_key: &[u8]) -> Result<[u8; 32], String> {
    channel_key
        .try_into()
        .map_err(|_| format!("channel key must be 32 bytes; got {}", channel_key.len()))
}

/// Seal a manifest as its author, upload it, and publish the pointer.
#[tauri::command]
pub async fn channel_publish(
    state: tauri::State<'_, SiaState>,
    curator: tauri::State<'_, crate::curator::CuratorState>,
    app_key_hex: String,
    channel_key: Vec<u8>,
    manifest_json: String,
) -> Result<pin_channel::Published, String> {
    let app_key = pin_derive::decode_app_key(&app_key_hex).ok_or("app key must be 64 hex chars")?;
    let key = key32(&channel_key)?;
    // The doc is read only for a members-only channel, whose epoch is its roster's.
    let engine = crate::curator::current_engine(&curator).ok();
    state
        .run(move |s| async move {
            let blobs = engine.as_ref().map(|e| (*e.blobs).clone());
            let doc = engine
                .as_ref()
                .zip(blobs.as_ref())
                .map(|(e, b)| (&e.doc, b, e.author_id));
            let sealing =
                pin_curator::manifest_sealing(doc, &app_key, &key, &manifest_json).await?;
            pin_channel::publish(&s, &sealing, &manifest_json).await
        })
        .await
}

/// Read a channel from K alone. `None` when the locator resolves to nothing.
///
/// `app_key_hex` opens a manifest with no read key in its head: as its author when this
/// identity wrote it, or with a key the Curator climbed to as a member.
#[tauri::command]
pub async fn channel_resolve(
    state: tauri::State<'_, SiaState>,
    curator: tauri::State<'_, crate::curator::CuratorState>,
    channel_key: Vec<u8>,
    author: String,
    app_key_hex: Option<String>,
) -> Result<Option<pin_channel::Resolved>, String> {
    let key = key32(&channel_key)?;
    let app_key = app_key_hex.as_deref().and_then(pin_derive::decode_app_key);
    let engine = crate::curator::current_engine(&curator).ok();
    state
        .run(move |s| async move {
            let blobs = engine.as_ref().map(|e| (*e.blobs).clone());
            let holdings = holdings(engine.as_deref(), blobs.as_ref(), app_key.as_ref());
            pin_curator::resolve_channel(&s, &holdings, &key, &author).await
        })
        .await
}

/// What a channel's page shows to somebody holding only K: its profile JSON, or `None` when
/// nothing is published or the channel shows no page to non-members.
#[tauri::command]
pub async fn channel_resolve_profile(
    state: tauri::State<'_, SiaState>,
    channel_key: Vec<u8>,
    author: String,
) -> Result<Option<String>, String> {
    let key = key32(&channel_key)?;
    state
        .run(move |s| async move { pin_curator::resolve_channel_profile(&s, &key, &author).await })
        .await
}

/// Open a sealed manifest blob — the path a cached copy takes — with what the Curator
/// holds for one whose head carries no read key.
///
/// Here rather than in the WebView, unlike before: a member's climbed keys live in the
/// Curator's doc, which the WebView's wasm never opens on desktop.
#[tauri::command]
pub async fn channel_open_blob(
    curator: tauri::State<'_, crate::curator::CuratorState>,
    channel_key: Vec<u8>,
    author: String,
    blob: String,
    app_key_hex: Option<String>,
) -> Result<String, String> {
    let key = key32(&channel_key)?;
    let app_key = app_key_hex.as_deref().and_then(pin_derive::decode_app_key);
    let engine = crate::curator::current_engine(&curator).ok();
    let blobs = engine.as_ref().map(|e| (*e.blobs).clone());
    let holdings = holdings(engine.as_deref(), blobs.as_ref(), app_key.as_ref());
    pin_curator::open_channel_object(&holdings, &key, &blob, pin_channel::Kind::Manifest, &author)
        .await
        .map(|(json, _)| json)
}

/// What this process holds for opening channel objects: the Curator's doc when it is
/// running, and the AppKey a caller passed.
fn holdings<'a>(
    engine: Option<&'a crate::docstore::DocEngine>,
    blobs: Option<&'a iroh_blobs::api::Store>,
    app_key: Option<&'a [u8; 32]>,
) -> pin_curator::Holdings<'a> {
    pin_curator::Holdings {
        doc: engine.zip(blobs).map(|(e, b)| (&e.doc, b, e.author_id)),
        app_key,
    }
}

/// Download one of a channel's objects and open it with what the Curator holds.
async fn fetch_object(
    s: &pin_sia::Session,
    engine: Option<std::sync::Arc<crate::docstore::DocEngine>>,
    app_key: Option<[u8; 32]>,
    key: [u8; 32],
    author: String,
    item_url: String,
    kind: pin_channel::Kind,
) -> Result<String, String> {
    let blobs = engine.as_ref().map(|e| (*e.blobs).clone());
    let holdings = holdings(engine.as_deref(), blobs.as_ref(), app_key.as_ref());
    pin_curator::fetch_channel_object(s, &holdings, &key, &item_url, kind, &author)
        .await
        .map(|(json, _, _)| json)
}

/// Re-sign a channel's current pointer to refresh its TTL, minting no new object.
///
/// Needs no session — only pkarr — but it runs on the same runtime as the rest so the
/// DHT publish has the reactor it expects.
#[tauri::command]
pub async fn channel_republish_pointer(
    state: tauri::State<'_, SiaState>,
    channel_key: Vec<u8>,
    item_url: String,
) -> Result<(), String> {
    let key = key32(&channel_key)?;
    state
        .run(move |_| async move { pin_channel::republish_pointer(&key, &item_url).await })
        .await
}

/// Where a channel's conversations currently are, without fetching them.
#[tauri::command]
pub async fn channel_resolve_conversations_url(
    state: tauri::State<'_, SiaState>,
    channel_key: Vec<u8>,
) -> Result<Option<String>, String> {
    let key = key32(&channel_key)?;
    state
        .run(move |_| async move { pin_channel::resolve_conversations_url(&key).await })
        .await
}

/// Download and open a channel's conversations at a URL already resolved for it, returning
/// the subject-to-conversation map as JSON.
#[tauri::command]
pub async fn channel_fetch_conversations(
    state: tauri::State<'_, SiaState>,
    curator: tauri::State<'_, crate::curator::CuratorState>,
    channel_key: Vec<u8>,
    author: String,
    item_url: String,
    app_key_hex: Option<String>,
) -> Result<String, String> {
    let key = key32(&channel_key)?;
    let app_key = app_key_hex.as_deref().and_then(pin_derive::decode_app_key);
    let engine = crate::curator::current_engine(&curator).ok();
    state
        .run(move |s| async move {
            fetch_object(
                &s,
                engine,
                app_key,
                key,
                author,
                item_url,
                pin_channel::Kind::Conversations,
            )
            .await
        })
        .await
}

/// Where a channel's tallies currently are, without fetching them. Needs no session,
/// like `channel_republish_pointer`, and runs here for the same reason.
#[tauri::command]
pub async fn channel_resolve_tallies_url(
    state: tauri::State<'_, SiaState>,
    channel_key: Vec<u8>,
) -> Result<Option<String>, String> {
    let key = key32(&channel_key)?;
    state
        .run(move |_| async move { pin_channel::resolve_tallies_url(&key).await })
        .await
}

/// Download and open a channel's tallies at a URL already resolved for it, returning the
/// subject-to-tally map as JSON.
#[tauri::command]
pub async fn channel_fetch_tallies(
    state: tauri::State<'_, SiaState>,
    curator: tauri::State<'_, crate::curator::CuratorState>,
    channel_key: Vec<u8>,
    author: String,
    item_url: String,
    app_key_hex: Option<String>,
) -> Result<String, String> {
    let key = key32(&channel_key)?;
    let app_key = app_key_hex.as_deref().and_then(pin_derive::decode_app_key);
    let engine = crate::curator::current_engine(&curator).ok();
    state
        .run(move |s| async move {
            fetch_object(
                &s,
                engine,
                app_key,
                key,
                author,
                item_url,
                pin_channel::Kind::Tallies,
            )
            .await
        })
        .await
}
