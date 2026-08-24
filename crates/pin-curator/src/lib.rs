// The Curator's loops — the work that has to keep happening whether or not anyone is
// watching, which is what distinguishes the Curator from the UI in front of it.
//
// Each has its own module, and each is one job:
//
//   PULL        keeps the subscribed channels' manifests and published counts current in
//               the doc, so a reader lands on a cached copy instead of waiting on the DHT.
//   KEEP-ALIVE  republishes the owned channels' locators (and the settings locator) so
//               they don't age off the DHT and take discoverability with them.
//   CHANNELDOC  serves each owned channel as a live replica and advertises a read ticket
//               for it — the author half of the ladder's top rung.
//   CHANNELSYNC imports the subscribed channels' replicas, so their authors' writes are
//               pushed here rather than polled for.
//   DELIVER     knocks this identity's endorsements through to the people they are about,
//               which is the only way engagement reaches an author outside our graph.
//   INSTANCE    records where THIS instance can be dialed, so the identity's published
//               coordinates are the set of its live endpoints rather than whichever one
//               wrote last.
//   IDENTITY    publishes that whole set, plus the directory pointer, as one packet from
//               one writer.
//   RENDEZVOUS  finds the identity's OTHER instances and syncs this replica with them.
//   SNAPSHOT    mirrors the doc to Sia, so a device with no peer can still recover it.
//   REPACK      consolidates sub-full slabs so storage stops creeping.
//
// Most start by reading the identity's settings record, which is where the doc says what
// this identity subscribes to and owns. All of them are returned rather than spawned, so
// the caller places them on the executor it has. None touches the feed: a pass announces
// itself by writing a record, and the doc's change feed carries that to whatever is
// rendering.
//
// The pull loop, specifically:
//
// This is the resolution ladder's "keep" step, moved off the frontend. It ran as a
// React effect until now, which meant the intake half of the Curator only worked while
// a webview was alive — on desktop the loop stopped when the window did, and the work
// was described in one language while every leg it called had already moved to another.
//
// What a pass does: read the subscription list out of the doc's own settings record,
// resolve each channel that isn't the user's own, and write the sealed manifest to
// `sub/<channelID>`. The bytes are stored exactly as they came off Sia, so whoever
// reads them later decrypts by the same path a fresh resolve would — the loop is a
// courier, not an interpreter. The one thing it does look at is a manifest's
// `publishedAt`, to avoid caching a resolve that's older than what it already holds
// (see `is_older_than_cached`); it holds `K` for these channels anyway, and moving a
// channel backwards is the failure this exists to prevent.
//
// It reads a second artifact per channel: the counts its author published, into
// `tally/<channelID>:<subject>`. That is engagement's floor rung from the reader's side,
// and it is what a row renders from — the copy that arrives over live sync reaches only
// subscribers holding that replica, where everyone who can read a channel holds K.
//
// Most passes download nothing. Both pointers are Sia URLs, so both are content
// addresses: unchanged means the bytes behind them are the ones already cached. A pass
// resolves each pointer and fetches only when something has moved (see `may_skip_pull`
// and `TallyMark`) — so the steady-state cost of watching a channel is two DHT resolves,
// and a Sia read happens when there is actually something new to read.
//
// It does NOT touch the feed. A pass announces itself by writing a record, and the
// doc's change feed carries that to whatever is rendering; the loop has no opinion
// about whether anything is.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_derive::{record_key, settings_key};
use pin_engagement::Aggregate;

mod channeldoc;
mod channelsync;
mod comments;
mod deliver;
mod engagement;
mod identity;
mod instance;
mod keepalive;
mod rendezvous;
mod repack;
mod snapshot;
pub use channeldoc::{
    channel_docs_once, run_channel_doc_loop, ChannelDocContext, ChannelDocOutcome,
};
pub use channelsync::{run_channel_sync_loop, ChannelSyncContext, ChannelSyncOutcome};
pub use deliver::{deliver_once, run_deliver_loop, DeliverContext, DeliverOutcome};
pub use engagement::{engagement_once, run_engagement_loop, EngagementContext, EngagementOutcome};
pub use identity::{
    publish_identity_once, run_identity_loop, IdentityContext, IdentityOutcome,
    DIRECTORY_DOC_VERSION,
};
pub use instance::{
    encode_endpoints, live_instances, parse_endpoints, register_instance, run_instance_loop,
    InstanceAddr, InstanceContext, InstanceOutcome, INSTANCE_TTL_SECS,
};
pub use keepalive::{
    keep_alive_once, run_keep_alive_loop, KeepAliveContext, KeepAliveOutcome, SettingsLocator,
};
pub use rendezvous::{
    merge_directory, pick_peers, rendezvous_once, run_rendezvous_loop, Entry, RendezvousContext,
    RendezvousOutcome, ENTRY_TTL_SECS,
};
pub use repack::{
    aggregate_slabs, pick_batch, repack_once, rewrite_manifest, run_repack_loop, Move, ObjectSlabs,
    RepackContext, RepackOutcome, ScopeRef, SlabAggregate, SlabObject, SlabPiece, Source,
};
pub use snapshot::{run_snapshot_loop, snapshot_once, SnapshotContext, SnapshotOutcome};

/// The collection holding cached manifests of channels the user subscribes to. Keyed
/// by channelID; the value is the sealed blob, byte-identical to Sia's copy.
pub const SUB_COLLECTION: &str = "sub";

/// Where the settings record lives — the loop's source for who's subscribed.
const SETTINGS_COLLECTION: &str = "settings";
const SETTINGS_RKEY: &str = "self";

/// Everything a pass needs, gathered by whichever engine is running it.
///
/// Concrete types rather than a trait: both engines hold the same `Doc` and the same
/// blobs `Store` (a `MemStore` and an `FsStore` each deref to it), so there is nothing
/// here for an abstraction to abstract over.
pub struct PullContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// A connected Sia session. Resolving a channel downloads its manifest object, so
    /// a pass over a disconnected session simply fails and the next one retries.
    pub sia: Arc<pin_sia::Session>,
    /// The Sia AppKey, for the settings key. The loop reads its own user's settings and
    /// nothing else.
    pub app_key: [u8; 32],
}

