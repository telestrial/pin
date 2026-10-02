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
//! THE HEAD IS SIGNED BY THE AUTHOR, because K is no proof of authorship. Every pointer a
//! channel publishes is signed by a key derived from K, so anyone holding K can repoint
//! one, and an object sealed under K is just as easy for them to make. The signature is
//! the author's did:dht key over the channel, what the object is, its epoch, its read key
//! and a digest of the sealed body — so a reader who checks it against the author's did
//! knows the object is the author's, whoever served it and whatever pointer led to it.

use serde::{Deserialize, Serialize};

/// The leading byte of an object in this format. Version 1 was the whole payload sealed
/// under K as one `pin_crypto::encrypt` envelope, and is not read.
const OBJECT_VERSION: u8 = 2;
/// The domain an object's signature is made in. The did:dht key also signs pkarr packets
/// and engagement records, so a signature with no prefix of its own could be valid for
/// something else.
const SIGNING_DOMAIN: &[u8] = b"pin.channel-object.v1";

/// What a sealed object is.
///
/// Signed, so one kind cannot be passed off as another: a channel's tallies are a genuine
/// object of its author's, and a pointer to the manifest that named them would otherwise
/// be a pointer to a genuine object of the wrong kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Manifest,
    Tallies,
    Conversations,
    /// A value in the channel's own doc.
    DocValue,
    /// A piece of the member tree.
    Members,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Manifest => "manifest",
            Kind::Tallies => "tallies",
            Kind::Conversations => "conversations",
            Kind::DocValue => "doc-value",
            Kind::Members => "members",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        [
            Kind::Manifest,
            Kind::Tallies,
            Kind::Conversations,
            Kind::DocValue,
            Kind::Members,
        ]
        .into_iter()
        .find(|k| k.as_str() == s)
    }
}
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
    /// The author's did:dht seed, which signs the head.
    pub signer: [u8; 32],
}

/// Whose signature a read requires.
///
/// One variant, deliberately: every read names the author it expects, and there is no way
/// to ask for an object without saying whose it must be.
#[derive(Debug, Clone, Copy)]
pub enum Signer<'a> {
    /// The author's did:dht, bare or prefixed. The read fails unless the head verifies
    /// against it.
    Author(&'a str),
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
    /// What the object is, as `Kind::as_str` spells it.
    kind: String,
    /// The author's signature over `signing_bytes`, base64.
    sig: String,
}

/// What the author signs: everything in the head, the channel it belongs to, and a digest
/// of the sealed body.
///
/// The body's CIPHERTEXT, so the signature checks without C: anyone who can find the
/// channel can tell a forged object from a genuine one, member or not. The channel is the
/// one derived from K rather than anything the head claims, so an object cannot be moved
/// from one channel to another.
fn signing_bytes(
    channel_id: &str,
    kind: &str,
    epoch: u32,
    read_key: Option<&str>,
    body: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(SIGNING_DOMAIN.len() + 128);
    out.extend_from_slice(SIGNING_DOMAIN);
    for field in [channel_id, kind, &epoch.to_string()] {
        out.extend_from_slice(&(field.len() as u32).to_be_bytes());
        out.extend_from_slice(field.as_bytes());
    }
    // Tagged rather than bare, so a present read key and an absent one never sign the same
    // bytes.
    match read_key {
        Some(k) => {
            out.push(1);
            out.extend_from_slice(&(k.len() as u32).to_be_bytes());
            out.extend_from_slice(k.as_bytes());
        }
        None => out.push(0),
    }
    out.extend_from_slice(&pin_crypto::sha256(body));
    out
}

