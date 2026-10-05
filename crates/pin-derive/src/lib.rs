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
/// HKDF `info` for the identity's X25519 encryption seed (AppKey-derived) — what a box
/// sealed to this identity opens with. Its own domain rather than the did:dht key mapped
/// across, because one key that both signs and decrypts is the reuse that has gone wrong
/// for every protocol that tried it.
pub const ENC_KEY_INFO: &[u8] = b"pin:enc:v1";
/// HKDF `info` for a channel's pkarr locator key — derived from K, not the AppKey,
/// because a subscriber holding only K must reach the same key.
pub const CHANNEL_LOCATOR_INFO: &[u8] = b"pin:channel-locator:v1";
/// HKDF `info` PREFIX for a channel's iroh-docs namespace seed; the channelID is appended.
/// AppKey-derived on purpose — a namespace secret IS the write capability, so deriving it
/// from K would hand every subscriber the ability to write.
///
/// No epoch in it, so the doc stays put when the content key rotates. Moving it would make
/// every member re-import and re-sync the whole doc on every removal, and a removal is what
/// rotates the key; what keeps a removed member out instead is that the doc's values are
/// sealed under the content key, which they no longer hold.
pub const CHANNEL_DOC_NS_INFO_PREFIX: &str = "pin:channel-doc-ns:v1:";
/// HKDF `info` PREFIX for a channel's content key C; the channelID and the epoch are
/// appended.
///
/// C is what decrypts a channel, and K is only what locates it. Splitting the two is what
/// lets reading be granted and withdrawn without renaming the channel: K, and so the
/// channelID and every pointer, stays put while C moves to a new epoch. AppKey-derived so
/// the author never has to store it — every device holding the recovery phrase derives
/// the same C, and nobody without the AppKey can derive the next one.
pub const CHANNEL_CONTENT_INFO_PREFIX: &str = "pin:channel-content:v1:";
/// The epoch every channel starts at. Nothing rotates a content key yet, so every channel
/// is still at this one.
pub const INITIAL_EPOCH: u32 = 0;
/// HKDF `info` for the pkarr key carrying a channel's read DocTicket. Derived from the
/// content key C rather than from K: the ticket reads the whole doc, so finding it has to
/// take what reading the channel takes. Kept separate from the locator so a stale ticket
/// can never disturb the durable pointer.
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
/// HKDF `info` for the pkarr key carrying a channel's published conversations. K-derived
/// like the counts, so the audience for the words is exactly the audience for the post.
///
/// Its own pointer rather than riding the tallies', because the two move at different rates
/// and cost different amounts to move. A count changes whenever anybody likes anything, and
/// each change re-uploads the whole object — so sharing one would re-upload every comment
/// body in a channel every time somebody tapped a heart.
pub const CONVERSATION_LOCATOR_INFO: &[u8] = b"pin:conversation:v1";
/// HKDF `info` for the pkarr key naming the top of a channel's member tree. K-derived, so
/// whoever can find the channel can find its tree, which is everyone who might be a member.
///
/// Its own pointer because it moves on its own schedule: on a join or a removal, and never
/// on a post or a like. A K-holder can rewrite it like any K-derived pointer, which is why
/// the band it names is author-signed and flagged as the top.
pub const MEMBERS_LOCATOR_INFO: &[u8] = b"pin:members:v1";
/// HKDF `info` for the pkarr key holding the pointer to your settings snapshot.
///
/// A device-facing ACCELERANT, and nobody else's business: the seed derives from the
/// AppKey, so no other identity can compute this key and the record has only ever served
/// your own devices. The floor underneath it is the scope walk — the snapshot object
/// carries a tag saying what it is — so this expiring costs a slower boot.
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