/// What one pass did. Reported rather than logged so a caller can surface it (or, in a
/// test, assert on it).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PullOutcome {
    /// Channels whose manifest was resolved and cached.
    pub cached: usize,
    /// Channels that resolved to nothing — never published, or the record has aged off
    /// the DHT. Ordinary, not an error.
    pub unresolved: usize,
    /// Channels that failed to resolve (network, decrypt). The next pass retries.
    pub failed: usize,
    /// Cached records dropped because the user no longer subscribes to them.
    pub dropped: usize,
    /// Channels whose resolve came back OLDER than what's already cached, so the
    /// write was skipped. Expected on a browser, whose relay transport lags the DHT.
    pub stale: usize,
    /// Channels left alone because neither the pointer nor the cached record had moved
    /// since the last pass — so no download at all. The steady state.
    pub skipped: usize,
    /// Subjects whose cached tally was written from a channel's published counts.
    pub tallies: usize,
    /// Channels whose tallies pointer hadn't moved, so their counts weren't downloaded.
    pub tallies_skipped: usize,
}

/// What the pull loop last cached for one channel: where it came from, and what it wrote.
///
/// Both, because a cached manifest has three writers — this loop, the live-sync rung, and
/// a peer instance syncing the same record. The pointer says the source hasn't moved; the
/// cached hash says nothing has since overwritten the result. Either alone would let a
/// clobbered cache sit stale until the author next published.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct PullMark {
    url: String,
    cached: String,
}

/// Whether a channel can be left alone without downloading its manifest.
///
/// Named rather than inlined for the same reason the crawl's is: a wrong "no" costs one
/// download, a wrong "yes" leaves a subscriber reading a stale channel indefinitely.
fn may_skip_pull(held: Option<&PullMark>, current: &PullMark) -> bool {
    held == Some(current)
}

/// The mark held for a channel, or None if this loop has never cached it.
async fn read_pull_mark(ctx: &PullContext, channel_id: &str) -> Option<PullMark> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        pin_derive::PULL_COLLECTION,
        channel_id,
    )
    .await
    .ok()??;
    serde_json::from_slice(&raw).ok()
}

/// Record what this pass cached for a channel, unless it would write what's already there.
///
/// Best-effort: losing a mark costs one download next pass, which is the state this loop
/// was in before marks existed.
async fn write_pull_mark(ctx: &PullContext, channel_id: &str, mark: &PullMark) {
    if read_pull_mark(ctx, channel_id).await.as_ref() == Some(mark) {
        return;
    }
    let Ok(bytes) = serde_json::to_vec(mark) else {
        return;
    };
    let _ = write_record(
        &ctx.doc,
        ctx.author_id,
        pin_derive::PULL_COLLECTION,
        channel_id,
        bytes,
    )
    .await;
}

// --- the tally cache ----------------------------------------------------------
//
// One address (`tally/<channelID>:<subject>`) that this identity's screens read, written
// by whichever loop is in a position to know a count: the engagement loop for a channel
// this identity owns, from the fold it just computed, and the pull loop for a subscribed
// one, from the counts its author published. Shared here rather than living with either
// so the two feeders write the same record the same way.

/// What one subject's tally ASSERTS, with the volatile parts stripped out.
///
/// `updatedAt` and `retentionCheckedAt` move on every pass whether or not a single
/// endorsement did. A set root is a commitment over an exact backing set, so two tallies
/// agreeing on their counts and roots have genuinely not moved — and `sampleActors` is
/// drawn from that same set in its own sort order, so it is covered too.
pub(crate) fn asserted(aggregate: &Aggregate) -> BTreeMap<&str, (usize, &str)> {
    aggregate
        .kinds
        .iter()
        .map(|(kind, tally)| (kind.as_str(), (tally.count, tally.set_root.as_str())))
        .collect()
}

/// Whether a held cache already says everything a fresher tally does.
///
/// Nothing held is never current — a first count has to land, including the empty one a
/// withdrawal produces.
pub(crate) fn cache_is_current(held: Option<&Aggregate>, fresh: &Aggregate) -> bool {
    held.map(asserted).as_ref() == Some(&asserted(fresh))
}

/// Whether a tally would replace a held one with an OLDER reading of the same counts.
///
/// Every tally for a channel is stamped by that channel's author on one clock, so the
/// two are comparable. It matters because the cache has more than one feeder and they
/// don't run at the same distance from the source: a live-synced copy of the author's
/// own fold arrives in seconds, where a floor read comes off a pointer a browser resolves
/// through relays minutes behind. Writing the floor's answer over the fresher one would
/// walk a count backwards.
pub(crate) fn tally_is_older(held: Option<&Aggregate>, fresh: &Aggregate) -> bool {
    held.is_some_and(|h| fresh.updated_at < h.updated_at)
}

/// Cache one subject's tally where this identity's own screens read it.
///
/// Written only when what it asserts has changed. This doc syncs to every instance of the
/// identity and is snapshotted whole to Sia against a fingerprint of its contents, so a
/// record rewritten each pass because a timestamp moved would mint a fresh snapshot object
/// every cadence. The cost is that a cached `retentionCheckedAt` lags until a count moves —
/// understating how recently the check ran, never overstating it, and the same trade the
/// floor already makes by gating its publish on its own substance.
///
/// Best-effort: this is a cache, and the next pass that moves a count rewrites it.
pub(crate) async fn cache_tally(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    channel_id: &str,
    subject: &str,
    aggregate: &Aggregate,
) -> bool {
    let rkey = pin_derive::tally_rkey(channel_id, subject);
    let held = read_record(doc, blobs, author_id, pin_derive::TALLY_COLLECTION, &rkey)
        .await
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Aggregate>(&bytes).ok());
    if cache_is_current(held.as_ref(), aggregate) || tally_is_older(held.as_ref(), aggregate) {
        return false;
    }
    let Ok(bytes) = serde_json::to_vec(aggregate) else {
        return false;
    };
    write_record(doc, author_id, pin_derive::TALLY_COLLECTION, &rkey, bytes)
        .await
        .is_ok()
}

