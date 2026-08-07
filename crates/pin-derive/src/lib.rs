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

// --- App-level derivations ---------------------------------------------------
//
// Every secret Pin holds below the root is HKDF-SHA256 off one of two IKMs, with a
// domain-separated `info`:
//
//   * the Sia AppKey — recoverable from the recovery phrase, so anything derived from
//     it is recoverable too. That's the whole recovery story: one phrase reconstructs
//     the identity, the settings key, and every locator.
//   * a channel key K — used where a READER must derive the same value holding only K
//     from a subscribe URL (the channel locator and the channel-doc ticket key). K both
//     locates and decrypts.
//
// They live here rather than beside their callers because they're the definition of a
// value two engines must agree on, which is this crate's rule. `pin:did-dht:v1` is the
// sharpest case: it was written out twice — once in TypeScript, once in the Curator's
// identity.rs — under a comment saying the two MUST match byte-for-byte. A comment is
// not an enforcement mechanism, and a drift there would split a user's browser identity
// from their Curator's.
//
// Changing an `info` re-keys every user out of whatever it protects, so the tests below
// lock the three that have published values.

/// HKDF `info` for the settings-record encryption key (AppKey-derived, never shared).
pub const SETTINGS_KEY_INFO: &[u8] = b"pin:settings:v1";
/// HKDF `info` for the whole-doc Sia snapshot encryption key (AppKey-derived).
pub const SNAPSHOT_KEY_INFO: &[u8] = b"pin:docsnapshot:v1";
/// HKDF `info` for the publish-state encryption key (AppKey-derived, never shared).
/// Publish state names Sia objects by share URL, and a share URL carries that
/// object's encryption key in its fragment — so these records are as secret as the
/// content they point at, and get their own domain rather than riding the settings key.
pub const PUBLISHED_KEY_INFO: &[u8] = b"pin:published:v1";
/// HKDF `info` for the identity's did:dht ed25519 seed (AppKey-derived).
pub const DID_DHT_INFO: &[u8] = b"pin:did-dht:v1";
/// HKDF `info` for a channel's pkarr locator key — derived from K, not the AppKey,
/// because a subscriber holding only K must reach the same key.
pub const CHANNEL_LOCATOR_INFO: &[u8] = b"pin:channel-locator:v1";
/// HKDF `info` PREFIX for a channel's iroh-docs namespace seed; the channelID is
/// appended. AppKey-derived on purpose — a namespace secret IS the write capability,
/// so deriving it from K would hand every subscriber the ability to write.
pub const CHANNEL_DOC_NS_INFO_PREFIX: &str = "pin:channel-doc-ns:v1:";
/// HKDF `info` for the pkarr key carrying a channel's read DocTicket (K-derived, so a
/// subscriber can find it — kept separate from the locator so a stale ticket can never
/// disturb the durable pointer).
pub const CHANNEL_DOC_TICKET_INFO: &[u8] = b"pin:channel-doc:v1";
/// HKDF `info` for the pkarr key holding the pointer to your settings snapshot.
pub const SETTINGS_LOCATOR_INFO: &[u8] = b"pin:settings-locator:v1";
/// HKDF `info` for the instance-rendezvous pkarr key (where your instances advertise
/// their DocTickets to find each other).
pub const RENDEZVOUS_INFO: &[u8] = b"pin:iroh-rendezvous:v1";
/// HKDF `info` PREFIX for a single instance's rendezvous key; the instance id is
/// appended. Derived from the RENDEZVOUS seed rather than the AppKey, so the directory
/// stays private to your own instances.
pub const RENDEZVOUS_INSTANCE_INFO_PREFIX: &str = "pin:iroh-rendezvous-instance:v1:";

/// The settings-record encryption key.
pub fn settings_key(app_key: &[u8]) -> [u8; 32] {
    hkdf32(app_key, SETTINGS_KEY_INFO)
}

/// The Sia snapshot encryption key.
pub fn snapshot_key(app_key: &[u8]) -> [u8; 32] {
    hkdf32(app_key, SNAPSHOT_KEY_INFO)
}

/// The publish-state encryption key.
pub fn published_key(app_key: &[u8]) -> [u8; 32] {
    hkdf32(app_key, PUBLISHED_KEY_INFO)
}

/// The identity's did:dht ed25519 seed.
pub fn did_dht_seed(app_key: &[u8]) -> [u8; 32] {
    hkdf32(app_key, DID_DHT_INFO)
}

/// A channel's pkarr locator seed, from its channel key K.
pub fn channel_locator_seed(channel_key: &[u8]) -> [u8; 32] {
    hkdf32(channel_key, CHANNEL_LOCATOR_INFO)
}

