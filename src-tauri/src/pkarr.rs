// The desktop end of the pkarr seam (src/lib/pkarrTransport.ts) — two Tauri commands
// over `pin_pkarr`, the crate the browser uses too.
//
// What's shared and what isn't: packet building, signing, the TTL, the retry posture and
// TXT extraction all live in pin-pkarr, because a divergence there would be a data bug —
// the two engines publish and read the SAME records. The transport underneath is the one
// genuine difference: this build talks straight to the Mainline DHT (`no_relays`), so a
// fresh publish is resolvable in seconds, where the browser must go through public
// relays whose own caches lag by minutes. That's a capability boundary (a browser
// sandbox cannot send UDP), not a tier.
//
// These are GENERIC TXT publish/resolve under any key, distinct from identity.rs's
// the identity loop, which publishes the Curator's own record
// document. The frontend hands over the 32-byte SEED rather than a keypair — a wasm
// keypair can't cross IPC, and pin_pkarr rebuilds the key identically on this side.
//
// EXECUTION MODEL: like sia.rs, a dedicated multi-thread `enable_all` runtime, so the
// UDP and timer drivers the DHT needs are guaranteed regardless of what Tauri's own
// runtime enables.

use pin_pkarr::TxtRecord;

/// Tauri-managed state: a runtime with the full driver set, independent of Tauri's.
pub struct PkarrState {
    rt: tokio::runtime::Runtime,
}

impl Default for PkarrState {
    fn default() -> Self {
        PkarrState {
            rt: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("pkarr tokio runtime"),
        }
    }
}

/// Publish TXT records signed by the key derived from `seed`, straight to the Mainline
/// DHT. Replaces whatever that key previously pointed at.
#[tauri::command]
pub async fn pkarr_publish(
    state: tauri::State<'_, PkarrState>,
    seed: Vec<u8>,
    records: Vec<TxtRecord>,
) -> Result<(), String> {
    state
        .rt
        .spawn(async move { pin_pkarr::publish(&seed, &records).await })
        .await
        .map_err(|e| format!("task: {e}"))?
}

/// Resolve a `did:dht:<key>` (or bare key) from the DHT to its current TXT records. An
/// empty vec means nothing is published or resolvable — a miss is an ordinary outcome,
/// matching the web side, and callers read "no records" as "no pointer".
#[tauri::command]
pub async fn pkarr_resolve(
    state: tauri::State<'_, PkarrState>,
    key: String,
) -> Result<Vec<TxtRecord>, String> {
    state
        .rt
        .spawn(async move { pin_pkarr::resolve(&key).await })
        .await
        .map_err(|e| format!("task: {e}"))?
}
