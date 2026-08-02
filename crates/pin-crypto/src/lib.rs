//! Content fingerprinting, the channel key's own encodings, and the encrypted-blob
//! envelope.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
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

// --- the channel key and the identifier it implies ------------------------------
//
// A channel key K is the whole capability: it locates the channel (its pkarr locator
// key derives from K) and it decrypts the manifest. `channel_id` is the public name
// that falls out of it — derived, never stored as truth, so anyone holding K arrives at
// the same identifier without being told it.

/// How many bytes of SHA-256(K) the identifier keeps: 10, giving 16 base32 characters
/// and 80 bits of entropy. Collision-resistant for any realistic number of channels,
/// and short enough to read.
const CHANNEL_ID_HASH_BYTES: usize = 10;

/// A channel's public identifier, derived from its key.
///
/// Pin's own format, not a standard one — a truncated hash in a specific base32
/// alphabet — so both sides deriving it independently would be two chances to disagree
/// about the same channel's name. An author and a subscriber who disagreed here would
/// compute different identifiers from the same K and never find each other's channel.
pub fn channel_id(channel_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(channel_key);
    base32_encode(&digest[..CHANNEL_ID_HASH_BYTES])
}

/// Read a channel key from the base64 form the settings record stores it in.
///
/// `None` covers both "not base64" and "not 32 bytes". The length check is the part
/// worth having: a short key would otherwise fail later and less clearly, somewhere
/// inside a cipher or a seed derivation.
pub fn channel_key_from_base64(b64: &str) -> Option<[u8; 32]> {
    B64.decode(b64).ok()?.try_into().ok()
}

/// Write a channel key in the base64 form the settings record and subscribe URLs use.
pub fn channel_key_to_base64(channel_key: &[u8; 32]) -> String {
    B64.encode(channel_key)
}

// --- the encrypted-blob envelope ----------------------------------------------
//
// AES-256-GCM. Layout, base64-encoded (standard alphabet, padded):
//
//     1-byte version | 12-byte nonce | ciphertext-with-16-byte-tag
//
// This format is NOT ours to change: there are channel manifests already sealed this
// way on Sia and settings snapshots alongside them, all written by the Web Crypto
// implementation this replaces. Reading them back is the whole requirement, which is
// why the tests below decrypt a blob captured from that implementation rather than
// merely round-tripping our own output.

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const ENVELOPE_VERSION: u8 = 1;

fn cipher(key: &[u8; KEY_BYTES]) -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
}

/// Seal bytes under a 32-byte key, returning the base64 blob.
pub fn encrypt(key: &[u8; KEY_BYTES], plaintext: &[u8]) -> Result<String, String> {
    let mut nonce = [0u8; NONCE_BYTES];
    getrandom::fill(&mut nonce).map_err(|e| format!("nonce: {e}"))?;

    let sealed = cipher(key)
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &[],
            },
        )
        .map_err(|_| "encrypt failed".to_string())?;

    let mut blob = Vec::with_capacity(1 + NONCE_BYTES + sealed.len());
    blob.push(ENVELOPE_VERSION);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&sealed);
    Ok(B64.encode(blob))
}

/// Open a base64 blob produced by `encrypt` — or by the Web Crypto implementation
/// that came before it, which is the case that matters.
pub fn decrypt(key: &[u8; KEY_BYTES], blob_b64: &str) -> Result<Vec<u8>, String> {
    let blob = B64
        .decode(blob_b64.as_bytes())
        .map_err(|e| format!("base64: {e}"))?;
    if blob.len() < 1 + NONCE_BYTES + TAG_BYTES {
        return Err("blob too short to hold version + nonce + tag".into());
    }
    if blob[0] != ENVELOPE_VERSION {
        return Err(format!(
            "unsupported encryption version (got {}, expected {ENVELOPE_VERSION})",
            blob[0]
        ));
    }
    cipher(key)
        .decrypt(
            Nonce::from_slice(&blob[1..1 + NONCE_BYTES]),
            Payload {
                msg: &blob[1 + NONCE_BYTES..],
                aad: &[],
            },
        )
        // A wrong key and a tampered blob are the same failure here, deliberately —
        // GCM authenticates, and distinguishing them would only leak which it was.
        .map_err(|_| "decrypt failed (wrong key or corrupt blob)".to_string())
}

