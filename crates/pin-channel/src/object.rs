//! The sealed object a channel publishes, in two layers: a HEAD sealed under K and a BODY
//! sealed under the content key C.
//!
//! K locates and C decrypts. Everyone who can find a channel holds K, so the head is what
//! anyone who can find it may read, and it says how to get C: a channel that anyone may
//! read carries C in its head, and one that only members may read leaves it out. Splitting
//! the two is what lets reading be granted and withdrawn without moving the channel —
//! K, and with it the channelID and every pointer, stays where it is while C moves to a new
//! epoch.
//!
//! Layout, base64-encoded once (standard alphabet, padded):
//!
//! ```text
//! 2 | head length, u32 big-endian | head sealed under K | body sealed under C
//! ```
//!
//! Each sealed part is `pin_crypto::seal_raw` (nonce, then ciphertext and tag), so the
//! object costs one base64 expansion like the single envelope before it, rather than the
//! two that nesting one `encrypt` output inside another would. The head is JSON.
//!
//! One format for all three artifacts a channel publishes — the manifest, the tallies and
//! the conversations — so a reader who can open one can open the others, and there is one
//! place a head is read.
//!
//! ALSO READS VERSION 1 for now: the whole payload sealed under K as one
//! `pin_crypto::encrypt` envelope, which is what every object published before this format
//! is. Its content key IS K, and that is what it reports, so a caller handed one seals
//! nothing differently from what the object it read was sealed under.

use serde::{Deserialize, Serialize};

/// The leading byte of an object in this format.
const OBJECT_VERSION: u8 = 2;
/// The leading byte of a single `pin_crypto::encrypt` envelope — the format before this.
const LEGACY_VERSION: u8 = 1;
const HEAD_LEN_BYTES: usize = 4;

/// A channel's content key at one epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentKey {
    pub epoch: u32,
    pub key: [u8; 32],
}

/// What a publisher seals an object with.
#[derive(Debug, Clone, Copy)]
pub struct Sealing<'a> {
    /// K: seals the head, and is what every reader holds.
    pub channel_key: &'a [u8; 32],
    /// C: seals the body.
    pub content: ContentKey,
    /// Whether C goes in the head, which makes the body readable by anyone holding K.
    pub publish_read_key: bool,
}

/// An opened object: the body, and the content key it was sealed under.
///
/// The key comes back because the three artifacts share it — a reader who opened the
/// manifest holds what it needs for the tallies and the conversations, and for what the
/// channel's doc holds.
#[derive(Debug)]
pub struct Opened {
    pub payload: Vec<u8>,
    pub content: ContentKey,
}

/// The head's contents. What anyone holding K can read, so nothing goes here that a
/// finder of the channel may not know.
#[derive(Serialize, Deserialize)]
struct Head {
    epoch: u32,
    /// C, base64. Absent when only members may read the body.
    #[serde(rename = "readKey", default, skip_serializing_if = "Option::is_none")]
    read_key: Option<String>,
}

/// Seal a payload into an object.
pub fn seal(sealing: &Sealing, payload: &[u8]) -> Result<String, String> {
    let head = Head {
        epoch: sealing.content.epoch,
        read_key: sealing
            .publish_read_key
            .then(|| pin_crypto::b64_encode(&sealing.content.key)),
    };
    let head_json = serde_json::to_vec(&head).map_err(|e| format!("head: {e}"))?;
    let head = pin_crypto::seal_raw(sealing.channel_key, &head_json)?;
    let body = pin_crypto::seal_raw(&sealing.content.key, payload)?;

    let head_len = u32::try_from(head.len()).map_err(|_| "head too large".to_string())?;
    let mut out = Vec::with_capacity(1 + HEAD_LEN_BYTES + head.len() + body.len());
    out.push(OBJECT_VERSION);
    out.extend_from_slice(&head_len.to_be_bytes());
    out.extend_from_slice(&head);
    out.extend_from_slice(&body);
    Ok(pin_crypto::b64_encode(&out))
}

