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
/// HKDF `info` for the pin-record encryption key (AppKey-derived, never shared).
/// Same reasoning as publish state: a pin record names its Sia object by share URL,
/// and a share URL carries that object's decryption key in its fragment.
pub const PINNED_KEY_INFO: &[u8] = b"pin:pinned:v1";
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
/// HKDF `info` for the pkarr key carrying a channel's published tallies (K-derived,
/// like the locator, so the audience for a count is exactly the audience for the
/// channel — anyone who can open the manifest can find the counts, and anyone who
/// can't, can't. That is what keeps an unlisted channel's engagement unlisted too.)
///
/// Its own record rather than riding the locator's packet, for two reasons. A BEP44
/// packet is ~1000 bytes and one chunked Sia URL already costs 250-320 of them, so two
/// would sit uncomfortably close to the ceiling. And the keep-alive re-signs the
/// locator: sharing one record would mean every tally publish rewrote the manifest
/// pointer, and every keep-alive rewrote the tally pointer.
pub const ENGAGEMENT_LOCATOR_INFO: &[u8] = b"pin:engagement:v1";
/// HKDF `info` for the pkarr key holding the pointer to your settings snapshot.
pub const SETTINGS_LOCATOR_INFO: &[u8] = b"pin:settings-locator:v1";
/// The TXT-record prefix the settings locator's pointer is chunked under. Here rather
/// than beside either caller because the frontend PUBLISHES this record and the
/// Curator's keep-alive REPUBLISHES it: a divergence wouldn't error, it would write the
/// pointer under a name the reader never looks for, and recovery would find nothing.
pub const SETTINGS_POINTER_PREFIX: &str = "_s";
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