/// Seal a payload into an object, signed by its author.
pub fn seal(sealing: &Sealing, kind: Kind, payload: &[u8]) -> Result<String, String> {
    let body = pin_crypto::seal_raw(&sealing.content.key, payload)?;
    let read_key = sealing
        .publish_read_key
        .then(|| pin_crypto::b64_encode(&sealing.content.key));
    let channel_id = pin_crypto::channel_id(sealing.channel_key);
    let sig = pin_pkarr::sign_detached(
        &sealing.signer,
        &signing_bytes(
            &channel_id,
            kind.as_str(),
            sealing.content.epoch,
            read_key.as_deref(),
            &body,
        ),
    )?;
    let head = Head {
        epoch: sealing.content.epoch,
        read_key,
        kind: kind.as_str().to_string(),
        sig,
    };
    let head_json = serde_json::to_vec(&head).map_err(|e| format!("head: {e}"))?;
    let head = pin_crypto::seal_raw(sealing.channel_key, &head_json)?;

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
pub fn open(
    channel_key: &[u8; 32],
    blob: &str,
    kind: Kind,
    signer: Signer,
) -> Result<Opened, String> {
    let bytes = pin_crypto::b64_decode(blob).ok_or("object is not base64")?;
    match bytes.first() {
        Some(&OBJECT_VERSION) => {
            let (content, body) = read_head(channel_key, &bytes[1..], kind, signer)?;
            Ok(Opened {
                payload: pin_crypto::open_raw(&content.key, body)?,
                content,
            })
        }
        Some(v) => Err(format!("unsupported object version {v}")),
        None => Err("object is empty".into()),
    }
}

/// The content key an object was sealed under, read from its head alone.
///
/// For a caller that holds an object only to learn how to open the channel's other
/// artifacts: a cached manifest, read for the key to its doc's ticket or to a comment's
/// seal. The body is left sealed, so asking costs a head rather than a manifest.
///
/// Verified like any other read, and this one most of all: a forged head could hand its
/// reader a content key of the forger's choosing, and everything opened with it after.
pub fn content_key(
    channel_key: &[u8; 32],
    blob: &str,
    kind: Kind,
    signer: Signer,
) -> Result<ContentKey, String> {
    let bytes = pin_crypto::b64_decode(blob).ok_or("object is not base64")?;
    match bytes.first() {
        Some(&OBJECT_VERSION) => {
            read_head(channel_key, &bytes[1..], kind, signer).map(|(content, _)| content)
        }
        Some(v) => Err(format!("unsupported object version {v}")),
        None => Err("object is empty".into()),
    }
}

/// A fingerprint of what an object would hold: its substance, and how it is sealed.
///
/// For a publisher that skips an upload when nothing moved. A seal draws a fresh nonce, so
/// the sealed bytes differ every time and cannot be compared; the substance alone is not
/// enough either, because an object whose sealing changed has to be published again with
/// nothing in it having moved — a new format, a new epoch, or a read key taken out of the
/// head when a channel stops being readable by whoever holds K.
pub fn fingerprint(sealing: &Sealing, substance: &str) -> String {
    pin_crypto::content_hash(
        format!(
            "{OBJECT_VERSION}|{}|{}|{substance}",
            sealing.content.epoch, sealing.publish_read_key as u8
        )
        .as_bytes(),
    )
}

/// Open an object whose head carries no read key, with a content key the caller holds.
///
/// The path for a reader who learned C some other way — the author, who derives it, or a
/// member, who unwrapped it — and for what is sealed only for C-holders in the first place.
/// Refuses a key for another epoch rather than trying it: an object sealed after a rotation
/// is one a key from before it must not be reported as failing to open for some other
/// reason.
pub fn open_with(
    channel_key: &[u8; 32],
    blob: &str,
    content: &ContentKey,
    kind: Kind,
    signer: Signer,
) -> Result<Vec<u8>, String> {
    let bytes = pin_crypto::b64_decode(blob).ok_or("object is not base64")?;
    match bytes.first() {
        Some(&OBJECT_VERSION) => {
            let (head, body) = split_head(channel_key, &bytes[1..], kind, signer)?;
            if head.epoch != content.epoch {
                return Err(format!(
                    "sealed at epoch {}, key is for epoch {}",
                    head.epoch, content.epoch
                ));
            }
            pin_crypto::open_raw(&content.key, body)
        }
        Some(v) => Err(format!("unsupported object version {v}")),
        None => Err("object is empty".into()),
    }
}

/// Open the head of a layered object and work out its content key from it, answering with
/// the still-sealed body beside it.
fn read_head<'b>(
    channel_key: &[u8; 32],
    rest: &'b [u8],
    kind: Kind,
    signer: Signer,
) -> Result<(ContentKey, &'b [u8]), String> {
    let (head, body) = split_head(channel_key, rest, kind, signer)?;
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

/// Open a layered object's head and check it, answering with it and the still-sealed body.
///
/// THE ONE PLACE A HEAD IS READ, so the one place it is checked: every open goes through
/// here, and none can skip the signature by taking another path. Kind first, then the
/// signature, both before anything in the head is believed.
fn split_head<'b>(
    channel_key: &[u8; 32],
    rest: &'b [u8],
    kind: Kind,
    signer: Signer,
) -> Result<(Head, &'b [u8]), String> {
    let (head, body) = unverified_head(channel_key, rest)?;
    if head.kind != kind.as_str() {
        return Err(format!(
            "object is a {}, not a {}",
            head.kind,
            kind.as_str()
        ));
    }
    let Signer::Author(author) = signer;
    let message = signing_bytes(
        &pin_crypto::channel_id(channel_key),
        &head.kind,
        head.epoch,
        head.read_key.as_deref(),
        body,
    );
    pin_pkarr::verify_detached(author, &message, &head.sig)
        .map_err(|_| "object is not signed by its channel's author".to_string())?;
    Ok((head, body))
}