/// Open an object with K.
///
/// Fails on a head that carries no read key, because nothing yet holds C any other way —
/// the failure a non-member meets, and the one membership will answer.
pub fn open(channel_key: &[u8; 32], blob: &str) -> Result<Opened, String> {
    let bytes = pin_crypto::b64_decode(blob).ok_or("object is not base64")?;
    match bytes.first() {
        Some(&OBJECT_VERSION) => {
            let (content, body) = read_head(channel_key, &bytes[1..])?;
            Ok(Opened {
                payload: pin_crypto::open_raw(&content.key, body)?,
                content,
            })
        }
        Some(&LEGACY_VERSION) => Ok(Opened {
            payload: pin_crypto::decrypt(channel_key, blob)?,
            content: legacy_content(channel_key),
        }),
        Some(v) => Err(format!("unsupported object version {v}")),
        None => Err("object is empty".into()),
    }
}

/// The content key an object was sealed under, read from its head alone.
///
/// For a caller that holds an object only to learn how to open the channel's other
/// artifacts: a cached manifest, read for the key to its doc's ticket or to a comment's
/// seal. The body is left sealed, so asking costs a head rather than a manifest.
pub fn content_key(channel_key: &[u8; 32], blob: &str) -> Result<ContentKey, String> {
    let bytes = pin_crypto::b64_decode(blob).ok_or("object is not base64")?;
    match bytes.first() {
        Some(&OBJECT_VERSION) => read_head(channel_key, &bytes[1..]).map(|(content, _)| content),
        // Opened to be sure K is its key, so the answer is as true as the one `open` gives.
        Some(&LEGACY_VERSION) => {
            pin_crypto::decrypt(channel_key, blob)?;
            Ok(legacy_content(channel_key))
        }
        Some(v) => Err(format!("unsupported object version {v}")),
        None => Err("object is empty".into()),
    }
}

/// A version-1 envelope's content key, which is K itself.
fn legacy_content(channel_key: &[u8; 32]) -> ContentKey {
    ContentKey {
        epoch: pin_derive::INITIAL_EPOCH,
        key: *channel_key,
    }
}