/// Drop one subject's cached tally, for a subject nothing endorses any more. Absent and
/// zero read the same to a screen, so the record goes rather than sitting at zero.
/// Cache one subject's published conversation where this identity's screens read it.
///
/// Newer-wins on `updatedAt`, the same guard the cached tally takes: the accelerant rung and
/// the floor rung both land here, and the floor can arrive holding an older fold.
pub(crate) async fn cache_thread(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    channel_id: &str,
    subject: &str,
    conversation: &pin_engagement::Conversation,
) -> bool {
    let rkey = pin_derive::thread_rkey(channel_id, subject);
    let held = read_record(doc, blobs, author_id, pin_derive::THREAD_COLLECTION, &rkey)
        .await
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<pin_engagement::Conversation>(&bytes).ok());
    if held.as_ref() == Some(conversation) {
        return false;
    }
    if let Some(h) = &held {
        if h.updated_at > conversation.updated_at {
            return false;
        }
    }
    let Ok(bytes) = serde_json::to_vec(conversation) else {
        return false;
    };
    write_record(doc, author_id, pin_derive::THREAD_COLLECTION, &rkey, bytes)
        .await
        .is_ok()
}

/// Drop a cached conversation, for a subject nobody comments on any more.
pub(crate) async fn clear_cached_thread(
    doc: &Doc,
    author_id: AuthorId,
    channel_id: &str,
    subject: &str,
) {
    let _ = delete_record(
        doc,
        author_id,
        pin_derive::THREAD_COLLECTION,
        &pin_derive::thread_rkey(channel_id, subject),
    )
    .await;
}

pub(crate) async fn clear_cached_tally(
    doc: &Doc,
    author_id: AuthorId,
    channel_id: &str,
    subject: &str,
) {
    let _ = delete_record(
        doc,
        author_id,
        pin_derive::TALLY_COLLECTION,
        &pin_derive::tally_rkey(channel_id, subject),
    )
    .await;
}

/// Where a channel's published tallies were when this loop last read them.
///
/// The pointer alone, unlike the manifest's mark. A cached tally is written back only
/// when what it asserts has changed, and the accelerant rung — a live-synced copy of the
/// author's own fold — is never older than the floor it would be overwriting. So the
/// hazard the manifest's second term guards against, a clobbered cache sitting stale,
/// doesn't arise: whatever else writes here writes something at least as fresh.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct TallyMark {
    url: String,
}

/// The tallies pointer held for a channel, or None if this loop has never read one.
async fn read_tally_mark(ctx: &PullContext, channel_id: &str) -> Option<TallyMark> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        pin_derive::TALLY_PULL_COLLECTION,
        channel_id,
    )
    .await
    .ok()??;
    serde_json::from_slice(&raw).ok()
}

/// Record the pointer a pass read to completion. Written after the counts land, never
/// before: a mark recorded on a read that failed would skip the channel until its author
/// next published.
async fn write_tally_mark(ctx: &PullContext, channel_id: &str, mark: &TallyMark) {
    let Ok(bytes) = serde_json::to_vec(mark) else {
        return;
    };
    let _ = write_record(
        &ctx.doc,
        ctx.author_id,
        pin_derive::TALLY_PULL_COLLECTION,
        channel_id,
        bytes,
    )
    .await;
}

/// Read one subscribed channel's published counts into the cache its own screens read.
///
/// The floor rung from the reader's side. A channel with no tallies pointer is the common
/// case rather than a failure — nobody has endorsed anything in it — and reads as nothing
/// to do.
async fn pull_tallies(
    ctx: &PullContext,
    channel_id: &str,
    k: &[u8; 32],
    outcome: &mut PullOutcome,
) {
    let Ok(Some(item_url)) = pin_channel::resolve_tallies_url(k).await else {
        return;
    };
    let mark = TallyMark { url: item_url };
    if read_tally_mark(ctx, channel_id).await.as_ref() == Some(&mark) {
        outcome.tallies_skipped += 1;
        return;
    }

    let Ok(json) = pin_channel::fetch_tallies(&ctx.sia, k, &mark.url).await else {
        return;
    };
    let Ok(map) = serde_json::from_str::<BTreeMap<String, Aggregate>>(&json) else {
        return;
    };

    for (subject, aggregate) in &map {
        if cache_tally(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            channel_id,
            subject,
            aggregate,
        )
        .await
        {
            outcome.tallies += 1;
        }
    }

    // Subjects the author no longer publishes counts for. Their endorsements were
    // withdrawn, so a cached count would keep asserting a set that no longer exists.
    for rkey in cached_tally_rkeys(ctx, channel_id).await {
        let Some((_, subject)) = rkey.split_once(':') else {
            continue;
        };
        if !map.contains_key(subject) {
            clear_cached_tally(&ctx.doc, ctx.author_id, channel_id, subject).await;
        }
    }

    write_tally_mark(ctx, channel_id, &mark).await;
}

/// The cached-tally rkeys belonging to one channel.
async fn cached_tally_rkeys(ctx: &PullContext, channel_id: &str) -> Vec<String> {
    list_rkeys(&ctx.doc, ctx.author_id, pin_derive::TALLY_COLLECTION)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|rkey| pin_derive::tally_rkey_channel(rkey) == Some(channel_id))
        .collect()
}

/// The content hash of a record, without fetching its bytes.
///
/// Entry metadata only — enough to tell whether a cached blob is still the one we put
/// there, which is all the skip needs.
async fn record_content_hash(
    doc: &Doc,
    author_id: AuthorId,
    collection: &str,
    rkey: &str,
) -> Option<String> {
    let entry = doc
        .get_exact(author_id, record_key(collection, rkey), false)
        .await
        .ok()??;
    Some(entry.content_hash().to_string())
}

