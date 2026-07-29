//! Shared derivations for the iroh-docs engine: the AppKey-derived seeds, and the
//! record-key shape.
//!
//! The doc namespace + author keys are HKDF-derived from the Sia AppKey with these
//! domain-separated `info`s, identically in the browser (`pin-core`, wasm) and the
//! desktop Curator (`src-tauri`, native). Same recovery phrase -> same AppKey -> same
//! namespace on every device — which is what lets a browser and a Curator sync the
//! same doc. These MUST match across both engines; keeping them in one crate removes
//! the drift risk of two hand-copied constants.
//!
//! `record_key` / `collection_prefix` are here for the same reason, one step further
//! in: because the two engines sync the SAME doc, a divergence in how they spell a
//! record's key isn't untidy — it's a data bug (each side writes records the other
//! can't find). The live-event kinds at the bottom are the same story one layer out:
//! the frontend receives them from either engine and switches on them, so a
//! divergence silently breaks live updates on one platform.
//!
//! The rule: anything whose divergence would corrupt shared data — or silently break
//! behaviour across the seam — belongs here.

use hkdf::Hkdf;
use sha2::Sha256;

/// HKDF `info` for the doc namespace key.
pub const NS_INFO: &[u8] = b"pin:iroh-docs-namespace:v1";
/// HKDF `info` for the doc author key.
pub const AUTHOR_INFO: &[u8] = b"pin:iroh-docs-author:v1";

/// HKDF-SHA256(ikm, info) -> 32 bytes. Infallible: 32 bytes is always a valid
/// HKDF-SHA256 output length (well under the 255*32 ceiling), so `expand` can't error.
pub fn hkdf32(ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut okm = [0u8; 32];
    hk.expand(info, &mut okm)
        .expect("HKDF-SHA256 expand of 32 bytes is always valid");
    okm
}

/// Decode 32 bytes from a 64-char hex string. `None` if the hex is the wrong length
/// or contains a non-hex char. Every secret that crosses into an engine does so as
/// 32 bytes of hex, so this is the one decoder for all of them.
pub fn decode_hex32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Decode the 32-byte Sia AppKey from its 64-char hex form (the HKDF IKM). Named
/// separately from [`decode_hex32`] so the call site says which secret it is.
pub fn decode_app_key(hex: &str) -> Option<[u8; 32]> {
    decode_hex32(hex)
}

/// A record's key in the doc: `collection/rkey`, as bytes. The one spelling both
/// engines write and read — they sync the same doc, so this can't diverge.
pub fn record_key(collection: &str, rkey: &str) -> Vec<u8> {
    format!("{collection}/{rkey}").into_bytes()
}

/// The key prefix that scopes a collection — `collection/`. Listing a collection
/// means filtering keys by this, then stripping it to recover the rkey.
pub fn collection_prefix(collection: &str) -> String {
    format!("{collection}/")
}

// --- Live-event kinds --------------------------------------------------------
//
// The `kind` an engine reports for an iroh-docs `LiveEvent`. Here for the same reason
// as `record_key`: the frontend switches on these to decide whether to re-read a
// record, and it receives them from EITHER engine (a wasm callback in the browser, a
// Tauri event on desktop). If the two spelled a kind differently, live updates would
// silently stop working on one platform — a behaviour bug across the seam, and a
// quiet one. Each engine still matches its own `LiveEvent`; only the spelling is
// shared, so this crate needs no iroh dependency.

/// A local write landed (this instance wrote it).
pub const EV_INSERT_LOCAL: &str = "insert-local";
/// A remote write landed — a peer wrote an entry. The signal to re-read.
pub const EV_INSERT_REMOTE: &str = "insert-remote";
/// A synced entry's content finished downloading. Distinct from `insert-remote`
/// because iroh-blobs content LAGS the entry metadata: a key can be present while
/// its value isn't readable yet, so a reader that only reacts to `insert-remote` can
/// see a "not found" for content that arrives moments later.
pub const EV_CONTENT_READY: &str = "content-ready";
/// All pending content has been downloaded.
pub const EV_PENDING_CONTENT_READY: &str = "pending-content-ready";
/// A sync peer joined the gossip swarm for this doc.
pub const EV_NEIGHBOR_UP: &str = "neighbor-up";
/// A sync peer left.
pub const EV_NEIGHBOR_DOWN: &str = "neighbor-down";
/// A reconciliation round finished.
pub const EV_SYNC_FINISHED: &str = "sync-finished";
/// The event stream itself errored.
pub const EV_ERROR: &str = "error";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_key_is_collection_slash_rkey() {
        assert_eq!(record_key("settings", "self"), b"settings/self".to_vec());
        assert_eq!(record_key("channel", "abc123"), b"channel/abc123".to_vec());
    }

    #[test]
    fn a_record_key_starts_with_its_collection_prefix() {
        // The invariant the list path depends on: a record written under a
        // collection is findable by that collection's prefix, and stripping the
        // prefix recovers the rkey exactly.
        let key = record_key("sub", "xyz");
        let key = String::from_utf8(key).unwrap();
        let prefix = collection_prefix("sub");
        assert_eq!(key.strip_prefix(&prefix), Some("xyz"));
    }

    #[test]
    fn decode_app_key_rejects_bad_hex() {
        assert!(decode_app_key("00").is_none());
        assert!(decode_app_key(&"z".repeat(64)).is_none());
        assert_eq!(decode_app_key(&"00".repeat(32)), Some([0u8; 32]));
    }
}