// --- settings: a fixed-size padded blob ---------------------------------------
//
// The settings record is world-readable wherever it sits, so its ciphertext is padded
// to a constant size before sealing: length alone would otherwise leak how many
// channels and subscriptions it holds. Fixed padding leaks nothing at any pad size, so
// this one is chosen for headroom (~400+ entries against a friend-scale handful)
// rather than for secrecy.
//
// Padded plaintext: 4-byte big-endian payload length | payload | zero fill.

pub const SETTINGS_PAD_SIZE: usize = 128 * 1024;
const SETTINGS_LENGTH_HEADER_BYTES: usize = 4;

pub fn encrypt_settings(key: &[u8; KEY_BYTES], plaintext: &[u8]) -> Result<String, String> {
    if SETTINGS_LENGTH_HEADER_BYTES + plaintext.len() > SETTINGS_PAD_SIZE {
        // Loud on purpose. Silently truncating would corrupt someone's channel keys,
        // and silently growing the pad would leak the size it exists to hide.
        return Err(format!(
            "settings payload ({} B) exceeds the {SETTINGS_PAD_SIZE} B fixed pad",
            plaintext.len()
        ));
    }
    let mut padded = vec![0u8; SETTINGS_PAD_SIZE];
    padded[..SETTINGS_LENGTH_HEADER_BYTES].copy_from_slice(&(plaintext.len() as u32).to_be_bytes());
    padded[SETTINGS_LENGTH_HEADER_BYTES..SETTINGS_LENGTH_HEADER_BYTES + plaintext.len()]
        .copy_from_slice(plaintext);
    encrypt(key, &padded)
}