/// The identity's X25519 encryption seed.
pub fn enc_key_seed(app_key: &[u8]) -> [u8; 32] {
    hkdf32(app_key, ENC_KEY_INFO)
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

/// A channel's content key C at one epoch, from the AppKey plus the channelID.
///
/// A channelID is base32, so it never contains the `:` that separates it from the epoch
/// and no two (channel, epoch) pairs spell the same `info`.
pub fn channel_content_key(app_key: &[u8], channel_id: &str, epoch: u32) -> [u8; 32] {
    hkdf32(
        app_key,
        format!("{CHANNEL_CONTENT_INFO_PREFIX}{channel_id}:{epoch}").as_bytes(),
    )
}

/// The pkarr seed for a channel's read-DocTicket record, from its content key C.
pub fn channel_doc_ticket_seed(content_key: &[u8]) -> [u8; 32] {
    hkdf32(content_key, CHANNEL_DOC_TICKET_INFO)
}

/// The pkarr seed for a channel's published tallies, from its channel key K.
pub fn engagement_locator_seed(channel_key: &[u8]) -> [u8; 32] {
    hkdf32(channel_key, ENGAGEMENT_LOCATOR_INFO)
}

/// The pkarr seed for a channel's published-conversations pointer.
pub fn conversation_locator_seed(channel_key: &[u8]) -> [u8; 32] {
    hkdf32(channel_key, CONVERSATION_LOCATOR_INFO)
}

/// The pkarr seed for the pointer to the top of a channel's member tree.
pub fn members_locator_seed(channel_key: &[u8]) -> [u8; 32] {
    hkdf32(channel_key, MEMBERS_LOCATOR_INFO)
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

/// The kind and subject an endorsement key names, or `None` when it isn't one.
///
/// Needed because a DELIVERY mark is filed under this same key, and a mark left with no
/// endorsement behind it is how the loop knows a gesture was withdrawn — at which point
/// the key is the only surviving record of what it was about.
///
/// Splits at the FIRST separator, since a subject is a base32 hash and carries none. Both
/// halves are required: a key with no separator would otherwise read as a kind with an
/// empty subject, and what gets built from that is a signed message withdrawing something
/// that doesn't exist.
pub fn parse_endorse_rkey(rkey: &str) -> Option<(&str, &str)> {
    let (kind, subject) = rkey.split_once(':')?;
    if kind.is_empty() || subject.is_empty() {
        return None;
    }
    Some((kind, subject))
}

/// The collection holding the comments this identity has WRITTEN — one signed record each,
/// which the publish loop puts in the object the directory points at.
///
/// Its own collection rather than a third key shape inside `endorse`, and the reason is the
/// shape of the shipped keys rather than tidiness. `endorse_rkey` is `{kind}:{subject}` and
/// a comment needs a per-record discriminator, so sharing the space would mean one parser
/// guessing between two layouts — and both parse functions here already carry warnings that
/// a plausible misparse is worse than a failing one, because what reads these decides what
/// to DELETE. Separate collections cost a constant and keep each parser knowing one shape.
pub const COMMENT_COLLECTION: &str = "comment";

/// The rkey for one HELD comment: the subject, then the comment's own id, then whose it is.
///
/// The actor is here and absent from `comment_rkey` for the same reason the two gesture keys
/// differ: your own collection holds only your own records, and the log holds everybody's.
/// Recovering it from the record instead would cost a read per held comment on every crawl,
/// and the reconcile needs it for every one of them — an actor can only withdraw a comment
/// if their own published blob was read this pass.
///
/// The actor goes last because a `did:dht:…` carries colons of its own, so it is the only
/// field that can absorb the remainder. Both fields before it are base32 and carry none.
pub fn comment_log_rkey(subject: &str, comment_id: &str, actor: &str) -> String {
    format!("{subject}:{comment_id}:{actor}")
}

/// Split a held comment's key back into its subject, its id and its actor.
///
/// The actor still has to look like a DID, for the reason `parse_engagement_log_rkey` gives:
/// a key missing its middle field parses successfully and wrongly, and what reads this
/// decides what to DELETE.
pub fn parse_comment_log_rkey(rkey: &str) -> Option<(&str, &str, &str)> {
    let (subject, rest) = rkey.split_once(':')?;
    let (id, actor) = rest.split_once(':')?;
    if subject.is_empty() || id.is_empty() || !actor.starts_with("did:") {
        return None;
    }
    Some((subject, id, actor))
}

/// The collection holding comments OTHERS have written on this identity's items — the
/// signed records the published conversation is folded from.
///
/// The counterpart of `ENGAGEMENT_LOG_COLLECTION` and a rebuildable cache in exactly the
/// same sense: every record in here came from its commenter's own published object and can
/// be re-read from there. Which is also why a moderation decision can never live in here —
/// the crawl would re-add what it dropped.
pub const COMMENT_LOG_COLLECTION: &str = "comment-log";

/// The rkey for one comment, on either side: the subject it is about, then the comment's
/// own id.
///
/// Subject first so a prefix scan gathers one item's whole conversation, which is how it is
/// folded and how it is rendered.
///
/// The id rather than `(actor, createdAt)` spelled out, and this is the reason the id exists
/// in the form it does: a DID carries colons and so does an ISO timestamp, so a key holding
/// both could not be split back apart. The id is base32 over exactly those two fields — one
/// separator-free token, fixed length, and computable by anyone holding the record.
///
/// No actor in the key, unlike the endorsement log. There the actor is what enforces one
/// record per person; here several from one person is the point, and the id already
/// distinguishes them — it is derived from the actor, so a collision across actors would
/// take a hash collision rather than a naming clash.
pub fn comment_rkey(subject: &str, comment_id: &str) -> String {
    format!("{subject}:{comment_id}")
}

/// Split a comment key back into its subject and its comment id.
///
/// At the FIRST separator, and both halves required — a key with no separator would
/// otherwise read as a subject with an empty id, and what gets built from that is a
/// withdrawal naming nothing.
pub fn parse_comment_rkey(rkey: &str) -> Option<(&str, &str)> {
    let (subject, id) = rkey.split_once(':')?;
    if subject.is_empty() || id.is_empty() {
        return None;
    }
    Some((subject, id))
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

/// Where this identity's own follow tally lives in its main doc — the count of people who
/// follow it as a PERSON, one record.
///
/// Not in `tally`, which is keyed by channel and swept of anything whose channel is gone: a
/// person is no channel, so a tally filed there would be deleted on the next pull. Published
/// from here in the directory blob, which is the person's own public face.
pub const PERSON_TALLY_COLLECTION: &str = "person-tally";

/// The one record in `PERSON_TALLY_COLLECTION`.
pub const PERSON_TALLY_RKEY: &str = "self";

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
/// From the RIGHT, because two of the three fields can carry colons: the actor is always a
/// `did:dht:<key>`, and a person-follow's subject is one too. So the actor is everything
/// after the last `:did:`, the kind is the bare word before it, and the subject is what is
/// left — which must be colon-free (a base32 hash, a channelID) or a whole did. Here beside
/// the builder so the two can't disagree — the crawl writes with one and decides what to
/// withdraw with the other, and a mismatch would make it drop records it should keep.
///
/// The subject rule is what stops a key missing its kind from reading as one that has it:
/// `did:dht:x:did:dht:y` would otherwise parse as subject `did:dht`, kind `x`. That parse
/// succeeds and is wrong, which is worse than one that fails — the crawl decides what to
/// DELETE from this, so a plausible misreading is how a live record gets dropped.
pub fn parse_engagement_log_rkey(rkey: &str) -> Option<(&str, &str, &str)> {
    let cut = rkey.rfind(":did:")?;
    let (head, actor) = (&rkey[..cut], &rkey[cut + 1..]);
    let (subject, kind) = head.rsplit_once(':')?;
    let whole_subject = !subject.contains(':')
        || subject
            .strip_prefix("did:dht:")
            .is_some_and(|key| !key.is_empty() && !key.contains(':'));
    if subject.is_empty() || kind.is_empty() || !whole_subject {
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

/// The collection holding the published CONVERSATION for each subject, in the CHANNEL's doc.
///
/// Beside the tally rather than inside it, because the two are read at different moments: a
/// feed row wants the count and nothing else, and merging them would make every row in a feed
/// carry every comment body in it. Opening a post is where the words are wanted.
pub const CONVERSATION_COLLECTION: &str = "conversation";

/// The collection where a conversation is cached for READING, in this identity's own doc.
///
/// The same pairing `TALLY_COLLECTION` has with `ENGAGEMENT_COLLECTION`, and for the same
/// reason: a screen cannot reach a channel's own replica, so the Curator lands both rungs at
/// one address in the doc the frontend already reads.
pub const THREAD_COLLECTION: &str = "thread";

/// The rkey for one cached conversation: the channel, then the subject.
///
/// Keyed exactly as a cached tally is, so dropping a channel's cache wholesale takes both.
pub fn thread_rkey(channel_id: &str, subject: &str) -> String {
    format!("{channel_id}:{subject}")
}

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

/// The collection recording what this identity knows about another one — their profile,
/// where to reach them, the channels they advertise and who they point at. Keyed by that
/// identity's `did:dht`.
///
/// Everything in it comes from a read some other loop was already making: the crawl
/// resolves an actor's key to find `_dir` and downloads the blob behind it, and both the
/// whole TXT record set and the whole blob are in hand at that moment. Recording them
/// costs no fetch, and without this collection they are parsed for endorsements and
/// dropped.
///
/// Apart from `CRAWL_COLLECTION` even though one read fills both, and the split is the
/// same one `COMMENT_CRAWL_COLLECTION` draws: a mark says whether a read can be SKIPPED
/// and holds a pointer, this holds what the read produced. Merging them would make a
/// skip decision depend on parsing a record it only needs a URL from, and would rewrite
/// everything we know about someone every time their pointer moved.
///
/// The frontier — identities we know exist because a held directory follows them, but
/// have never read — is DERIVED from these records rather than stored beside them.
/// `list_rkeys` scans the whole doc and filters by prefix, so entry count is what costs,
/// and materializing the frontier would multiply it by the graph's fan-out to hold
/// nothing a held record doesn't already carry.
pub const DIRECTORY_COLLECTION: &str = "directory";

/// The collection naming identities a screen reached for and could not answer from what
/// is held. Keyed by that identity's `did:dht`.
///
/// The one input to the crawl's order that does not come from the graph. Everything else
/// it decides is derived from who points at whom, which is a guess about what is worth
/// reading; this is somebody actually asking. So it sorts ahead of all of it.
///
/// Written by the frontend, which is unusual here and deliberate: forming intent is the
/// UI's half of the boundary, and "the person on screen was not in the index" is intent
/// rather than state. The Curator still owns what comes of it — it does the resolving, and
/// it clears the request once the answer is held.
///
/// Presence is the whole signal. The value records when the request was made, which
/// nothing reads yet; a request for somebody who can never be resolved otherwise has
/// no age to be judged on, and that is a decision waiting to be made rather than one made
/// here.
pub const REQUEST_COLLECTION: &str = "request";

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

/// The collection recording which Sia object holds each of this identity's own comment
/// bodies, keyed by the comment's own rkey.
///
/// A mark that OUTLIVES the record, like a delivery mark and for the same reason: a comment
/// deleted from the doc takes its `bodyURL` with it, and this is then the only surviving
/// thing that knows which object was minted for it. Without it a withdrawn comment leaks its
/// object, since nothing left would name what to reclaim.
pub const COMMENT_OBJECT_COLLECTION: &str = "comment-object";

/// The collection saying which of this identity's comments must be published SEALED, keyed
/// by that comment's own rkey and naming the channel whose key seals it.
///
/// A mark rather than a field on the record, because the record is SIGNED and gets published
/// verbatim: an extra field saying "this one is private" would be a field announcing itself
/// to everybody the blob is world-readable to, which is the opposite of the point. It is
/// also written by a different party than reads it — the composer knows the subject
/// channel's visibility, the publish loop knows how to seal — and a sidecar is how the two
/// agree without either learning the other's job.
///
/// Presence is the whole instruction: a marked comment is sealed under that channel's key, an
/// unmarked one is published as it stands. Which way round is deliberate — a comment on a
/// public post SHOULD be readable by anyone, because that is what makes a public count
/// auditable by somebody who holds no key. The composer writes the mark before the record it
/// belongs to, so there is no ordering in which a comment exists unclassified.
pub const COMMENT_SEAL_COLLECTION: &str = "comment-seal";

/// The collection holding the sealed form of a follow of a PRIVATE channel, keyed by the
/// follow's own `endorse` rkey.
///
/// On a private channel a follow is membership, and who is a member is something only the
/// channel's author and its members may know — so the record cannot ride in the
/// world-readable directory as it stands. Its sealed form is made once, when the record is
/// written, and kept here: a seal draws a fresh nonce, so sealing on every publish would move
/// the directory's fingerprint every pass. It names the record's signature, so a sealed form
/// left behind by an older record is told from the current one.
///
/// Presence is the instruction, as with comments: a follow with a seal here is published
/// sealed, one without is published as it stands. Written BEFORE the record, so there is no
/// ordering in which a private follow exists unclassified.
pub const FOLLOW_SEAL_COLLECTION: &str = "follow-seal";

/// The collection naming the Sia objects one of this identity's comments uploaded for its
/// files, keyed by that comment's own rkey.
///
/// A mark that OUTLIVES the record, exactly as `COMMENT_OBJECT_COLLECTION` does and for the
/// same reason: a withdrawn comment takes its attachment list with it, so without this
/// nothing would be left naming the objects to reclaim and they would be paid for forever.
///
/// Its own collection rather than a field on the body mark, because the two have different
/// writers — the composer writes this before the record, the Curator writes the body mark
/// after minting — and one key with two writers is how records get clobbered.
///
/// It is also what makes a half-finished write self-cleaning: the mark goes down before the
/// comment, so bytes uploaded for a comment that never got written are named by a mark whose
/// comment is missing, which is precisely what the reclaim sweep collects.
pub const COMMENT_FILES_COLLECTION: &str = "comment-files";

/// The collection recording, per actor, the comments blob this identity last read of theirs.
///
/// Apart from `CRAWL_COLLECTION` deliberately, even though one directory read serves both.
/// A directory mark written after its endorsements parsed would make the next pass skip that
/// actor — and if the comments download had failed in between, their comments would be
/// treated as read-and-absent, which is withdrawal by a read that never happened.
pub const COMMENT_CRAWL_COLLECTION: &str = "comment-crawl";

/// The collection recording which of this identity's COMMENTS have been delivered, keyed by
/// the comment's own rkey.
///
/// Its own collection for the reason the records have one: a mark is keyed by the rkey that
/// was sent, and the two shapes are `{kind}:{subject}` and `{subject}:{id}`. Sharing the
/// space would leave the orphan sweep guessing which it was looking at — and what it builds
/// from a misread key is a SIGNED withdrawal of something else.
pub const COMMENT_DELIVER_COLLECTION: &str = "comment-deliver";

/// The collection where each of this identity's live instances registers itself,
/// keyed by its iroh node id.
///
/// One identity is reachable at as many endpoints as it has devices, and each device
/// mints its own node key — so "where can I be dialed" is a set, not a value. Keeping
/// that set in the doc is what lets ANY instance publish the whole set: the thing that
/// made two writers clobber each other was that neither could see the other.
pub const INSTANCE_COLLECTION: &str = "instance";

/// The collection holding the roster of each channel this identity owns: one record per
/// SEATING of a member, from which the channel's member tree is derived.
///
/// Per-record for the reason endorsements are: the author's devices merge it by UNION,
/// where one list per channel would be last-writer-wins, and a removal lost to a
/// concurrent write is a member never removed. Never deleted from, since a removal is
/// counted by the epoch for as long as the channel exists.
pub const MEMBERS_COLLECTION: &str = "members";

/// The collection holding the sealed invitation behind each seating in this identity's
/// rosters, keyed like the seating (`member_rkey`).
///
/// Sealed ONCE, when the seating is written, and kept: a seal draws a fresh ephemeral key,
/// so sealing again on every publish would make the directory that carries these look new
/// every pass. Apart from the roster because the box is what gets published and the
/// seating never is.
pub const INVITE_BOX_COLLECTION: &str = "invite-box";

/// The collection recording which invitations have been knocked through to their invitee,
/// keyed like the box (`member_rkey`), each holding the content hash of the box that was
/// sent — so a box sealed again, to repair one that went missing, is sent again.
pub const INVITE_DELIVER_COLLECTION: &str = "invite-deliver";

/// The collection recording each channel this identity is a MEMBER of: the channel's key,
/// its author, the author's encryption key and this identity's leaf in the member tree —
/// everything a climb to the content key needs. Keyed by channel, written when this identity
/// joins.
pub const MEMBERSHIP_COLLECTION: &str = "membership";

/// The collection holding this identity's own request to read each private channel it has
/// asked about, keyed by channelID: the newest one, request or withdrawal, which is what the
/// deliver loop knocks to the author and what a screen reads to say "Requested".
pub const JOIN_REQUEST_COLLECTION: &str = "join-request";

/// The collection holding the requests to read this identity's private channels, the newest
/// per person per channel, withdrawals included so an older request replayed after one
/// cannot bring it back. Keyed by [`join_inbox_rkey`]; written only by the knock drain.
pub const JOIN_INBOX_COLLECTION: &str = "join-inbox";

/// The collection recording which of this identity's requests reached their author, keyed
/// by channelID and holding the request's content hash, so a new request or a withdrawal
/// goes again and an unchanged one does not.
pub const JOIN_DELIVER_COLLECTION: &str = "join-deliver";

/// The collection holding the author's answer to each request, keyed like the inbox: whether
/// it was approved or denied, which request it answered, and for a denial the sealed box
/// that tells the asker.
pub const JOIN_DECISION_COLLECTION: &str = "join-decision";

/// The collection recording which denials reached their asker, keyed like the inbox and
/// holding the box's content hash.
pub const JOIN_DENIAL_DELIVER_COLLECTION: &str = "join-denial-deliver";

/// The collection holding, per channel, the `createdAt` of this identity's request that its
/// author turned down. A denial of an older request says nothing about a newer one, which is
/// why the request it answered is what is kept.
pub const JOIN_DENIED_COLLECTION: &str = "join-denied";

/// The rkey for one person's request to read one channel.
pub fn join_inbox_rkey(channel_id: &str, did: &str) -> String {
    format!("{channel_id}:{did}")
}

/// The collection holding each content key this identity has climbed to, one record per
/// channel and epoch. Written only by the member pass, which is why it is apart from
/// `membership`: one writer to a record. Every epoch is kept, because an object sealed
/// before a rotation still opens with the key of its own epoch, and because the highest
/// epoch held is what an older tree is refused against.
pub const CONTENT_KEY_COLLECTION: &str = "content-key";

/// The rkey for one channel's content key at one epoch.
///
/// Ends in a terminator, since iroh-docs prunes by key prefix and epoch `1` would otherwise
/// be a prefix of epoch `10`.
pub fn content_key_rkey(channel_id: &str, epoch: u32) -> String {
    format!("{channel_id}:{epoch};")
}

/// The prefix every content key of one channel shares.
pub fn content_key_rkey_prefix(channel_id: &str) -> String {
    format!("{channel_id}:")
}

/// The epoch a content-key rkey names, for a channel already matched by its prefix.
pub fn parse_content_key_epoch(rkey: &str) -> Option<u32> {
    let (_, rest) = rkey.split_once(':')?;
    rest.strip_suffix(';')?.parse().ok()
}

/// The rkey for one seating: the channel, then the seating's own id.
///
/// The channel first so one prefix lists a channel's roster. Who the member is lives in
/// the record rather than the key: a did carries colons, and nothing reads it back out
/// of the key.
pub fn member_rkey(channel_id: &str, seat_id: &str) -> String {
    format!("{channel_id}:{seat_id}")
}

/// The prefix every seating of one channel's roster shares.
pub fn member_rkey_prefix(channel_id: &str) -> String {
    format!("{channel_id}:")
}

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

/// The rkey for one channel's published-conversations state. Its own, so the two objects
/// supersede independently.
pub fn published_conversation_rkey(channel_id: &str) -> String {
    format!("conversation:{channel_id}")
}

/// The rkey for the publish state of one band of a channel's member tree: its object, the
/// generation before it, and the fingerprint of what it said. One per band, because each
/// band supersedes on its own — a removal moves one band per tier and leaves the rest.
///
/// Ends in a terminator, and shares no head with [`published_members_rkey`], because an
/// iroh-docs insert PRUNES by prefix: a newer entry removes every older entry whose key
/// starts with its own, and an entry under a newer prefix is refused. Band `…:1:1` would
/// otherwise be a prefix of band `…:1:10`, and the pointer's key a prefix of every band's.
pub fn published_members_band_rkey(channel_id: &str, tier: u8, pos: u64) -> String {
    format!("members-band:{channel_id}:{tier}:{pos};")
}

/// The rkey for the URL a channel's member-tree pointer names. Written by the publish pass
/// and read by the keep-alive, which re-signs it — so it lives here rather than beside
/// either, where a divergence would leave the pointer unrefreshed with no error anywhere.
pub fn published_members_rkey(channel_id: &str) -> String {
    format!("members-top:{channel_id}")
}

/// The rkey for the settings snapshot's publish state — which Sia object the settings
/// locator currently names, and the generation before it.
///
/// Unprefixed, like the directory's, because it's identity-level: there is one settings
/// snapshot, not one per anything. Shared for the same reason the channel rkey is: the
/// frontend writes this record when it snapshots, and the keep-alive loop reads it to
/// know what to republish.
pub const PUBLISHED_SETTINGS_RKEY: &str = "settings";

/// What a settings-snapshot object says it is, in its own Sia metadata.
///
/// Pin's objects are otherwise ANONYMOUS: every "what is this object" question is
/// answered by a record in the doc that names it, so an identity holding no record —
/// a fresh device, or one whose pointers have aged off the DHT — can enumerate its own
/// scope and learn nothing about what is in it. A tag is the object answering for
/// itself.
///
/// Metadata is owner-private and authenticated (sealed under a per-object key that is
/// itself sealed to the AppKey, and separately signed), and it does not cross a share.
/// So this says something to the identity that wrote it and to nobody else.
///
/// The version rides in the string. A reader ignores a `t` it does not know, which is
/// what lets a later kind of tagged object appear without this one having to change.
pub const SNAPSHOT_TAG_TYPE: &str = "pin.snapshot.v1";

/// A settings snapshot's metadata tag.
///
/// `t` is the only load-bearing field — it is what lets an object say it is a snapshot
/// rather than being an opaque id. `fp` carries the same fingerprint the publish state
/// records, so a diagnostic can say which generations exist in a scope without
/// downloading any of them, and a reader can correlate an object with the doc state it
/// holds. Deliberately absent: a timestamp of ours (the indexer stamps `created_at`,
/// which no clock of ours can skew), a sequence number (a fresh device by definition
/// holds no prior state to continue), and the DID (the scope is already per-AppKey).
///
/// Nothing signs this, so it carries no byte-stability constraint — unlike the
/// engagement layout, a field may be added here without invalidating anything.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct SnapshotTag {
    pub t: String,
    /// Absent rather than empty when there is none, and optional on the way back in, so
    /// a tag without it is still recognisably ours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fp: Option<String>,
}

/// The metadata a settings-snapshot object carries.
pub fn snapshot_tag(fingerprint: &str) -> Vec<u8> {
    let tag = SnapshotTag {
        t: SNAPSHOT_TAG_TYPE.to_string(),
        fp: Some(fingerprint.to_string()),
    };
    serde_json::to_vec(&tag).expect("two owned strings always serialize")
}

/// Whether an object's metadata says it is one of this identity's settings snapshots.
///
/// The one place the tag is READ, so the reader never restates the shape the writer
/// used — which is the divergence a constant alone would leave open, since the field
/// name is as much a contract as its value. The frontend reaches this through wasm for
/// that reason rather than spelling `t` again in TypeScript.
///
/// False for an untagged object, whose metadata is empty, and for anything that will
/// not parse. Both mean the same thing to every caller: not one of ours.
pub fn is_snapshot_tag(metadata: &str) -> bool {
    serde_json::from_str::<SnapshotTag>(metadata).is_ok_and(|tag| tag.t == SNAPSHOT_TAG_TYPE)
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

    /// NO RECORD KEY IN A DOC MAY BE A PREFIX OF ANOTHER: iroh-docs prunes by prefix, so a
    /// newer insert deletes every older entry whose key starts with its own, and an insert
    /// under a newer prefix is refused — silently, either way. Every rkey constructor here,
    /// fed the inputs that vary in length in practice (a subject that is a hash, a channelID
    /// or a did; numbers past one digit; both timestamp spellings), and no key may begin
    /// another. A new key shape belongs in this list.
    #[test]
    fn no_record_key_is_a_prefix_of_another() {
        // Distinct, realistic-length stand-ins: a 16-char channelID, a 52-char hash, a did.
        let b32 = |seed: u8, len: usize| -> String {
            const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
            let mut x = (seed as u32).wrapping_mul(2654435761).wrapping_add(1);
            (0..len)
                .map(|_| {
                    x = x.wrapping_mul(1103515245).wrapping_add(12345);
                    ALPHABET[((x >> 16) % 32) as usize] as char
                })
                .collect()
        };
        let channels = [b32(1, 16), b32(2, 16)];
        let hashes = [b32(3, 52), b32(4, 52)];
        let dids = [
            format!("did:dht:{}", b32(5, 52)),
            format!("did:dht:{}", b32(6, 52)),
        ];
        let subjects: Vec<String> = hashes
            .iter()
            .chain(&channels)
            .chain(&dids)
            .cloned()
            .collect();
        let stamps = ["2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00Z"];
        let seats = [
            "0d2563529303cbd20a35eb16da1e4c0a",
            "ffeeddccbbaa99887766554433221100",
        ];
        let kinds = ["like", "pin", "repost", "comment", "follow"];

        let mut keys: Vec<(String, String)> = Vec::new();
        let mut add = |collection: &str, rkey: String| keys.push((collection.into(), rkey));
        for ch in &channels {
            for s in &subjects {
                add(TALLY_COLLECTION, tally_rkey(ch, s));
                add(THREAD_COLLECTION, thread_rkey(ch, s));
            }
            for at in stamps {
                add(PINNED_COLLECTION, pinned_rkey(ch, at));
            }
            for epoch in [1, 10, 100] {
                add(CONTENT_KEY_COLLECTION, content_key_rkey(ch, epoch));
            }
            for seat in seats {
                add(MEMBERS_COLLECTION, member_rkey(ch, seat));
                add(INVITE_BOX_COLLECTION, member_rkey(ch, seat));
            }
            add(PUBLISHED_COLLECTION, published_channel_rkey(ch));
            add(PUBLISHED_COLLECTION, published_engagement_rkey(ch));
            add(PUBLISHED_COLLECTION, published_conversation_rkey(ch));
            add(PUBLISHED_COLLECTION, published_members_rkey(ch));
            for (tier, pos) in [(0, 0), (0, 1), (0, 10), (1, 1), (1, 10), (10, 1)] {
                add(
                    PUBLISHED_COLLECTION,
                    published_members_band_rkey(ch, tier, pos),
                );
            }
            add(FOLLOW_SEAL_COLLECTION, endorse_rkey("follow", ch));
            add(MEMBERSHIP_COLLECTION, ch.clone());
            add(JOIN_REQUEST_COLLECTION, ch.clone());
            add(JOIN_DELIVER_COLLECTION, ch.clone());
            add(JOIN_DENIED_COLLECTION, ch.clone());
            for did in &dids {
                add(JOIN_INBOX_COLLECTION, join_inbox_rkey(ch, did));
                add(JOIN_DECISION_COLLECTION, join_inbox_rkey(ch, did));
                add(JOIN_DENIAL_DELIVER_COLLECTION, join_inbox_rkey(ch, did));
            }
        }
        add(PUBLISHED_COLLECTION, PUBLISHED_SETTINGS_RKEY.into());
        add(PUBLISHED_COLLECTION, "directory".into());
        add(PUBLISHED_COLLECTION, "comments".into());
        for s in &subjects {
            for kind in kinds {
                add(ENDORSE_COLLECTION, endorse_rkey(kind, s));
                for actor in &dids {
                    add(
                        ENGAGEMENT_LOG_COLLECTION,
                        engagement_log_rkey(s, kind, actor),
                    );
                }
            }
            for id in &hashes {
                add(COMMENT_COLLECTION, comment_rkey(s, id));
                for actor in &dids {
                    add(COMMENT_LOG_COLLECTION, comment_log_rkey(s, id, actor));
                }
            }
        }

        let full: Vec<Vec<u8>> = keys.iter().map(|(c, r)| record_key(c, r)).collect();
        for (i, a) in full.iter().enumerate() {
            for (j, b) in full.iter().enumerate() {
                if i != j && a != b && b.starts_with(a) {
                    panic!(
                        "{} is a prefix of {}",
                        String::from_utf8_lossy(a),
                        String::from_utf8_lossy(b)
                    );
                }
            }
        }
    }

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
        // The published pair and the cached pair, each of which shares a keyspace with the
        // other member of its own doc: a collision would make a conversation overwrite a
        // count.
        assert_ne!(CONVERSATION_COLLECTION, ENGAGEMENT_COLLECTION);
        assert_ne!(THREAD_COLLECTION, TALLY_COLLECTION);
        assert_ne!(CONVERSATION_COLLECTION, THREAD_COLLECTION);
        assert_ne!(CRAWL_COLLECTION, ENGAGEMENT_LOG_COLLECTION);
        assert_ne!(CRAWL_COLLECTION, ENGAGEMENT_COLLECTION);
    }

    #[test]
    fn what_we_read_and_what_it_produced_are_two_collections() {
        // Both are keyed by a bare did:dht, so their rkeys are byte-identical for the same
        // actor and the collection is the ONLY thing separating them. A shared name would
        // not collide loudly — it would make the crawl's pointer mark and everything known
        // about that actor overwrite each other at one key, so a skip decision would start
        // reading a profile and a profile lookup would get a URL.
        let did = "did:dht:iy8yq8fgjbnqbsphq1a5rnf3pdxrsp1zt8ycqmoy3zj4txhjjc9y";
        assert_eq!(
            record_key(CRAWL_COLLECTION, did),
            record_key(CRAWL_COLLECTION, did)
        );
        assert_ne!(
            record_key(CRAWL_COLLECTION, did),
            record_key(DIRECTORY_COLLECTION, did)
        );
        assert_ne!(CRAWL_COLLECTION, DIRECTORY_COLLECTION);

        // And it is not any of the collections a prefix scan already runs over per pass.
        assert_ne!(DIRECTORY_COLLECTION, ENGAGEMENT_LOG_COLLECTION);
        assert_ne!(DIRECTORY_COLLECTION, COMMENT_LOG_COLLECTION);
        assert_ne!(DIRECTORY_COLLECTION, DELIVER_COLLECTION);
        assert_ne!(DIRECTORY_COLLECTION, PULL_COLLECTION);

        // A request to read somebody and the record of having read them are also keyed by
        // a bare did, and they are the pair most likely to be confused: one is cleared the
        // moment the other is written. Sharing a name would have a request read as a
        // directory with no channels and no follows — an identity that looks read and
        // published nothing.
        assert_ne!(REQUEST_COLLECTION, DIRECTORY_COLLECTION);
        assert_ne!(REQUEST_COLLECTION, CRAWL_COLLECTION);
        assert_ne!(
            record_key(REQUEST_COLLECTION, did),
            record_key(DIRECTORY_COLLECTION, did)
        );
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
    fn an_engagement_log_key_round_trips_a_subject_that_is_a_did() {
        // A person-follow's subject is the person, so the subject carries colons too.
        let subject = "did:dht:uqaj3fcr9db6jg6o9pjs53iuftyj45r46aubogfaceqjbo6pp9sy";
        let actor = "did:dht:iyypk375c71qwjem5isiramudutoogo1t9gogz8f587sfkt9db4o";
        let rkey = engagement_log_rkey(subject, "follow", actor);
        assert_eq!(
            parse_engagement_log_rkey(&rkey),
            Some((subject, "follow", actor))
        );

        // And the same key with its kind dropped must not read as a half-did subject with
        // the subject's key for a kind.
        assert_eq!(
            parse_engagement_log_rkey(&format!("{subject}:{actor}")),
            None
        );
    }

    #[test]
    fn an_endorsement_key_round_trips_and_nonsense_does_not_parse() {
        // The delivery mark shares this key, and a mark with no endorsement behind it is
        // how a withdrawal is noticed — so this parse is what a signed retraction is built
        // from, and something half-read here is something signed about the wrong subject.
        let subject = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        let rkey = endorse_rkey("like", subject);
        assert_eq!(parse_endorse_rkey(&rkey), Some(("like", subject)));

        // A subject is a base32 hash and carries no separator, so the first one is the
        // boundary and everything after it is the subject.
        assert_eq!(parse_endorse_rkey("like:a:b"), Some(("like", "a:b")));

        assert_eq!(parse_endorse_rkey("nocolon"), None);
        assert_eq!(parse_endorse_rkey(":subject"), None);
        assert_eq!(parse_endorse_rkey("like:"), None);
    }

    /// A comment id, as pin-crypto mints them. Opaque here on purpose: this crate builds
    /// keys out of the token and never derives it, so literals say that more honestly than
    /// a call across a dependency this crate does not otherwise need.
    const ALICE_AT_NOON: &str = "pcuo7dgvhdlgkmqk6dqxvxqxrvpwbeh7kfxvcmtzegkkxpn2xtxq";
    const ALICE_A_SECOND_LATER: &str = "gvpwgllvvmubfzhcbhqfhvbhbjbfy3d5npmnsofc7uh6heunbtqa";

    #[test]
    fn a_held_comment_key_round_trips_and_nonsense_does_not_parse() {
        let subject = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        let actor = "did:dht:yg4gcfmzy6zzgqmhw6ftnjqwbxpxbrujmn7jkgn5b3njfvqwzqto";
        let rkey = comment_log_rkey(subject, ALICE_AT_NOON, actor);
        assert_eq!(
            parse_comment_log_rkey(&rkey),
            Some((subject, ALICE_AT_NOON, actor))
        );

        // A key missing its middle field: the id would read as the actor and the parse would
        // succeed, which is worse than failing when what reads this decides what to delete.
        assert_eq!(
            parse_comment_log_rkey(&format!("{subject}:{ALICE_AT_NOON}")),
            None
        );
        assert_eq!(parse_comment_log_rkey("nocolon"), None);
        assert_eq!(
            parse_comment_log_rkey(&format!(":{ALICE_AT_NOON}:{actor}")),
            None
        );
    }

    #[test]
    fn a_held_comment_key_gives_the_actor_back_whole() {
        // A DID carries colons, so it has to be last. Reading it back is what the reconcile
        // needs, and getting a truncated one would compare against an actor who was never
        // reached.
        let actor = "did:dht:yg4gcfmzy6zzgqmhw6ftnjqwbxpxbrujmn7jkgn5b3njfvqwzqto";
        let rkey = comment_log_rkey("subject", ALICE_AT_NOON, actor);
        assert_eq!(parse_comment_log_rkey(&rkey).unwrap().2, actor);
    }

    #[test]
    fn a_comment_key_round_trips_and_nonsense_does_not_parse() {
        let subject = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        let id = ALICE_AT_NOON;
        let rkey = comment_rkey(subject, &id);
        assert_eq!(parse_comment_rkey(&rkey), Some((subject, id)));

        assert_eq!(parse_comment_rkey("nocolon"), None);
        assert_eq!(parse_comment_rkey(":id"), None);
        assert_eq!(parse_comment_rkey("subject:"), None);
    }

    #[test]
    fn a_comment_key_holds_exactly_one_separator() {
        // Why the key carries an ID rather than the actor and timestamp it is derived from:
        // a DID carries two colons and an ISO timestamp carries two more, so a key spelling
        // them out could not be split back apart at all. Both halves here are base32.
        let rkey = comment_rkey(
            "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a",
            ALICE_AT_NOON,
        );
        assert_eq!(rkey.matches(':').count(), 1);
    }

    #[test]
    fn one_actors_two_comments_on_one_subject_are_two_keys() {
        // The singleton that `endorse_rkey` relies on, deliberately broken: a second comment
        // landing on the first one's key is the shipped collision bug repeated.
        let subject = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        let first = ALICE_AT_NOON;
        let second = ALICE_A_SECOND_LATER;
        assert_ne!(
            comment_rkey(subject, &first),
            comment_rkey(subject, &second)
        );
    }

    #[test]
    fn a_comment_key_cannot_be_read_as_an_endorsement_key() {
        // They live in different collections, so this is belt-and-braces — but the delivery
        // mark is keyed by whichever rkey was sent, and a comment key parsed as an
        // endorsement key would yield a kind of 52 base32 characters. Better that it cannot
        // masquerade at all.
        let subject = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        let rkey = comment_rkey(subject, ALICE_AT_NOON);
        let (kind, _) = parse_endorse_rkey(&rkey).unwrap();
        assert_ne!(kind, "comment");
        assert_eq!(kind, subject);
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

    // The tag is written by the Curator and read by a device that holds nothing else
    // about the object, so both halves are pinned here: the value a reader matches on,
    // and the field names it arrives under.
    #[test]
    fn a_snapshot_tag_identifies_itself() {
        assert_eq!(SNAPSHOT_TAG_TYPE, "pin.snapshot.v1");
        let tag = snapshot_tag("bafyfingerprint");
        assert_eq!(
            String::from_utf8(tag.clone()).unwrap(),
            r#"{"t":"pin.snapshot.v1","fp":"bafyfingerprint"}"#
        );
        assert!(is_snapshot_tag(&String::from_utf8(tag).unwrap()));
    }

    // An untagged object's metadata is empty, and nothing else in this scope writes a
    // tag at all — so the three ways of not being ours have to answer alike, or a
    // reader picking the newest tagged object could pick something else entirely.
    #[test]
    fn nothing_else_reads_as_a_snapshot() {
        assert!(!is_snapshot_tag(""));
        assert!(!is_snapshot_tag("not json at all"));
        assert!(!is_snapshot_tag(r#"{"t":"pin.something-else.v1"}"#));
        // A field this version does not know is ignored, which is what lets the tag
        // grow without a reader of this generation losing its own snapshots.
        assert!(is_snapshot_tag(
            r#"{"t":"pin.snapshot.v1","fp":"x","later":1}"#
        ));
        // And `fp` is not load-bearing: a tag carrying only the type is still ours.
        assert!(is_snapshot_tag(r#"{"t":"pin.snapshot.v1"}"#));
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
    fn per_epoch_derivations_vary_by_epoch() {
        // A rotation that derived the same key would be no rotation: a removed member
        // would go on reading.
        let ikm = [3u8; 32];
        assert_ne!(
            channel_content_key(&ikm, "chan", 0),
            channel_content_key(&ikm, "chan", 1)
        );
    }

    #[test]
    fn enc_key_seed_matches_the_locked_vector() {
        // A drift would leave every box ever sealed to an identity unopenable by it.
        assert_eq!(
            hex(&enc_key_seed(&[0u8; 32])),
            "00eb8eeb8414398eb8f5e269378d2c7f2c86b0297597cdcacec166f9584744a3"
        );
    }

    #[test]
    fn channel_content_key_matches_the_locked_vector() {
        // Every device of one author must derive the same C, and a drift would leave an
        // author unable to read their own channel.
        assert_eq!(
            hex(&channel_content_key(&[0u8; 32], "chan1", INITIAL_EPOCH)),
            "a348623b4bafba8f05e543839ae22a2173df927756b728bc56e2ae081ff35968"
        );
    }

    #[test]
    fn channel_doc_seed_matches_the_locked_vector() {
        assert_eq!(
            hex(&channel_doc_seed(&[0u8; 32], "chan1")),
            "8b7ef12a1bfb3e697bf2f4a7fb60226b788a61dc1a9b6f9c2685b546a0230875"
        );
    }

    #[test]
    fn members_locator_seed_matches_the_locked_vector() {
        // Every member resolves the tree through this key, so moving it strands every
        // member of every channel at the tree they last read.
        assert_eq!(
            hex(&members_locator_seed(&[0u8; 32])),
            "dcf33f14c4a24a2d44bf1be979b32c160a11cfcaec07903028fb13578970e73e"
        );
    }

    #[test]
    fn a_content_key_rkey_parses_back_and_no_epoch_prefixes_another() {
        let keys: Vec<String> = [0u32, 1, 2, 10, 11, 100]
            .iter()
            .map(|&e| content_key_rkey("chan", e))
            .collect();
        for (key, epoch) in keys.iter().zip([0u32, 1, 2, 10, 11, 100]) {
            assert_eq!(parse_content_key_epoch(key), Some(epoch));
            assert!(key.starts_with(&content_key_rkey_prefix("chan")));
        }
        for a in &keys {
            for b in &keys {
                assert!(
                    a == b || !b.starts_with(a.as_str()),
                    "{a} is a prefix of {b}"
                );
            }
        }
        assert_eq!(parse_content_key_epoch("chan:7"), None);
        assert_eq!(parse_content_key_epoch("chan:x;"), None);
    }

    #[test]
    fn no_member_tree_publish_key_is_a_prefix_of_another() {
        // iroh-docs prunes by prefix, so one of these being a prefix of another would have
        // each write delete the other's record, or be refused under it.
        let mut keys = vec![published_members_rkey("chan")];
        for tier in [0u8, 1, 2, 11] {
            for pos in [0u64, 1, 2, 10, 11, 100, 101] {
                keys.push(published_members_band_rkey("chan", tier, pos));
            }
        }
        for a in &keys {
            for b in &keys {
                assert!(
                    a == b || !b.starts_with(a.as_str()),
                    "{a} is a prefix of {b}"
                );
            }
        }
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
            enc_key_seed(&ikm),
            channel_locator_seed(&ikm),
            channel_doc_seed(&ikm, "chan"),
            channel_content_key(&ikm, "chan", 0),
            channel_doc_ticket_seed(&ikm),
            engagement_locator_seed(&ikm),
            conversation_locator_seed(&ikm),
            members_locator_seed(&ikm),
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
            channel_content_key(&ikm, "a", 0),
            channel_content_key(&ikm, "b", 0)
        );
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