/// The subscription list, as much of it as a pass needs.
///
/// Deserialized permissively: this reads a record the frontend writes, and a settings
/// record that grows a field must not stop the loop. Only the fields below are
/// required to mean anything.
#[derive(serde::Deserialize)]
pub(crate) struct SettingsView {
    #[serde(default)]
    pub(crate) subscriptions: Vec<SubscriptionView>,
    #[serde(default, rename = "myChannels")]
    pub(crate) my_channels: Vec<OwnedChannelView>,
    /// Copied into the published directory untouched — the Curator publishes a
    /// profile, it doesn't own its shape.
    #[serde(default)]
    pub(crate) profile: Option<serde_json::Value>,
    /// Public channel-follows, likewise opaque.
    #[serde(default)]
    pub(crate) follows: Vec<serde_json::Value>,
    /// The did:dhts of identities followed wholesale.
    #[serde(default, rename = "handleFollows")]
    pub(crate) handle_follows: Vec<String>,
}

#[derive(serde::Deserialize)]
pub(crate) struct SubscriptionView {
    #[serde(rename = "channelID")]
    pub(crate) channel_id: String,
    #[serde(rename = "channelKey")]
    pub(crate) channel_key: String,
    /// The author's did:dht. Absent on a subscription made from a legacy handle URL, which
    /// simply means the crawl has no identity to read their endorsements from.
    #[serde(default, rename = "didDht")]
    pub(crate) did_dht: Option<String>,
}

#[derive(serde::Deserialize)]
pub(crate) struct OwnedChannelView {
    #[serde(rename = "channelID")]
    pub(crate) channel_id: String,
    /// The channel's K — the keep-alive loop needs it to derive the locator it
    /// republishes to. Defaulted like everything else here: one malformed entry must
    /// not stop a whole settings record from decoding.
    #[serde(default, rename = "channelKey")]
    pub(crate) channel_key: String,
    /// The display name, kept in step with the manifest by the edit path.
    #[serde(default)]
    pub(crate) name: String,
    /// 'public' or 'obscure', set at creation and sticky. Absent means UNKNOWN —
    /// a channel created before settings recorded it — and unknown is never
    /// advertised, because guessing 'public' would enumerate an obscure channel.
    #[serde(default)]
    pub(crate) visibility: Option<String>,
    /// Whether this public channel is advertised in the identity's directory.
    /// Absent means advertised — the default, claimed at creation.
    #[serde(default)]
    pub(crate) advertised: Option<bool>,
}

/// What this identity last published to Sia under some rkey, and the fingerprint of
/// the content it was, so a republish can tell "same document, refresh its TTL" from
/// "new document, mint a new object".
///
/// Shared with the frontend, which writes the per-channel entries. `fp` is only set by
/// the directory publisher; both sides ignore what they don't set.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct PublishedState {
    pub(crate) id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(default, rename = "olderId", skip_serializing_if = "Option::is_none")]
    pub(crate) older_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fp: Option<String>,
}

/// Record what was just published under `rkey`.
///
/// Best-effort, and quietly so: losing this record means the blob it supersedes has
/// nothing left that knows to reclaim it, which is waste rather than breakage.
///
/// Takes the pieces rather than a context for the same reason `read_record` does — the
/// directory publisher and the snapshot loop both write these, and they differ only in
/// what else they hold.
pub(crate) async fn write_published(
    doc: &Doc,
    author_id: AuthorId,
    published_key: &[u8; 32],
    rkey: &str,
    state: &PublishedState,
) {
    let Ok(json) = serde_json::to_vec(state) else {
        return;
    };
    let Ok(sealed) = pin_crypto::encrypt(published_key, &json) else {
        return;
    };
    let _ = doc
        .set_bytes(
            author_id,
            record_key(pin_derive::PUBLISHED_COLLECTION, rkey),
            sealed.into_bytes(),
        )
        .await;
}

/// What was last published under `rkey`, or `None` when there's no record, or one this
/// identity can't open.
///
/// Not knowing is survivable at every call site — skip the channel, skip the reclaim,
/// mirror again — so this reports absence rather than an error. Guessing would not be
/// survivable: a wrong object id here is a reclaim of bytes something still points at.
///
/// One reader for all of them. Three loops read these records and the frontend writes
/// the per-channel ones, so a second view of the same shape is the drift this crate
/// exists to prevent — and its failure would be silent, since a field read under the
/// wrong name simply comes back absent.
///
/// Note `id` is the one field with no default, so a record missing it reads as absent
/// rather than as a partial answer. Both writers always emit it — it's required on the
/// frontend's `PublishedObject` too — and a record naming no object has nothing to
/// keep alive and nothing to reclaim, so refusing it is the honest reading.
pub(crate) async fn read_published(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    published_key: &[u8; 32],
    rkey: &str,
) -> Option<PublishedState> {
    let raw = read_record(
        doc,
        blobs,
        author_id,
        pin_derive::PUBLISHED_COLLECTION,
        rkey,
    )
    .await
    .ok()
    .flatten()?;
    let blob = String::from_utf8(raw).ok()?;
    let json = pin_crypto::decrypt(published_key, &blob).ok()?;
    serde_json::from_slice(&json).ok()
}

/// Read a record's bytes out of the doc, or `None` when it isn't there.
///
/// Takes the pieces rather than a context so every loop in this crate can use it —
/// they hold the same doc and blobs store, and differ only in what else they need.
pub(crate) async fn read_record(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    collection: &str,
    rkey: &str,
) -> Result<Option<Vec<u8>>, String> {
    let entry = doc
        .get_exact(author_id, record_key(collection, rkey), false)
        .await
        .map_err(|e| format!("get {collection}/{rkey}: {e}"))?;
    match entry {
        None => Ok(None),
        Some(e) => {
            let bytes = blobs
                .get_bytes(e.content_hash())
                .await
                .map_err(|e| format!("get_bytes {collection}/{rkey}: {e}"))?;
            Ok(Some(bytes.to_vec()))
        }
    }
}