/// Open the head of a layered object and work out its content key, answering with the
/// still-sealed body beside it.
fn read_head<'b>(channel_key: &[u8; 32], rest: &'b [u8]) -> Result<(ContentKey, &'b [u8]), String> {
    let (len, rest) = rest
        .split_at_checked(HEAD_LEN_BYTES)
        .ok_or("object too short to hold a head length")?;
    // Infallible: `split_at_checked` gave exactly HEAD_LEN_BYTES.
    let len = u32::from_be_bytes(len.try_into().unwrap()) as usize;
    let (head, body) = rest
        .split_at_checked(len)
        .ok_or("object shorter than its head")?;

    let head = pin_crypto::open_raw(channel_key, head)?;
    let head: Head = serde_json::from_slice(&head).map_err(|e| format!("head: {e}"))?;
    let key = head
        .read_key
        .as_deref()
        .ok_or_else(|| format!("no read key for epoch {}", head.epoch))?;
    let key = pin_crypto::channel_key_from_base64(key).ok_or("head read key is malformed")?;
    Ok((
        ContentKey {
            epoch: head.epoch,
            key,
        },
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: [u8; 32] = [7u8; 32];
    const C: ContentKey = ContentKey {
        epoch: 3,
        key: [9u8; 32],
    };

    fn sealing(publish_read_key: bool) -> Sealing<'static> {
        Sealing {
            channel_key: &K,
            content: C,
            publish_read_key,
        }
    }

    #[test]
    fn an_object_opens_with_k_and_reports_its_content_key() {
        let blob = seal(&sealing(true), b"payload").unwrap();
        let opened = open(&K, &blob).unwrap();
        assert_eq!(opened.payload, b"payload");
        assert_eq!(opened.content, C);
    }

    #[test]
    fn the_body_is_sealed_under_c_and_not_k() {
        // Sealed as a member-only object, then given the read key by hand: if the body
        // were under K, K alone would open it, which is the property the split exists to
        // remove.
        let blob = seal(&sealing(false), b"payload").unwrap();
        let bytes = pin_crypto::b64_decode(&blob).unwrap();
        let len = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
        let body = &bytes[5 + len..];
        assert!(pin_crypto::open_raw(&K, body).is_err());
        assert_eq!(pin_crypto::open_raw(&C.key, body).unwrap(), b"payload");
    }

    #[test]
    fn an_object_without_a_read_key_does_not_open_with_k() {
        let blob = seal(&sealing(false), b"payload").unwrap();
        let err = open(&K, &blob).unwrap_err();
        assert!(err.contains("no read key for epoch 3"), "{err}");
    }

    #[test]
    fn an_object_does_not_open_with_the_wrong_k() {
        let blob = seal(&sealing(true), b"payload").unwrap();
        let mut wrong = K;
        wrong[0] ^= 1;
        assert!(open(&wrong, &blob).is_err());
    }

    #[test]
    fn the_content_key_is_read_from_the_head_alone() {
        let blob = seal(&sealing(true), b"payload").unwrap();
        assert_eq!(content_key(&K, &blob).unwrap(), C);
        // A body nothing could open still yields its key, which is what lets the head be
        // read without paying for the body.
        let mut bytes = pin_crypto::b64_decode(&blob).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        let damaged = pin_crypto::b64_encode(&bytes);
        assert!(open(&K, &damaged).is_err());
        assert_eq!(content_key(&K, &damaged).unwrap(), C);

        let mut wrong = K;
        wrong[0] ^= 1;
        assert!(content_key(&wrong, &blob).is_err());
        assert!(content_key(&K, &seal(&sealing(false), b"payload").unwrap()).is_err());
    }

    #[test]
    fn a_legacy_envelope_opens_and_reports_k_as_its_content_key() {
        let blob = pin_crypto::encrypt(&K, b"payload").unwrap();
        let opened = open(&K, &blob).unwrap();
        assert_eq!(opened.payload, b"payload");
        assert_eq!(
            opened.content,
            ContentKey {
                epoch: pin_derive::INITIAL_EPOCH,
                key: K,
            }
        );
    }

    #[test]
    fn the_head_carries_only_the_epoch_and_the_read_key() {
        // Whatever the head holds, anyone who can find the channel can read. Asserted on
        // the key set so a field added here is a decision rather than a side effect.
        let blob = seal(&sealing(true), b"payload").unwrap();
        let bytes = pin_crypto::b64_decode(&blob).unwrap();
        let len = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
        let head = pin_crypto::open_raw(&K, &bytes[5..5 + len]).unwrap();
        let head: serde_json::Value = serde_json::from_slice(&head).unwrap();
        let mut keys: Vec<&String> = head.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["epoch", "readKey"]);

        let blob = seal(&sealing(false), b"payload").unwrap();
        let bytes = pin_crypto::b64_decode(&blob).unwrap();
        let len = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
        let head = pin_crypto::open_raw(&K, &bytes[5..5 + len]).unwrap();
        let head: serde_json::Value = serde_json::from_slice(&head).unwrap();
        assert_eq!(
            head.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["epoch"]
        );
    }

    #[test]
    fn a_truncated_object_is_refused_rather_than_misread() {
        let blob = seal(&sealing(true), b"payload").unwrap();
        let bytes = pin_crypto::b64_decode(&blob).unwrap();
        for cut in [1, 3, 5, 20] {
            let short = pin_crypto::b64_encode(&bytes[..cut]);
            assert!(open(&K, &short).is_err(), "cut at {cut}");
        }
    }
}
