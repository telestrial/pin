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
//! can't find). Anything whose divergence would corrupt shared data belongs here.

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

/// Decode the 32-byte Sia AppKey from its 64-char hex form (the HKDF IKM).
/// `None` if the hex is the wrong length or contains a non-hex char.
pub fn decode_app_key(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
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