/// A channel's iroh-docs namespace seed, from the AppKey plus the channelID.
pub fn channel_doc_seed(app_key: &[u8], channel_id: &str) -> [u8; 32] {
    hkdf32(
        app_key,
        format!("{CHANNEL_DOC_NS_INFO_PREFIX}{channel_id}").as_bytes(),
    )
}

/// The pkarr seed for a channel's read-DocTicket record, from its channel key K.
pub fn channel_doc_ticket_seed(channel_key: &[u8]) -> [u8; 32] {
    hkdf32(channel_key, CHANNEL_DOC_TICKET_INFO)
}

/// The pkarr seed for your settings-snapshot pointer.
pub fn settings_locator_seed(app_key: &[u8]) -> [u8; 32] {
    hkdf32(app_key, SETTINGS_LOCATOR_INFO)
}

/// The pkarr seed for your instance-rendezvous directory.
pub fn rendezvous_seed(app_key: &[u8]) -> [u8; 32] {
    hkdf32(app_key, RENDEZVOUS_INFO)
}

/// The pkarr seed for one instance's entry, from the rendezvous seed plus its id.
pub fn rendezvous_instance_seed(rendezvous_seed: &[u8], instance_id: &str) -> [u8; 32] {
    hkdf32(
        rendezvous_seed,
        format!("{RENDEZVOUS_INSTANCE_INFO_PREFIX}{instance_id}").as_bytes(),
    )
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

/// Encode 32 bytes as a 64-char lowercase hex string — the inverse of
/// [`decode_hex32`], and kept beside it so the two cannot drift into disagreeing
/// about case or padding. Used when a secret leaves an engine for the app to
/// persist, the direction the decoder's callers eventually read back.
pub fn encode_hex32(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Decode the 32-byte Sia AppKey from its 64-char hex form (the HKDF IKM). Named
/// separately from [`decode_hex32`] so the call site says which secret it is.
pub fn decode_app_key(hex: &str) -> Option<[u8; 32]> {
    decode_hex32(hex)
}

/// The collection holding publish state — what this identity last published to Sia,
/// so the superseded object can be reclaimed and the current one kept alive.
pub const PUBLISHED_COLLECTION: &str = "published";

/// The collection where each of this identity's live instances registers itself,
/// keyed by its iroh node id.
///
/// One identity is reachable at as many endpoints as it has devices, and each device
/// mints its own node key — so "where can I be dialed" is a set, not a value. Keeping
/// that set in the doc is what lets ANY instance publish the whole set: the thing that
/// made two writers clobber each other was that neither could see the other.
pub const INSTANCE_COLLECTION: &str = "instance";

/// The rkey for one channel's publish state.
///
/// Prefixed so channels can't collide with the identity-level publishers that share
/// this collection. Here rather than beside either caller because the frontend writes
/// these records and the keep-alive loop reads them: a divergence wouldn't error, it
/// would just find nothing, and a locator nobody republishes ages off the DHT until
/// the channel stops resolving for its subscribers.
pub fn published_channel_rkey(channel_id: &str) -> String {
    format!("channel:{channel_id}")
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

/// Split a record key back into `(collection, rkey)` — the inverse of
/// [`record_key`]. `None` when the key isn't a record key (no separator, or an
/// empty half).
///
/// Shared for the same reason `record_key` is, one step further along: the doc-change
/// stream reports which record moved, and the frontend ROUTES on the collection to
/// decide what to re-read. Two implementations of this split could disagree about a
/// key containing a slash and quietly send changes to the wrong handler — or to none —
/// on one platform only. Splitting at the FIRST separator is what makes it the exact
/// inverse: collections never contain `/`, rkeys are free to.
pub fn parse_record_key(key: &str) -> Option<(&str, &str)> {
    let (collection, rkey) = key.split_once('/')?;
    if collection.is_empty() || rkey.is_empty() {
        return None;
    }
    Some((collection, rkey))
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
    fn hex32_round_trips() {
        let bytes: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(3));
        let hex = encode_hex32(&bytes);
        assert_eq!(hex.len(), 64);
        assert_eq!(hex, hex.to_lowercase());
        assert_eq!(decode_hex32(&hex), Some(bytes));
    }

    #[test]
    fn hex32_pads_low_bytes() {
        // A byte under 0x10 must still occupy two chars, or every later offset shifts.
        assert_eq!(encode_hex32(&[0u8; 32]), "0".repeat(64));
        let mut bytes = [0u8; 32];
        bytes[31] = 0x0f;
        assert_eq!(decode_hex32(&encode_hex32(&bytes)), Some(bytes));
    }

    #[test]
    fn a_channels_publish_state_is_prefixed_and_parseable() {
        // Prefixed, so a channel whose id happens to read like an identity-level
        // publisher's rkey can't take its record.
        assert_eq!(published_channel_rkey("abc"), "channel:abc");
        assert_ne!(published_channel_rkey("directory"), "directory");
        // And it survives the round-trip through a record key, which is what the
        // keep-alive loop does to find it.
        let key = record_key(PUBLISHED_COLLECTION, &published_channel_rkey("abc"));
        let key = String::from_utf8(key).unwrap();
        assert_eq!(
            parse_record_key(&key),
            Some((PUBLISHED_COLLECTION, "channel:abc"))
        );
    }

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
    fn parse_record_key_inverts_record_key() {
        for (collection, rkey) in [
            ("settings", "self"),
            ("sub", "abc123"),
            ("channel", "xyz"),
            // The marker's collection is dotted — dots are not separators.
            ("dev.sia.pin.marker", "self"),
        ] {
            let key = String::from_utf8(record_key(collection, rkey)).unwrap();
            assert_eq!(parse_record_key(&key), Some((collection, rkey)));
        }
    }

    #[test]
    fn parse_record_key_splits_at_the_first_separator() {
        // An rkey containing a slash still round-trips, because the split is at the
        // FIRST one. Getting this backwards would route such a record to a
        // collection that doesn't exist.
        let key = String::from_utf8(record_key("sub", "a/b")).unwrap();
        assert_eq!(parse_record_key(&key), Some(("sub", "a/b")));
    }

    #[test]
    fn parse_record_key_rejects_non_records() {
        assert_eq!(parse_record_key("settings"), None);
        assert_eq!(parse_record_key(""), None);
        assert_eq!(parse_record_key("/self"), None);
        assert_eq!(parse_record_key("sub/"), None);
    }

    fn hex(bytes: &[u8; 32]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    // The three derivations with published vectors, locked against the SAME expected
    // values the TypeScript suite asserts (src/core/crypto.test.ts). That's the point
    // of the exercise: two implementations, one set of vectors, so a divergence is a
    // test failure rather than a user locked out of their own data.
    #[test]
    fn settings_key_matches_the_locked_vector() {
        assert_eq!(
            hex(&settings_key(&[0u8; 32])),
            "4f2fe2ca11018b920f3f99673cae4afab82044351d3de01a784a598d1b199aa2"
        );
    }

    #[test]
    fn did_dht_seed_matches_the_locked_vector() {
        // Also what identity.rs derives — the duplication this crate exists to remove.
        assert_eq!(
            hex(&did_dht_seed(&[0u8; 32])),
            "30ff7f7764196617f118404f0b5b1c98298adf7aafcd54a86c92173d06682256"
        );
    }

    #[test]
    fn channel_locator_seed_matches_the_locked_vector() {
        // IKM here is a channel key K, not the AppKey — the reader-side derivation.
        assert_eq!(
            hex(&channel_locator_seed(&[0u8; 32])),
            "78aa2d69cfe77badc0d0d7cd976e0c1b6c3fe4964958145793d153b03a3442eb"
        );
    }

    #[test]
    fn every_derivation_is_domain_separated() {
        // Same IKM through each derivation must give a different key; a collision
        // would mean one secret's compromise leaked another's.
        let ikm = [7u8; 32];
        let all = [
            settings_key(&ikm),
            snapshot_key(&ikm),
            published_key(&ikm),
            did_dht_seed(&ikm),
            channel_locator_seed(&ikm),
            channel_doc_seed(&ikm, "chan"),
            channel_doc_ticket_seed(&ikm),
            settings_locator_seed(&ikm),
            rendezvous_seed(&ikm),
            rendezvous_instance_seed(&ikm, "inst"),
        ];
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i], all[j], "derivations {i} and {j} collide");
            }
        }
    }

    #[test]
    fn per_id_derivations_vary_by_id() {
        let ikm = [3u8; 32];
        assert_ne!(channel_doc_seed(&ikm, "a"), channel_doc_seed(&ikm, "b"));
        assert_ne!(
            rendezvous_instance_seed(&ikm, "a"),
            rendezvous_instance_seed(&ikm, "b")
        );
    }

    #[test]
    fn decode_app_key_rejects_bad_hex() {
        assert!(decode_app_key("00").is_none());
        assert!(decode_app_key(&"z".repeat(64)).is_none());
        assert_eq!(decode_app_key(&"00".repeat(32)), Some([0u8; 32]));
    }
}
