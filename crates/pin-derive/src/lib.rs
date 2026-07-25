//! Shared AppKey-derived seeds for the iroh-docs engine.
//!
//! The doc namespace + author keys are HKDF-derived from the Sia AppKey with these
//! domain-separated `info`s, identically in the browser (`pin-core`, wasm) and the
//! desktop Curator (`src-tauri`, native). Same recovery phrase -> same AppKey -> same
//! namespace on every device — which is what lets a browser and a Curator sync the
//! same doc. These MUST match across both engines; keeping them in one crate removes
//! the drift risk of two hand-copied constants.

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
