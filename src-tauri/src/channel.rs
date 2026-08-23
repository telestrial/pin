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

/// Seal a manifest under K, upload it, and publish the pointer.
#[tauri::command]
pub async fn channel_publish(
    state: tauri::State<'_, SiaState>,
    channel_key: Vec<u8>,
    manifest_json: String,
) -> Result<pin_channel::Published, String> {
    let key = key32(&channel_key)?;
    state
        .run(move |s| async move { pin_channel::publish(&s, &key, &manifest_json).await })
        .await
}

/// Read a channel from K alone. `None` when the locator resolves to nothing.
#[tauri::command]
pub async fn channel_resolve(
    state: tauri::State<'_, SiaState>,
    channel_key: Vec<u8>,
) -> Result<Option<pin_channel::Resolved>, String> {
    let key = key32(&channel_key)?;
    state
        .run(move |s| async move { pin_channel::resolve(&s, &key).await })
        .await
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
    channel_key: Vec<u8>,
    item_url: String,
) -> Result<String, String> {
    let key = key32(&channel_key)?;
    state
        .run(move |s| async move { pin_channel::fetch_conversations(&s, &key, &item_url).await })
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
    channel_key: Vec<u8>,
    item_url: String,
) -> Result<String, String> {
    let key = key32(&channel_key)?;
    state
        .run(move |s| async move { pin_channel::fetch_tallies(&s, &key, &item_url).await })
        .await
}