/// Write a record into this identity's doc.
pub(crate) async fn write_record(
    doc: &Doc,
    author_id: AuthorId,
    collection: &str,
    rkey: &str,
    value: Vec<u8>,
) -> Result<(), String> {
    doc.set_bytes(author_id, record_key(collection, rkey), value)
        .await
        .map(|_| ())
        .map_err(|e| format!("put {collection}/{rkey}: {e}"))
}

/// Remove a record from this identity's doc.
pub(crate) async fn delete_record(
    doc: &Doc,
    author_id: AuthorId,
    collection: &str,
    rkey: &str,
) -> Result<(), String> {
    doc.del(author_id, record_key(collection, rkey))
        .await
        .map(|_| ())
        .map_err(|e| format!("del {collection}/{rkey}: {e}"))
}

/// The rkeys present in one collection.
///
/// A full scan filtered by prefix, because that is what the store offers — fine at the
/// scale one identity's doc reaches, and the alternative would be keeping a second
/// index in step with the first.
pub(crate) async fn list_rkeys(
    doc: &Doc,
    _author_id: AuthorId,
    collection: &str,
) -> Result<Vec<String>, String> {
    use n0_future::StreamExt as _;

    let prefix = pin_derive::collection_prefix(collection);
    let stream = doc
        .get_many(iroh_docs::store::Query::all().build())
        .await
        .map_err(|e| format!("list {collection}: {e}"))?;
    let mut stream = Box::pin(stream);
    let mut out = Vec::new();
    while let Some(Ok(entry)) = stream.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();
        if let Some(rkey) = key.strip_prefix(&prefix) {
            out.push(rkey.to_string());
        }
    }
    Ok(out)
}

/// The identity's own settings record, decrypted and decoded.
///
/// Every loop starts here: settings is where the doc says what this identity
/// subscribes to and what it owns.
pub(crate) async fn read_settings(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    app_key: &[u8; 32],
) -> Result<SettingsView, String> {
    let raw = read_record(doc, blobs, author_id, SETTINGS_COLLECTION, SETTINGS_RKEY)
        .await?
        .ok_or("no settings record yet")?;
    let blob = String::from_utf8(raw).map_err(|_| "settings blob is not UTF-8")?;
    let key = settings_key(app_key);
    let json = pin_crypto::decrypt_settings(&key, &blob)?;
    serde_json::from_slice(&json).map_err(|e| format!("settings decode: {e}"))
}

/// Which channels a pass should keep cached: subscribed and not the user's own.
///
/// Own channels are excluded because their freshest state is local — the app reflects a
/// publish immediately — so a cached copy could only ever be the same or staler, and
/// serving a staler one would make a just-published post disappear.
fn wanted_channels(settings: &SettingsView) -> Vec<(&str, &str)> {
    let owned: std::collections::HashSet<&str> = settings
        .my_channels
        .iter()
        .map(|c| c.channel_id.as_str())
        .collect();
    settings
        .subscriptions
        .iter()
        .filter(|s| !owned.contains(s.channel_id.as_str()))
        .map(|s| (s.channel_id.as_str(), s.channel_key.as_str()))
        .collect()
}

/// A manifest's version marker. Every mutation stamps a fresh `publishedAt`, and all
/// of one channel's manifests come from one author's clock, so comparing two of them
/// compares versions rather than guessing.
#[derive(serde::Deserialize)]
struct ManifestVersion {
    #[serde(rename = "publishedAt")]
    published_at: String,
}

fn published_at(manifest_json: &str) -> Option<String> {
    serde_json::from_str::<ManifestVersion>(manifest_json)
        .ok()
        .map(|m| m.published_at)
}

/// Whether a freshly-resolved manifest is OLDER than the one already cached — in which
/// case caching it would move the channel backwards.
///
/// Reads the cached blob to compare, which means opening it: the loop holds `K` for
/// every channel it pulls (it can't resolve without one), so this reads nothing it
/// isn't already entitled to. It looks at one field and keeps none of it.
///
/// Anything unreadable — no cache, a blob that won't open, a manifest without the
/// field — answers "not older", so the write proceeds. A guard that can't compare
/// should get out of the way rather than block a channel forever.
pub(crate) fn is_older_than_cached(
    channel_key: &[u8; 32],
    resolved_json: &str,
    cached_blob: Option<&[u8]>,
) -> bool {
    let Some(cached) = cached_blob else {
        return false;
    };
    let Ok(cached_str) = std::str::from_utf8(cached) else {
        return false;
    };
    let Ok(cached_json) = pin_channel::open_blob(channel_key, cached_str) else {
        return false;
    };
    match (published_at(resolved_json), published_at(&cached_json)) {
        // Strictly older only. Equal timestamps mean the same instant with different
        // content, and refusing that would be the worse error.
        (Some(fresh), Some(held)) => fresh < held,
        _ => false,
    }
}