/// The pin-record encryption key.
pub fn pinned_key(app_key: &[u8]) -> [u8; 32] {
    hkdf32(app_key, PINNED_KEY_INFO)
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

/// The pkarr seed for a channel's published tallies, from its channel key K.
pub fn engagement_locator_seed(channel_key: &[u8]) -> [u8; 32] {
    hkdf32(channel_key, ENGAGEMENT_LOCATOR_INFO)
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

/// The collection holding what this identity keeps — one record per pin.
///
/// One record each rather than one list, for two reasons. A pin carries the item's
/// whole `ItemRef` (a text item's body included), so a list would be a large blob
/// rewritten on every pin. And per-pin records MERGE BY UNION across devices: pin
/// something on a laptop and something else on a phone and both survive, where a
/// single list record would be last-writer-wins and one of them would vanish.
pub const PINNED_COLLECTION: &str = "pin";

/// The rkey for one pin: the logical item it keeps.
///
/// Deliberately NOT the itemURL or the object id, both of which repack rewrites — a
/// key that moved when bytes were repacked would orphan the record it names. This is
/// the same `(channelID, publishedAt)` identity the rest of the app already joins on:
/// drift detection, the pin-state hook, and `edit_item`, which preserves `publishedAt`
/// across an edit precisely so the logical post survives its bytes changing.
pub fn pinned_rkey(channel_id: &str, published_at: &str) -> String {
    format!("{channel_id}:{published_at}")
}

/// The collection holding the endorsements this identity has made — one signed record
/// each, which the identity loop folds into the public directory.
///
/// Its own collection rather than a field in settings, for two reasons that both bite.
/// Settings is the 128 KiB fixed-pad record, so a few hundred endorsements would hit a
/// ceiling that errors loudly by design. And settings is the one record that exists to
/// be private, where these are published.
///
/// Per-record for the same reason pins are: they merge by UNION across this identity's
/// devices, where a single list would be last-writer-wins and one device's endorsements
/// would vanish.
pub const ENDORSE_COLLECTION: &str = "endorse";

/// The rkey for one endorsement: its kind, then the subject it is about.
///
/// The kind is IN the key because both gestures are available on the same post — you can
/// heart something and also pin it — so keying on the subject alone would make one
/// overwrite the other. Kind first so a prefix scan can list one gesture at a time.
///
/// The subject is already a hash, so this leaks nothing beyond what the record does.
pub fn endorse_rkey(kind: &str, subject: &str) -> String {
    format!("{kind}:{subject}")
}

/// The collection holding what OTHERS have endorsed about this identity's items — the
/// signed records a published count is folded from.
///
/// Lives in this identity's own doc and is never served to subscribers, unlike the tally
/// derived from it. The distinction is the point: the tally is one small entry per subject
/// that syncs to everyone reading a channel, while the set behind it grows with reality
/// and would otherwise be replicated in full to every reader. It is produced on demand
/// instead — the receipts, not the poster.
///
/// A rebuildable cache, not authored truth: every record in here came from its actor's own
/// directory and can be re-read from there. Losing it costs a crawl, not a fact.
pub const ENGAGEMENT_LOG_COLLECTION: &str = "engagement-log";

/// One held record: the subject, then the gesture, then who asserted it.
///
/// Subject first so a prefix scan gathers everything about one item — which is how a
/// tally is folded. Then the kind, for the reason `endorse_rkey` states on the writing
/// side: both gestures are available on the same post, so a key without it makes one
/// person's like and pin the same record, and whichever arrives second takes the other's
/// place. That costs the displaced gesture an actor, silently — including on your own
/// post, where publishing writes a pin and liking it would then displace that pin.
///
/// The actor goes last because a `did:dht:…` string carries colons of its own, so it is
/// the only field that can absorb the remainder.
pub fn engagement_log_rkey(subject: &str, kind: &str, actor: &str) -> String {
    format!("{subject}:{kind}:{actor}")
}

/// Split a held record's key back into its subject, kind and actor.
///
/// Left to right at the first two separators: a subject is base32 and a kind is a bare
/// word, so neither carries a colon, and everything after the second belongs to the actor.
/// Here beside the builder so the two can't disagree — the crawl writes with one and
/// decides what to withdraw with the other, and a mismatch would make it drop records it
/// should keep.
///
/// The actor still has to look like a DID, because two fields here can absorb the wrong
/// text without anything looking amiss: a key missing its kind reads as a kind of `did`
/// and an actor of `dht:x`. That parse succeeds and is wrong, which is worse than one that
/// fails — the crawl decides what to DELETE from this, so a plausible misreading is how a
/// live record gets dropped.
pub fn parse_engagement_log_rkey(rkey: &str) -> Option<(&str, &str, &str)> {
    let (subject, rest) = rkey.split_once(':')?;
    let (kind, actor) = rest.split_once(':')?;
    if subject.is_empty() || kind.is_empty() || !actor.starts_with("did:") {
        return None;
    }
    Some((subject, kind, actor))
}

/// The collection holding the published tally for each subject, in the CHANNEL's doc.
///
/// There rather than here because that doc is the one subscribers already sync, and its
/// namespace derives from the author's AppKey — so the author writes and a subscriber
/// holds a read capability, which is the substrate enforcing "the engager owns their act,
/// the publisher owns their surface". A count arrives live over the same rung that
/// delivers a new post.
pub const ENGAGEMENT_COLLECTION: &str = "engagement";

/// The collection where a tally is cached for READING, in this identity's own doc.
///
/// The published tally lives in the channel's doc ([`ENGAGEMENT_COLLECTION`]) and, for
/// anyone without that replica, in the channel's tallies object on Sia. Neither is
/// somewhere a screen can read directly: a subscriber only learns a channel doc's
/// namespace by importing its ticket, and the Sia object is a per-channel map behind a
/// DHT resolve and a download. So both rungs land at this one address, and a row reads
/// that — the same arrangement `sub/<channelID>` gives a manifest.
///
/// Plaintext, like the endorsements it counts. The published copy is plaintext in a doc
/// every subscriber holds, so sealing a private cache of it would protect nothing.
pub const TALLY_COLLECTION: &str = "tally";

/// The rkey for one cached tally: the channel, then the subject it is about.
///
/// Qualified by channel although the subject is already unique — it is a hash over
/// `(channel, item)` — so that unsubscribing can drop a channel's cached tallies by
/// prefix, the way the manifest cache is dropped by channel id. Nothing is given away
/// by naming the channel here that `sub/<channelID>` in the same doc does not already
/// name; the concealment that matters is on the PUBLISHED record, which carries the
/// subject hash alone.
pub fn tally_rkey(channel_id: &str, subject: &str) -> String {
    format!("{channel_id}:{subject}")
}

/// The channel a cached tally belongs to, for dropping a channel's cache wholesale.
pub fn tally_rkey_channel(rkey: &str) -> Option<&str> {
    rkey.split_once(':').map(|(channel_id, _)| channel_id)
}

/// The collection recording, per subscribed channel, the tallies pointer the pull loop
/// last read to completion. Keyed by channel id.
///
/// Apart from [`PULL_COLLECTION`] rather than a second field on the manifest's mark,
/// because the two halves succeed independently: a mark is written only after the read
/// it describes lands, and one record holding both would have each half overwriting the
/// other's.
pub const TALLY_PULL_COLLECTION: &str = "tally-pull";

/// The collection recording, per actor, the directory pointer the crawl last read to
/// completion. Keyed by that actor's `did:dht`.
///
/// Sia is content-addressed, so an unchanged share URL is not a hint that the content
/// probably hasn't moved — it is proof that the bytes are identical. That makes the
/// pointer an exact cache validator, and lets a pass confirm an actor's endorsements
/// without downloading their directory again.
///
/// In the doc rather than in loop memory for two reasons: a restart would otherwise
/// re-download the whole graph, and it syncs, so a second device inherits what the first
/// already read instead of repeating it.
pub const CRAWL_COLLECTION: &str = "crawl";

/// The collection recording, per subscribed channel, the manifest pointer the pull loop
/// last cached AND the cached record it produced. Keyed by channel id.
///
/// Both halves, unlike the crawl's mark. The crawl's log has one writer, so an unchanged
/// pointer settles it; a cached manifest has three — this loop, the live-sync rung, and a
/// peer instance's copy of the same record — so the pointer says the SOURCE hasn't moved
/// and the cached hash says nothing has overwritten the result. Skipping on the pointer
/// alone would leave a clobbered cache stale until the author happened to republish.
pub const PULL_COLLECTION: &str = "pull";

/// The collection recording which of this identity's endorsements have been delivered to
/// the identity they are about, keyed by the endorsement's own rkey.
///
/// A crawl only finds what people in your graph endorsed, so an author outside it would
/// never learn of an endorsement at all. Delivery is what reaches them — and this is how a
/// pass knows what it has already sent, so a knock goes once rather than every cadence.
///
/// It records the SIGNATURE that was sent, not merely that something was. An endorsement
/// re-signed against an edited item is a different assertion and has to be delivered
/// again; a mark that only said "sent" could never tell the two apart.
pub const DELIVER_COLLECTION: &str = "deliver";

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

/// The rkey for one channel's TALLY publish state — which Sia object the engagement
/// locator names, and the generation before it.
///
/// Distinct from [`published_channel_rkey`] because a channel now has two published
/// artifacts, each with its own pointer and its own superseded object to reclaim.
/// Sharing one record would make each publish overwrite the other's grace generation,
/// so the object reclaimed would be one a reader could still be resolving.
pub fn published_engagement_rkey(channel_id: &str) -> String {
    format!("engagement:{channel_id}")
}

/// The rkey for the settings snapshot's publish state — which Sia object the settings
/// locator currently names, and the generation before it.
///
/// Unprefixed, like the directory's, because it's identity-level: there is one settings
/// snapshot, not one per anything. Shared for the same reason the channel rkey is: the
/// frontend writes this record when it snapshots, and the keep-alive loop reads it to
/// know what to republish.
pub const PUBLISHED_SETTINGS_RKEY: &str = "settings";

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

/// A record's address, parsed — the owned, serializable form of what
/// [`parse_record_key`] splits out.
///
/// This exists so a whole-doc listing crosses the seam ALREADY SPLIT. Both engines
/// return it (as JSON from wasm, over IPC from the desktop command), which is what
/// keeps the split in one place: before this, each transport did its own
/// `key.indexOf('/')` in TypeScript, duplicating the rule above and less carefully —
/// a key with no separator yielded a mangled collection instead of being rejected.
///
/// The FIELD NAMES are part of the seam, since the frontend destructures them. A test
/// pins the exact serialized keys: a rename here is invisible to both compilers and
/// would surface as `undefined` on one platform only, the way an upload's share URL
/// once did.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordKey {
    /// The collection the record lives in.
    pub collection: String,
    /// The record's key within that collection.
    pub rkey: String,
}

impl RecordKey {
    /// Parse one key, or `None` if it isn't a record key.
    ///
    /// A listing SKIPS what this rejects rather than failing: `list_all` backs the
    /// whole-doc snapshot, and one stray key shouldn't make an identity's settings
    /// unsnapshottable.
    pub fn parse(key: &str) -> Option<Self> {
        let (collection, rkey) = parse_record_key(key)?;
        Some(Self {
            collection: collection.to_string(),
            rkey: rkey.to_string(),
        })
    }
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
    fn a_channels_two_published_artifacts_do_not_share_publish_state() {
        // A channel publishes a manifest AND a tally, each pointing at its own Sia
        // object and each holding its own grace generation. One shared record would
        // mean a tally publish overwrote the manifest's `olderId`, and the object
        // reclaimed next time would be one a reader was still resolving.
        assert_ne!(
            published_channel_rkey("abc"),
            published_engagement_rkey("abc")
        );
        assert_eq!(published_engagement_rkey("abc"), "engagement:abc");
        // Prefixed for the same reason the manifest's is: a channel whose id reads
        // like an identity-level publisher's rkey must not take its record.
        assert_ne!(
            published_engagement_rkey("settings"),
            PUBLISHED_SETTINGS_RKEY
        );
        let key = record_key(PUBLISHED_COLLECTION, &published_engagement_rkey("abc"));
        let key = String::from_utf8(key).unwrap();
        assert_eq!(
            parse_record_key(&key),
            Some((PUBLISHED_COLLECTION, "engagement:abc"))
        );
    }

    #[test]
    fn a_pins_key_survives_the_bytes_it_names_being_repacked() {
        // The whole point of keying on the logical item: repack rewrites a pin's
        // itemURL and object id, and a key built from either would leave the record
        // pointing at a pin that no longer exists under that name.
        let before = pinned_rkey("chan1", "2026-08-09T12:00:00.000Z");
        let after = pinned_rkey("chan1", "2026-08-09T12:00:00.000Z");
        assert_eq!(before, after);
        assert_eq!(before, "chan1:2026-08-09T12:00:00.000Z");
        // Library pins share a channelID, so the timestamp is what separates them.
        assert_ne!(
            pinned_rkey("library", "2026-08-09T12:00:00.000Z"),
            pinned_rkey("library", "2026-08-09T12:00:00.001Z")
        );
        // And it round-trips through a record key, which is how the Curator finds it.
        let key = record_key(PINNED_COLLECTION, &before);
        let key = String::from_utf8(key).unwrap();
        assert_eq!(parse_record_key(&key), Some((PINNED_COLLECTION, &*before)));
    }

    #[test]
    fn an_engagement_log_key_gathers_one_subject_and_separates_its_actors() {
        let subject = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        // Subject first, because folding a tally means scanning everything about one item.
        assert!(engagement_log_rkey(subject, "like", "did:dht:alice").starts_with(subject));
        // And one record per actor: two people endorsing the same thing must not collide,
        // or a count would be short by however many shared a key.
        assert_ne!(
            engagement_log_rkey(subject, "like", "did:dht:alice"),
            engagement_log_rkey(subject, "like", "did:dht:bob")
        );
        // One record per GESTURE too. Without the kind, one person's like and pin were the
        // same key and the second silently replaced the first.
        assert_ne!(
            engagement_log_rkey(subject, "like", "did:dht:alice"),
            engagement_log_rkey(subject, "pin", "did:dht:alice")
        );
        // The same actor re-endorsing overwrites, which is what makes a repeated knock
        // harmless rather than double-counted.
        assert_eq!(
            engagement_log_rkey(subject, "like", "did:dht:alice"),
            engagement_log_rkey(subject, "like", "did:dht:alice")
        );
        // The private log and the published tally are different collections — one is held,
        // the other is served to every subscriber.
        assert_ne!(ENGAGEMENT_LOG_COLLECTION, ENGAGEMENT_COLLECTION);
        // And the crawl's cache is a third thing again: what we last READ, versus what we
        // hold and what we publish. Sharing a name with either would make a prefix scan
        // for one return the others.
        assert_ne!(CRAWL_COLLECTION, ENGAGEMENT_LOG_COLLECTION);
        assert_ne!(CRAWL_COLLECTION, ENGAGEMENT_COLLECTION);
    }

    #[test]
    fn a_cached_tally_key_names_one_item_and_groups_by_channel() {
        let subject = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        let other = "aaxlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";

        // Channel first: unsubscribing drops a channel's cached tallies by prefix, which
        // only works if every one of them starts with the channel.
        assert!(tally_rkey("chan1", subject).starts_with("chan1:"));
        assert_eq!(
            tally_rkey_channel(&tally_rkey("chan1", subject)),
            Some("chan1")
        );

        // Two items in one channel are two records — a shared key would mean one item's
        // count standing in for another's.
        assert_ne!(tally_rkey("chan1", subject), tally_rkey("chan1", other));

        // The cache is its own collection. Sharing a name with the published tally would
        // make a prefix scan for one return the other, and they are not the same thing:
        // one is served to every subscriber, this one is only ever read here.
        assert_ne!(TALLY_COLLECTION, ENGAGEMENT_COLLECTION);
        assert_ne!(TALLY_COLLECTION, ENGAGEMENT_LOG_COLLECTION);

        // A key with no channel is malformed rather than a channel-less tally, so a
        // caller drops it instead of treating the whole thing as a channel id.
        assert_eq!(tally_rkey_channel(subject), None);
    }

    #[test]
    fn an_engagement_log_key_round_trips_an_actor_that_contains_colons() {
        // The case that makes the split direction load-bearing: a did:dht actor carries
        // colons, and splitting at the LAST one would cut the DID in half. The crawl
        // decides what to withdraw from this, so getting it wrong drops live records.
        let subject = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        let actor = "did:dht:iyypk375c71qwjem5isiramudutoogo1t9gogz8f587sfkt9db4o";
        let rkey = engagement_log_rkey(subject, "like", actor);
        assert_eq!(
            parse_engagement_log_rkey(&rkey),
            Some((subject, "like", actor))
        );

        // A key with no kind must not read as one that has it. Parsed loosely it looks
        // like a kind of `did` and an actor of `dht:…`: plausible enough to pass, wrong
        // enough that the crawl would then withdraw against an actor who doesn't exist.
        assert_eq!(
            parse_engagement_log_rkey(&format!("{subject}:{actor}")),
            None
        );

        // And nonsense is rejected rather than half-read.
        assert_eq!(parse_engagement_log_rkey("nocolon"), None);
        assert_eq!(parse_engagement_log_rkey(":actor"), None);
        assert_eq!(parse_engagement_log_rkey("subject:"), None);
        assert_eq!(parse_engagement_log_rkey(&format!(":like:{actor}")), None);
        assert_eq!(
            parse_engagement_log_rkey(&format!("{subject}::{actor}")),
            None
        );
    }

    #[test]
    fn the_identity_level_publishers_cannot_be_taken_by_a_channel() {
        // A channel named "settings" must not land on the settings snapshot's record.
        // The prefix is what guarantees it, so assert the property rather than trust it.
        assert_ne!(
            published_channel_rkey(PUBLISHED_SETTINGS_RKEY),
            PUBLISHED_SETTINGS_RKEY
        );
        assert_eq!(PUBLISHED_SETTINGS_RKEY, "settings");
        // The pointer prefix the frontend publishes under and the keep-alive
        // republishes under. Pinned: a reader looking for `_s` finds nothing if this
        // moves, and "recovery finds nothing" is indistinguishable from "no settings".
        assert_eq!(SETTINGS_POINTER_PREFIX, "_s");
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

    #[test]
    fn record_key_serializes_under_the_names_the_frontend_destructures() {
        // The frontend does `for (const { collection, rkey } of await listAll())`. These
        // two names ARE the seam, and nothing type-checks across it — so assert the
        // exact JSON rather than trusting `rename_all` to leave single-word fields be.
        let json = serde_json::to_string(&RecordKey {
            collection: "settings".into(),
            rkey: "self".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"collection":"settings","rkey":"self"}"#);
    }

    #[test]
    fn record_key_parse_agrees_with_the_borrowed_split() {
        let key = String::from_utf8(record_key("sub", "a/b")).unwrap();
        assert_eq!(
            RecordKey::parse(&key),
            Some(RecordKey {
                collection: "sub".into(),
                rkey: "a/b".into(),
            })
        );
        // What a listing skips. The TypeScript splits this replaced returned
        // `{collection: "setting", rkey: "settings"}` for a separator-less key — a
        // record address invented out of nothing.
        assert_eq!(RecordKey::parse("settings"), None);
        assert_eq!(RecordKey::parse("sub/"), None);
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
            pinned_key(&ikm),
            did_dht_seed(&ikm),
            channel_locator_seed(&ikm),
            channel_doc_seed(&ikm, "chan"),
            channel_doc_ticket_seed(&ikm),
            engagement_locator_seed(&ikm),
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