pub fn decrypt_settings(key: &[u8; KEY_BYTES], blob_b64: &str) -> Result<Vec<u8>, String> {
    let padded = decrypt(key, blob_b64)?;
    if padded.len() < SETTINGS_LENGTH_HEADER_BYTES {
        return Err("decrypted settings blob too short for its length header".into());
    }
    let len = u32::from_be_bytes([padded[0], padded[1], padded[2], padded[3]]) as usize;
    let end = SETTINGS_LENGTH_HEADER_BYTES + len;
    if end > padded.len() {
        return Err("settings length header exceeds blob size".into());
    }
    Ok(padded[SETTINGS_LENGTH_HEADER_BYTES..end].to_vec())
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

    // --- the channel key -------------------------------------------------------

    #[test]
    fn a_channel_id_matches_the_value_the_frontend_already_locks() {
        // The same regression lock the TypeScript suite asserts for the all-zeros key,
        // so both implementations are pinned to one value rather than each to itself.
        // Two sides disagreeing here would name the same channel differently and never
        // find each other's.
        assert_eq!(channel_id(&[0u8; 32]), "mzuhvlpymk6xo3ep");
    }

    #[test]
    fn a_channel_id_is_sixteen_lowercase_base32_characters() {
        let id = channel_id(&vector_key());
        assert_eq!(id.len(), 16);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_lowercase() || ('2'..='7').contains(&c)));
    }

    #[test]
    fn a_channel_id_is_deterministic_and_key_specific() {
        let mut other = vector_key();
        other[0] ^= 1;
        assert_eq!(channel_id(&vector_key()), channel_id(&vector_key()));
        assert_ne!(channel_id(&vector_key()), channel_id(&other));
    }

    #[test]
    fn a_channel_key_round_trips_through_its_stored_form() {
        let key = vector_key();
        assert_eq!(
            channel_key_from_base64(&channel_key_to_base64(&key)),
            Some(key)
        );
    }

    #[test]
    fn a_channel_key_that_is_the_wrong_length_or_not_base64_is_rejected() {
        // The length check is the part worth having — a 16-byte key is valid base64 and
        // would otherwise fail later, inside a cipher or a seed derivation.
        assert_eq!(channel_key_from_base64(&B64.encode([0u8; 16])), None);
        assert_eq!(channel_key_from_base64("not base64!!"), None);
    }

    // 0x00..0x1f — the key the vectors below were captured under.
    fn vector_key() -> [u8; KEY_BYTES] {
        let mut k = [0u8; KEY_BYTES];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    // THE test that matters. This blob was produced by the Web Crypto implementation
    // this crate replaces, so decrypting it proves the two agree on the version byte,
    // the nonce's position and length, where GCM's tag lives, and the base64 alphabet
    // and padding — every part of the format that a fresh implementation could get
    // plausibly wrong while round-tripping its own output perfectly.
    //
    // It stands in for real data: manifests sealed this way are already on Sia, and
    // failing to read them would not be a regression in a feature, it would be a user
    // unable to open their own channels.
    #[test]
    fn decrypts_a_blob_sealed_by_the_web_crypto_implementation() {
        let blob = "AZiISAgkJFOaX+sMlkv3mg5k2qKCX/95ZXPEzXwLpNphBo4rqU1epuXW/URatLgPfI/yLbGQ0Nx0wy24OI6r/2iBUA==";
        let plaintext = decrypt(&vector_key(), blob).expect("decrypts");
        assert_eq!(
            String::from_utf8(plaintext).unwrap(),
            r#"{"version":1,"name":"Test","items":[]}"#
        );
    }

    // The empty payload, whose blob is exactly the minimum: version + nonce + tag.
    #[test]
    fn decrypts_the_empty_payload_vector() {
        let blob = "Abj2IwQ7srFqotlJUolZt1TrcZThtYrqm+6kJIA=";
        assert_eq!(decrypt(&vector_key(), blob).unwrap(), Vec::<u8>::new());
        assert_eq!(B64.decode(blob).unwrap().len(), 1 + NONCE_BYTES + TAG_BYTES);
    }

    #[test]
    fn round_trips_and_uses_a_fresh_nonce_each_time() {
        let key = vector_key();
        let msg = b"the quick brown fox";
        let a = encrypt(&key, msg).unwrap();
        let b = encrypt(&key, msg).unwrap();
        // Reusing a nonce under one key is the way to break GCM, so this is a
        // correctness assertion and not a statistical one.
        assert_ne!(a, b);
        assert_eq!(decrypt(&key, &a).unwrap(), msg);
        assert_eq!(decrypt(&key, &b).unwrap(), msg);
    }

    #[test]
    fn rejects_a_wrong_key_a_tampered_blob_and_a_bad_version() {
        let key = vector_key();
        let blob = encrypt(&key, b"secret").unwrap();

        let mut other = key;
        other[0] ^= 1;
        assert!(decrypt(&other, &blob).is_err());

        // Flip a bit in the ciphertext body; GCM's tag must catch it.
        let mut raw = B64.decode(&blob).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        assert!(decrypt(&key, &B64.encode(&raw)).is_err());

        let mut wrong_version = B64.decode(&blob).unwrap();
        wrong_version[0] = 2;
        let err = decrypt(&key, &B64.encode(&wrong_version)).unwrap_err();
        assert!(err.contains("version"), "{err}");
    }

    // The pad is what makes the settings blob's LENGTH carry no information, so the
    // constant and the resulting size are both part of the format. 174804 is the
    // base64 length the Web Crypto implementation produced for any payload at all.
    #[test]
    fn settings_pad_hides_the_payload_size() {
        let key = vector_key();
        let small = encrypt_settings(&key, br#"{"version":1}"#).unwrap();
        let larger = encrypt_settings(&key, &vec![b'x'; 50_000]).unwrap();

        assert_eq!(SETTINGS_PAD_SIZE, 131_072);
        assert_eq!(small.len(), 174_804);
        assert_eq!(small.len(), larger.len());

        assert_eq!(
            decrypt_settings(&key, &small).unwrap(),
            br#"{"version":1}"#.to_vec()
        );
        assert_eq!(decrypt_settings(&key, &larger).unwrap().len(), 50_000);
    }

    #[test]
    fn settings_overflow_is_an_error_rather_than_a_truncation() {
        let err = encrypt_settings(&vector_key(), &vec![b'x'; SETTINGS_PAD_SIZE]).unwrap_err();
        assert!(err.contains("exceeds"), "{err}");
    }
}