/// One pass: refresh every subscribed channel's cached manifest and published counts, and
/// drop the cache for channels no longer subscribed.
///
/// Never gives up the whole pass for one channel. A channel that fails is counted and
/// left for the next pass — one unreachable author must not stop the rest from being
/// kept current.
pub async fn pull_once(ctx: &PullContext) -> Result<PullOutcome, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;

    let wanted = wanted_channels(&settings);
    let mut outcome = PullOutcome::default();

    for (channel_id, channel_key_b64) in &wanted {
        let Some(k) = pin_crypto::channel_key_from_base64(channel_key_b64) else {
            // A key we can't decode can never resolve; counting it as failed would
            // make the next pass retry something that cannot succeed.
            continue;
        };
        // Independent of the manifest below: a channel whose posts haven't moved can still
        // have counts that have, so neither half's skip may stand in for the other's.
        pull_tallies(ctx, channel_id, &k, &mut outcome).await;

        let item_url = match pin_channel::resolve_url(&k).await {
            Ok(Some(url)) => url,
            Ok(None) => {
                outcome.unresolved += 1;
                continue;
            }
            Err(_) => {
                outcome.failed += 1;
                continue;
            }
        };

        // Sia is content-addressed, so an unchanged pointer means byte-identical bytes:
        // downloading would reproduce exactly what is already cached. Confirmed against
        // the cache too, because this record has other writers.
        let cached_hash =
            record_content_hash(&ctx.doc, ctx.author_id, SUB_COLLECTION, channel_id).await;
        let mark = PullMark {
            url: item_url,
            cached: cached_hash.unwrap_or_default(),
        };
        if !mark.cached.is_empty()
            && may_skip_pull(read_pull_mark(ctx, channel_id).await.as_ref(), &mark)
        {
            outcome.skipped += 1;
            continue;
        }

        match pin_channel::fetch(&ctx.sia, &k, &mark.url).await {
            Ok(resolved) => {
                // What's already cached may be NEWER than what we just resolved. A
                // browser resolves through pkarr relays that lag minutes behind the
                // DHT a desktop reads directly, so a tab syncing with a desktop
                // routinely holds a fresher manifest than its own pass can find.
                // Writing anyway would un-publish a post: the record is what the
                // reader serves and what syncs back to the peer that had it right.
                let cached = read_record(
                    &ctx.doc,
                    &ctx.blobs,
                    ctx.author_id,
                    SUB_COLLECTION,
                    channel_id,
                )
                .await
                .ok()
                .flatten();
                if is_older_than_cached(&k, &resolved.manifest_json, cached.as_deref()) {
                    outcome.stale += 1;
                    continue;
                }
                match ctx
                    .doc
                    .set_bytes(
                        ctx.author_id,
                        record_key(SUB_COLLECTION, channel_id),
                        resolved.blob.into_bytes(),
                    )
                    .await
                {
                    Ok(_) => {
                        outcome.cached += 1;
                        // After the write, never before: a mark recorded on a cache that
                        // didn't land would skip this channel until the author republished.
                        // Re-read rather than reusing the hash from above, because what we
                        // just wrote is what a later pass has to match.
                        if let Some(cached) =
                            record_content_hash(&ctx.doc, ctx.author_id, SUB_COLLECTION, channel_id)
                                .await
                        {
                            write_pull_mark(
                                ctx,
                                channel_id,
                                &PullMark {
                                    url: mark.url,
                                    cached,
                                },
                            )
                            .await;
                        }
                    }
                    Err(_) => outcome.failed += 1,
                }
            }
            Err(_) => outcome.failed += 1,
        }
    }

    outcome.dropped = drop_unsubscribed(ctx, &wanted).await;
    drop_tallies_for_gone_channels(ctx, &settings, &wanted).await;
    Ok(outcome)
}

/// The channels whose cached tallies are still wanted.
///
/// Owned channels are kept although they are absent from the subscribed set — that set
/// excludes them deliberately, and their tallies are written by the engagement loop, not
/// this one. Dropping on the subscribed set alone would delete a channel's own counts
/// every pass, for the engagement loop to write straight back.
fn tally_channels_to_keep<'a>(
    settings: &'a SettingsView,
    wanted: &[(&'a str, &'a str)],
) -> std::collections::HashSet<&'a str> {
    wanted
        .iter()
        .map(|(id, _)| *id)
        .chain(settings.my_channels.iter().map(|c| c.channel_id.as_str()))
        .collect()
}

/// Delete cached tallies for channels this identity neither follows nor owns.
async fn drop_tallies_for_gone_channels(
    ctx: &PullContext,
    settings: &SettingsView,
    wanted: &[(&str, &str)],
) {
    let keep = tally_channels_to_keep(settings, wanted);

    for rkey in list_rkeys(&ctx.doc, ctx.author_id, pin_derive::TALLY_COLLECTION)
        .await
        .unwrap_or_default()
    {
        // A key with no channel can't be attributed, so it goes: it is not a tally any
        // reader can find, since a reader looks one up by channel and subject.
        let gone = pin_derive::tally_rkey_channel(&rkey).is_none_or(|id| !keep.contains(id));
        if gone {
            let _ =
                delete_record(&ctx.doc, ctx.author_id, pin_derive::TALLY_COLLECTION, &rkey).await;
        }
    }
}

/// Delete cached manifests for channels the user no longer subscribes to (or that are
/// now their own). Best-effort: a stray cached record is opaque and small, so a failed
/// delete is not worth failing a pass over.
async fn drop_unsubscribed(ctx: &PullContext, wanted: &[(&str, &str)]) -> usize {
    use n0_future::StreamExt as _;

    let keep: std::collections::HashSet<&str> = wanted.iter().map(|(id, _)| *id).collect();
    let prefix = pin_derive::collection_prefix(SUB_COLLECTION);

    let Ok(stream) = ctx
        .doc
        .get_many(iroh_docs::store::Query::all().build())
        .await
    else {
        return 0;
    };
    let mut stream = Box::pin(stream);
    let mut stale = Vec::new();
    while let Some(Ok(entry)) = stream.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();
        let Some(rkey) = key.strip_prefix(&prefix) else {
            continue;
        };
        if !keep.contains(rkey) {
            stale.push(rkey.to_string());
        }
    }

    let mut dropped = 0;
    for rkey in stale {
        if ctx
            .doc
            .del(ctx.author_id, record_key(SUB_COLLECTION, &rkey))
            .await
            .is_ok()
        {
            dropped += 1;
        }
    }
    dropped
}

