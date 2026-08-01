//! Content fingerprinting and, later, the encrypted-blob envelope.

use sha2::{Digest, Sha256};

const CID_VERSION_1: u8 = 0x01;
const CODEC_RAW: u8 = 0x55;
const MULTIHASH_SHA2_256: u8 = 0x12;
const SHA256_DIGEST_LEN: u8 = 0x20;

const BASE32_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// RFC 4648 base32, lowercase, unpadded.
///
/// Hand-rolled rather than pulled from a crate: it is fifteen lines, it is pinned by
/// the CID vectors below, and the alphabet has to stay exactly this one — a dependency
/// that quietly upper-cased or padded would change every cache key in the app.
fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut value: u32 = 0;
    let mut bits: u32 = 0;
    for &b in bytes {
        value = (value << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(BASE32_ALPHABET[((value >> (bits - 5)) & 0x1f) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(BASE32_ALPHABET[((value << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// A plaintext content fingerprint, formatted as a CIDv1 with the raw codec and
/// SHA-256.
///
/// It is a hash of the PLAINTEXT, which is the whole point: Sia URLs already
/// content-address the *ciphertext*, so they change on every re-encryption, and a
/// cache keyed on them is invalidated by a repack that changed nothing a reader can
/// see. This survives that, and survives a change of access regime (K-encrypted
/// manifests today, public ones later, per-recipient envelopes later still — none of
/// which touch the plaintext).
///
/// Self-describing, so a future move to e.g. BLAKE3 emits a different multihash code
/// and every CID already written keeps parsing alongside it.
///
/// Layout: multibase 'b' + base32( 0x01 version | 0x55 raw | 0x12 sha2-256 | 0x20 len
/// | digest ).
pub fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);

    let mut cid = Vec::with_capacity(4 + SHA256_DIGEST_LEN as usize);
    cid.push(CID_VERSION_1);
    cid.push(CODEC_RAW);
    cid.push(MULTIHASH_SHA2_256);
    cid.push(SHA256_DIGEST_LEN);
    cid.extend_from_slice(&digest);

    format!("b{}", base32_encode(&cid))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The same three fixtures the TypeScript implementation was locked to, so this
    // is a demonstrated match rather than a claimed one. They were captured against
    // multiformats' CIDv1-raw-sha256 output, so they also pin us to the ecosystem's
    // encoding and not merely to our own past behaviour.
    #[test]
    fn matches_the_captured_cid_vectors() {
        assert_eq!(
            content_hash(b""),
            "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
        );
        assert_eq!(
            content_hash(b"hello"),
            "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
        );
        assert_eq!(
            content_hash(b"hello world"),
            "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e"
        );
    }

    #[test]
    fn is_a_59_char_base32_cid() {
        let cid = content_hash(b"hello");
        assert_eq!(cid.len(), 59);
        assert!(cid.starts_with('b'));
        assert!(cid[1..]
            .chars()
            .all(|c| c.is_ascii_lowercase() || ('2'..='7').contains(&c)));
    }

    #[test]
    fn differs_by_input() {
        assert_ne!(content_hash(b"alpha"), content_hash(b"beta"));
    }
}