/// A layered object's head as it stands, before any check.
fn unverified_head<'b>(channel_key: &[u8; 32], rest: &'b [u8]) -> Result<(Head, &'b [u8]), String> {
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
    Ok((head, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: [u8; 32] = [7u8; 32];
    const C: ContentKey = ContentKey {
        epoch: 3,
        key: [9u8; 32],
    };

    const SIGNER: [u8; 32] = [11u8; 32];
    /// SIGNER's did:dht key.
    fn author() -> String {
        pin_pkarr::public_key_from_seed(&SIGNER).unwrap()
    }

    fn content_key_of(blob: &str) -> Result<ContentKey, String> {
        content_key(&K, blob, Kind::Manifest, Signer::Author(&author()))
    }

    fn sealing(publish_read_key: bool) -> Sealing<'static> {
        Sealing {
            channel_key: &K,
            content: C,
            publish_read_key,
            signer: SIGNER,
        }
    }

    #[test]
    fn an_object_opens_with_k_and_reports_its_content_key() {
        let blob = seal(&sealing(true), Kind::Manifest, b"payload").unwrap();
        let opened = open(&K, &blob, Kind::Manifest, Signer::Author(&author())).unwrap();
        assert_eq!(opened.payload, b"payload");
        assert_eq!(opened.content, C);
    }

    #[test]
    fn the_body_is_sealed_under_c_and_not_k() {
        // Sealed as a member-only object, then given the read key by hand: if the body
        // were under K, K alone would open it, which is the property the split exists to
        // remove.
        let blob = seal(&sealing(false), Kind::Manifest, b"payload").unwrap();
        let bytes = pin_crypto::b64_decode(&blob).unwrap();
        let len = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
        let body = &bytes[5 + len..];
        assert!(pin_crypto::open_raw(&K, body).is_err());
        assert_eq!(pin_crypto::open_raw(&C.key, body).unwrap(), b"payload");
    }

    #[test]
    fn an_object_without_a_read_key_does_not_open_with_k() {
        let blob = seal(&sealing(false), Kind::Manifest, b"payload").unwrap();
        let err = open(&K, &blob, Kind::Manifest, Signer::Author(&author())).unwrap_err();
        assert!(err.contains("no read key for epoch 3"), "{err}");
    }

    #[test]
    fn an_object_does_not_open_with_the_wrong_k() {
        let blob = seal(&sealing(true), Kind::Manifest, b"payload").unwrap();
        let mut wrong = K;
        wrong[0] ^= 1;
        assert!(open(&wrong, &blob, Kind::Manifest, Signer::Author(&author())).is_err());
    }

    #[test]
    fn the_content_key_is_read_from_the_head_alone() {
        let blob = seal(&sealing(true), Kind::Manifest, b"payload").unwrap();
        assert_eq!(content_key_of(&blob).unwrap(), C);
        // A damaged body leaves the head unverifiable, since the signature covers the body's
        // digest: a key is never handed out from an object that has been tampered with.
        let mut bytes = pin_crypto::b64_decode(&blob).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        let damaged = pin_crypto::b64_encode(&bytes);
        assert!(content_key_of(&damaged).is_err());

        let mut wrong = K;
        wrong[0] ^= 1;
        assert!(content_key(&wrong, &blob, Kind::Manifest, Signer::Author(&author())).is_err());
        assert!(
            content_key_of(&seal(&sealing(false), Kind::Manifest, b"payload").unwrap()).is_err()
        );
    }

    #[test]
    fn an_object_with_no_read_key_opens_with_a_held_content_key() {
        let blob = seal(&sealing(false), Kind::Manifest, b"payload").unwrap();
        assert_eq!(
            open_with(&K, &blob, &C, Kind::Manifest, Signer::Author(&author())).unwrap(),
            b"payload"
        );
        // A key for another epoch is refused by its epoch, before the body is tried.
        let other = ContentKey { epoch: 4, ..C };
        let err =
            open_with(&K, &blob, &other, Kind::Manifest, Signer::Author(&author())).unwrap_err();
        assert!(err.contains("sealed at epoch 3"), "{err}");
        // And the right epoch with the wrong key does not open.
        let wrong = ContentKey {
            key: [1u8; 32],
            ..C
        };
        assert!(open_with(&K, &blob, &wrong, Kind::Manifest, Signer::Author(&author())).is_err());
    }

    /// The head as sealed, opened with K, and its body's sealed bytes.
    fn head_and_body(blob: &str) -> (Head, Vec<u8>) {
        let bytes = pin_crypto::b64_decode(blob).unwrap();
        let (head, body) = unverified_head(&K, &bytes[1..]).unwrap();
        (head, body.to_vec())
    }

    #[test]
    fn the_head_is_signed_by_the_author_over_what_it_says() {
        let author = pin_pkarr::public_key_from_seed(&SIGNER).unwrap();
        let channel = pin_crypto::channel_id(&K);
        let blob = seal(&sealing(true), Kind::Tallies, b"payload").unwrap();
        let (head, body) = head_and_body(&blob);
        assert_eq!(head.kind, "tallies");
        let message = signing_bytes(&channel, "tallies", 3, head.read_key.as_deref(), &body);
        assert!(pin_pkarr::verify_detached(&author, &message, &head.sig).is_ok());

        // Each thing the signature covers moves it: another kind, epoch, channel, read key
        // or body all fail against the same signature.
        for wrong in [
            signing_bytes(&channel, "manifest", 3, head.read_key.as_deref(), &body),
            signing_bytes(&channel, "tallies", 4, head.read_key.as_deref(), &body),
            signing_bytes("elsewhere", "tallies", 3, head.read_key.as_deref(), &body),
            signing_bytes(&channel, "tallies", 3, None, &body),
            signing_bytes(&channel, "tallies", 3, head.read_key.as_deref(), b"other"),
        ] {
            assert!(pin_pkarr::verify_detached(&author, &wrong, &head.sig).is_err());
        }
        // And somebody else's key does not verify it.
        let stranger = pin_pkarr::public_key_from_seed(&[12u8; 32]).unwrap();
        assert!(pin_pkarr::verify_detached(&stranger, &message, &head.sig).is_err());
    }

    #[test]
    fn a_read_requires_the_author_and_the_kind() {
        let blob = seal(&sealing(true), Kind::Tallies, b"payload").unwrap();
        assert!(open(&K, &blob, Kind::Tallies, Signer::Author(&author())).is_ok());
        // Somebody else's did, prefixed or bare.
        let stranger = pin_pkarr::public_key_from_seed(&[12u8; 32]).unwrap();
        assert!(open(&K, &blob, Kind::Tallies, Signer::Author(&stranger)).is_err());
        let prefixed = format!("did:dht:{}", author());
        assert!(open(&K, &blob, Kind::Tallies, Signer::Author(&prefixed)).is_ok());
        // The author's genuine object, asked for as another kind.
        let err = open(&K, &blob, Kind::Manifest, Signer::Author(&author())).unwrap_err();
        assert!(err.contains("not a manifest"), "{err}");
        // A head re-signed by a stranger over the same bytes.
        let forged = Sealing {
            signer: [12u8; 32],
            ..sealing(true)
        };
        let forged = seal(&forged, Kind::Tallies, b"payload").unwrap();
        assert!(open(&K, &forged, Kind::Tallies, Signer::Author(&author())).is_err());
    }

    #[test]
    fn a_kind_round_trips_through_its_name() {
        for kind in [
            Kind::Manifest,
            Kind::Tallies,
            Kind::Conversations,
            Kind::DocValue,
            Kind::Members,
        ] {
            assert_eq!(Kind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(Kind::parse("other"), None);
    }

    #[test]
    fn a_version_1_envelope_is_refused() {
        let blob = pin_crypto::encrypt(&K, b"payload").unwrap();
        assert!(open(&K, &blob, Kind::Manifest, Signer::Author(&author())).is_err());
        assert!(content_key(&K, &blob, Kind::Manifest, Signer::Author(&author())).is_err());
    }

    #[test]
    fn a_fingerprint_moves_with_the_sealing_and_not_with_the_nonce() {
        let base = fingerprint(&sealing(true), "s");
        assert_eq!(base, fingerprint(&sealing(true), "s"));
        assert_ne!(base, fingerprint(&sealing(true), "t"));
        assert_ne!(base, fingerprint(&sealing(false), "s"));
        let later = Sealing {
            content: ContentKey { epoch: 4, ..C },
            ..sealing(true)
        };
        assert_ne!(base, fingerprint(&later, "s"));
    }

    #[test]
    fn the_head_carries_only_the_epoch_and_the_read_key() {
        // Whatever the head holds, anyone who can find the channel can read. Asserted on
        // the key set so a field added here is a decision rather than a side effect.
        let blob = seal(&sealing(true), Kind::Manifest, b"payload").unwrap();
        let bytes = pin_crypto::b64_decode(&blob).unwrap();
        let len = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
        let head = pin_crypto::open_raw(&K, &bytes[5..5 + len]).unwrap();
        let head: serde_json::Value = serde_json::from_slice(&head).unwrap();
        let mut keys: Vec<&String> = head.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["epoch", "kind", "readKey", "sig"]);

        let blob = seal(&sealing(false), Kind::Manifest, b"payload").unwrap();
        let bytes = pin_crypto::b64_decode(&blob).unwrap();
        let len = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
        let head = pin_crypto::open_raw(&K, &bytes[5..5 + len]).unwrap();
        let head: serde_json::Value = serde_json::from_slice(&head).unwrap();
        let mut keys: Vec<&String> = head.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["epoch", "kind", "sig"]);
    }

    #[test]
    fn a_truncated_object_is_refused_rather_than_misread() {
        let blob = seal(&sealing(true), Kind::Manifest, b"payload").unwrap();
        let bytes = pin_crypto::b64_decode(&blob).unwrap();
        for cut in [1, 3, 5, 20] {
            let short = pin_crypto::b64_encode(&bytes[..cut]);
            assert!(
                open(&K, &short, Kind::Manifest, Signer::Author(&author())).is_err(),
                "cut at {cut}"
            );
        }
    }
}