/// Pass, wait, repeat — forever. The loop itself, cadence included.
///
/// Returned rather than spawned, so the caller places it on whichever executor it
/// already has: the Sia runtime natively, the browser's task queue on wasm. That
/// placement is a genuine difference (there is one executor to choose from in a
/// browser and several natively); the loop it runs is the same either way.
///
/// Leaving the spawn to the caller also puts the `Send` bound where it's real. Tokio
/// requires it and imposes it at the call site; a browser task doesn't and can't, since
/// the report callback there is a JS closure. Neither has to be stated here.
///
/// A failed pass is not fatal: the causes — Sia not connected yet, a settings record
/// that hasn't synced, the network — are all things the next pass may find resolved.
pub async fn run_pull_loop(
    ctx: PullContext,
    cadence: Duration,
    on_pass: impl Fn(Result<PullOutcome, String>),
) -> ! {
    loop {
        let outcome = pull_once(&ctx).await;
        on_pass(outcome);
        n0_future::time::sleep(cadence).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(json: &str) -> SettingsView {
        serde_json::from_str(json).unwrap()
    }

    fn published(iso: &str) -> String {
        format!(r#"{{"version":1,"publishedAt":"{iso}","items":[]}}"#)
    }

    fn sealed(k: &[u8; 32], iso: &str) -> Vec<u8> {
        pin_crypto::encrypt(k, published(iso).as_bytes())
            .unwrap()
            .into_bytes()
    }

    #[test]
    fn publish_state_decodes_what_the_frontend_writes() {
        // Verbatim from `lib/publishState.ts`'s `PublishedObject`. Field names are
        // asserted rather than trusted: this repo has shipped a descriptor whose URL
        // arrived under a name nothing read, and a mismatch here wouldn't error — the
        // field would simply come back absent, and a locator nobody republishes ages
        // off the DHT until the channel stops resolving.
        let written = r#"{"id":"obj-2","url":"sia://obj-2#encryption_key=k","olderId":"obj-1"}"#;
        let state: PublishedState = serde_json::from_str(written).unwrap();
        assert_eq!(state.id, "obj-2");
        assert_eq!(state.url.as_deref(), Some("sia://obj-2#encryption_key=k"));
        // `olderId` is the one whose silent absence costs bytes rather than
        // discoverability: it names the generation a publish is due to reclaim, so a
        // field read under the wrong name leaks a superseded object forever.
        assert_eq!(state.older_id.as_deref(), Some("obj-1"));
    }

    #[test]
    fn a_record_without_a_url_is_not_a_pointer() {
        // `url` is optional on the frontend's type, and a record without one names
        // nothing to republish — the channel counts as unknown, not as a failure.
        let state: PublishedState = serde_json::from_str(r#"{"id":"obj-1"}"#).unwrap();
        assert!(state.url.is_none());
        assert!(state.older_id.is_none());
        assert!(state.fp.is_none());
    }

    #[test]
    fn publish_state_round_trips_through_what_it_writes() {
        // The Curator writes these too, and the frontend reads them. Absent fields
        // must stay absent rather than serializing as null, which is what the
        // `skip_serializing_if` attributes are for.
        let state = PublishedState {
            id: "obj-1".into(),
            url: None,
            older_id: None,
            fp: None,
        };
        assert_eq!(serde_json::to_string(&state).unwrap(), r#"{"id":"obj-1"}"#);
    }

    #[test]
    fn a_resolve_older_than_the_cache_is_refused() {
        // The bug this exists for: a browser resolves through relays that lag the DHT,
        // so its own pass can find an OLDER manifest than the one a desktop already
        // synced into the cache. Writing it would un-publish a post that's on screen.
        let k = [7u8; 32];
        let cached = sealed(&k, "2026-08-01T12:00:00.000Z");
        assert!(is_older_than_cached(
            &k,
            &published("2026-08-01T11:00:00.000Z"),
            Some(&cached)
        ));
    }

    #[test]
    fn a_newer_or_equal_resolve_is_written() {
        let k = [7u8; 32];
        let cached = sealed(&k, "2026-08-01T12:00:00.000Z");
        // Newer — the ordinary case.
        assert!(!is_older_than_cached(
            &k,
            &published("2026-08-01T13:00:00.000Z"),
            Some(&cached)
        ));
        // Same instant, and by construction different content, since an identical
        // manifest would be a harmless rewrite either way. Refusing would be worse
        // than allowing.
        assert!(!is_older_than_cached(
            &k,
            &published("2026-08-01T12:00:00.000Z"),
            Some(&cached)
        ));
    }

    #[test]
    fn a_guard_that_cannot_compare_gets_out_of_the_way() {
        // Nothing cached yet — the first pass must always write.
        let k = [7u8; 32];
        assert!(!is_older_than_cached(
            &k,
            &published("2026-01-01T00:00:00Z"),
            None
        ));
        // A blob sealed under a DIFFERENT key won't open. Blocking the channel forever
        // would be a worse answer than writing a manifest we can read.
        let other = sealed(&[9u8; 32], "2099-01-01T00:00:00Z");
        assert!(!is_older_than_cached(
            &k,
            &published("2026-01-01T00:00:00Z"),
            Some(&other)
        ));
        // A manifest with no version marker can't be ranked, so it doesn't block.
        let cached = sealed(&k, "2099-01-01T00:00:00Z");
        assert!(!is_older_than_cached(&k, r#"{"items":[]}"#, Some(&cached)));
    }

    #[test]
    fn wanted_channels_excludes_the_users_own() {
        // Owners auto-subscribe to their own channels, so the subscription list
        // contains them — and caching one could serve a staler copy than the local
        // state a publish just wrote.
        let s = settings(
            r#"{
              "subscriptions": [
                {"channelID": "aaa", "channelKey": "k1"},
                {"channelID": "bbb", "channelKey": "k2"}
              ],
              "myChannels": [{"channelID": "aaa"}]
            }"#,
        );
        assert_eq!(wanted_channels(&s), vec![("bbb", "k2")]);
    }

    #[test]
    fn settings_decode_tolerates_unknown_and_missing_fields() {
        // The frontend owns this record's shape and will add to it. A settings record
        // carrying a field this crate has never heard of must not stop the loop.
        let s = settings(
            r#"{
              "version": 3,
              "theme": "rounded",
              "somethingAddedLater": {"nested": true},
              "subscriptions": [{"channelID": "aaa", "channelKey": "k1", "label": "x"}]
            }"#,
        );
        assert_eq!(wanted_channels(&s), vec![("aaa", "k1")]);

        // And an absent list is an empty one, not a decode failure.
        let empty = settings(r#"{"version": 3}"#);
        assert!(wanted_channels(&empty).is_empty());
    }

    // Channel-key decoding is pin-crypto's now, and tested there — one home for the
    // encoding both the frontend and this loop have to agree on.

    fn pull_mark(url: &str, cached: &str) -> PullMark {
        PullMark {
            url: url.to_string(),
            cached: cached.to_string(),
        }
    }

    #[test]
    fn a_channel_never_pulled_is_downloaded() {
        assert!(!may_skip_pull(None, &pull_mark("sia://a", "h1")));
    }

    #[test]
    fn an_unchanged_pointer_over_an_untouched_cache_is_left_alone() {
        // The steady state, and the whole saving: the pointer proves the bytes behind it
        // are the ones already cached, so the download would reproduce the cache exactly.
        let held = pull_mark("sia://a", "h1");
        assert!(may_skip_pull(Some(&held), &pull_mark("sia://a", "h1")));
    }

    #[test]
    fn a_moved_pointer_is_downloaded_again() {
        let held = pull_mark("sia://a", "h1");
        assert!(!may_skip_pull(Some(&held), &pull_mark("sia://b", "h1")));
    }

    #[test]
    fn a_cache_something_else_overwrote_is_downloaded_again() {
        // The term the crawl's mark doesn't need. This record has three writers — this
        // loop, the live-sync rung, and a peer instance's copy — so an unchanged pointer
        // only says the SOURCE is unmoved. Skip on that alone and a cache clobbered by
        // anything else stays wrong until the author happens to publish again.
        let held = pull_mark("sia://a", "h1");
        assert!(!may_skip_pull(Some(&held), &pull_mark("sia://a", "h2")));
    }

    // --- the tally cache ------------------------------------------------------

    fn tally(count: usize, root: &str, updated: &str, retention: Option<&str>) -> Aggregate {
        let mut kinds = BTreeMap::new();
        kinds.insert(
            pin_engagement::KIND_LIKE.to_string(),
            pin_engagement::KindTally {
                count,
                set_root: root.to_string(),
                sample_actors: vec!["did:dht:alice".to_string()],
                retention_checked_at: retention.map(str::to_string),
            },
        );
        Aggregate {
            kinds,
            updated_at: updated.to_string(),
        }
    }

    #[test]
    fn a_cached_tally_is_not_rewritten_when_only_the_clock_moved() {
        // The same guard the floor has, and needed here for a sharper reason: this doc is
        // snapshotted WHOLE to Sia against a fingerprint of its contents, so a record
        // rewritten every pass would mint a fresh snapshot object every cadence.
        let held = tally(3, "root-a", "2026-08-12T10:00:00.000Z", None);
        let fresh = tally(
            3,
            "root-a",
            "2026-08-12T10:10:00.000Z",
            Some("2026-08-12T10:10:00.000Z"),
        );
        assert!(cache_is_current(Some(&held), &fresh));
    }

    #[test]
    fn a_cached_tally_is_rewritten_when_its_count_moved() {
        let held = tally(3, "root-a", "2026-08-12T10:00:00.000Z", None);
        let fresh = tally(4, "root-b", "2026-08-12T10:00:00.000Z", None);
        assert!(!cache_is_current(Some(&held), &fresh));
    }

    #[test]
    fn a_cached_tally_is_rewritten_when_its_set_moved_under_the_same_count() {
        let held = tally(3, "root-a", "2026-08-12T10:00:00.000Z", None);
        let fresh = tally(3, "root-b", "2026-08-12T10:00:00.000Z", None);
        assert!(!cache_is_current(Some(&held), &fresh));
    }

    #[test]
    fn a_first_count_is_always_written() {
        // Nothing held can't be current, or a subject's first count would never reach the
        // screen — the cache would skip the one write that populates it.
        let fresh = tally(1, "root-a", "2026-08-12T10:00:00.000Z", None);
        assert!(!cache_is_current(None, &fresh));
    }

    #[test]
    fn a_count_older_than_the_cached_one_is_refused() {
        // A browser resolves the floor through relays minutes behind the DHT, while the
        // author's own fold arrives over live sync in seconds. Taking the floor's answer
        // unconditionally would walk the count backwards.
        let held = tally(5, "root-b", "2026-08-12T10:10:00.000Z", None);
        let fresh = tally(3, "root-a", "2026-08-12T10:00:00.000Z", None);
        assert!(tally_is_older(Some(&held), &fresh));
    }

    #[test]
    fn a_count_from_the_same_instant_is_taken() {
        // Strictly older only, like the manifest's guard: equal stamps mean one instant
        // with different content, and refusing that would be the worse error.
        let held = tally(3, "root-a", "2026-08-12T10:00:00.000Z", None);
        let fresh = tally(4, "root-b", "2026-08-12T10:00:00.000Z", None);
        assert!(!tally_is_older(Some(&held), &fresh));
    }

    #[test]
    fn a_count_with_nothing_cached_is_taken() {
        let fresh = tally(1, "root-a", "2026-08-12T10:00:00.000Z", None);
        assert!(!tally_is_older(None, &fresh));
    }

    #[test]
    fn a_channels_own_counts_survive_the_drop() {
        // Owned channels are excluded from the subscribed set on purpose, and their
        // tallies come from the engagement loop rather than this one. Dropping on the
        // subscribed set alone would delete them every pass.
        let s = settings(
            r#"{
              "subscriptions": [
                {"channelID": "aaa", "channelKey": "k1"},
                {"channelID": "bbb", "channelKey": "k2"}
              ],
              "myChannels": [{"channelID": "aaa"}]
            }"#,
        );
        let keep = tally_channels_to_keep(&s, &wanted_channels(&s));
        assert!(keep.contains("aaa"));
        assert!(keep.contains("bbb"));
    }

    #[test]
    fn an_unsubscribed_channels_counts_are_dropped() {
        let s = settings(r#"{"subscriptions": [], "myChannels": []}"#);
        assert!(!tally_channels_to_keep(&s, &wanted_channels(&s)).contains("gone"));
    }
}
