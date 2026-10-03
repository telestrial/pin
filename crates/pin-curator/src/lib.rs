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
mod discover;
mod engagement;
mod identity;
mod instance;
mod keepalive;
pub mod members;
pub mod membership;
pub mod net;
mod reading;
mod rendezvous;
mod repack;
mod snapshot;
mod testnet;
pub use channeldoc::{
    channel_docs_once, run_channel_doc_loop, ChannelDocContext, ChannelDocOutcome,
};
pub use channelsync::{run_channel_sync_loop, ChannelSyncContext, ChannelSyncOutcome};
pub use deliver::{deliver_once, run_deliver_loop, DeliverContext, DeliverOutcome};
pub use discover::{
    discover_once, edges_of, frontier, run_discover_loop, Candidate, DirectoryRecord,
    DirectoryTier, DiscoverContext, DiscoverOutcome, MAX_FULL, MAX_RESOLVES_PER_PASS,
    REFRESH_PER_PASS,
};
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
#[cfg(test)]
use reading::reading;
pub use reading::{reading_json, ReadChannel, Reading};
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
    /// What climbing this identity's memberships did, before anything was read.
    pub climb: membership::ClimbOutcome,
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

/// What one subject's conversation ASSERTS, with the volatile part stripped out.
///
/// `updatedAt` records when the fold RAN, not when a comment arrived, and the engagement
/// loop re-folds every subject it observed rather than only the ones that moved. So a
/// comparison covering it reports a change on every crawling pass for a conversation
/// nobody touched.
///
/// The comments are signed records, so comparing them IS the set comparison. A tally
/// needs a `setRoot` to do this because it has folded its set down to a number; a
/// conversation still carries the set.
pub(crate) fn thread_is_current(
    held: Option<&pin_engagement::Conversation>,
    fresh: &pin_engagement::Conversation,
) -> bool {
    held.is_some_and(|h| h.comments == fresh.comments)
}

/// Whether a conversation would replace a held one with an OLDER reading of the same
/// comments.
///
/// The same multi-feeder guard the cached tally takes, for the same reason: the
/// accelerant rung and the floor rung both land here, and the floor can arrive holding
/// an older fold.
pub(crate) fn thread_is_older(
    held: Option<&pin_engagement::Conversation>,
    fresh: &pin_engagement::Conversation,
) -> bool {
    held.is_some_and(|h| fresh.updated_at < h.updated_at)
}

/// Cache one subject's published conversation where this identity's screens read it.
///
/// Written only when the comments have changed. This doc syncs to every instance of the
/// identity and is snapshotted whole to Sia against a fingerprint of its contents, so a
/// record rewritten each pass because a timestamp moved would mint a fresh snapshot
/// object every cadence. The cost is that a cached `updatedAt` lags until the
/// conversation itself moves — the same trade the cached tally makes.
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
    if thread_is_current(held.as_ref(), conversation)
        || thread_is_older(held.as_ref(), conversation)
    {
        return false;
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

/// Drop one subject's cached tally, for a subject nothing endorses any more. Absent and
/// zero read the same to a screen, so the record goes rather than sitting at zero.
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
    author: &str,
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

    let Ok(json) =
        pin_channel::fetch_tallies(&ctx.sia, k, &mark.url, pin_channel::Signer::Author(author))
            .await
    else {
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
    /// Whether its posts belong on the author's profile feed. Absent means yes.
    ///
    /// Separate from `advertised`, which decides whether the channel is in the directory
    /// at all: a channel can be findable and followable while its posts stay off the page
    /// that stands for its author.
    #[serde(default, rename = "showOnProfile")]
    pub(crate) show_on_profile: Option<bool>,
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
    #[cfg(test)]
    reads::count();

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

/// This identity's own did:dht, the author every channel it owns is signed by.
pub(crate) fn own_did(app_key: &[u8; 32]) -> String {
    let key = pin_pkarr::public_key_from_seed(&pin_derive::did_dht_seed(app_key))
        .expect("a 32-byte seed always makes a key");
    format!("did:dht:{key}")
}

/// The content key a channel this identity reads is sealed under, from what it already
/// holds: derived for a channel it owns, read from the head of the cached manifest for any
/// other — or, when that head carries no read key, the key this identity climbed to as a
/// member for the epoch the head says it was sealed at.
///
/// `author` is whose signature the cached head must carry, and is not consulted for a
/// channel this identity owns. `None` when no manifest is cached yet, which is the ordinary state of a channel
/// subscribed to moments ago and is settled by the pull loop's next pass. A caller treats it
/// as "not yet", never as a key it may do without.
pub(crate) async fn held_content_key(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    app_key: &[u8; 32],
    settings: &SettingsView,
    channel_id: &str,
    channel_key: &[u8; 32],
    author: &str,
) -> Option<pin_channel::ContentKey> {
    if settings
        .my_channels
        .iter()
        .any(|c| c.channel_id == channel_id)
    {
        return channel_sealing(doc, blobs, author_id, app_key, settings, channel_key)
            .await
            .ok()
            .map(|s| s.content);
    }
    let raw = read_record(doc, blobs, author_id, SUB_COLLECTION, channel_id)
        .await
        .ok()
        .flatten()?;
    let blob = String::from_utf8(raw).ok()?;
    let signer = pin_channel::Signer::Author(author);
    if let Ok(content) =
        pin_channel::content_key(channel_key, &blob, pin_channel::Kind::Manifest, signer)
    {
        return Some(content);
    }
    let epoch =
        pin_channel::head_epoch(channel_key, &blob, pin_channel::Kind::Manifest, signer).ok()?;
    membership::held_key(doc, blobs, author_id, channel_id, epoch).await
}

/// What a reader of a channel object may hold besides K.
///
/// The doc keeps the content keys this identity climbed to as a member; the AppKey derives
/// an author's keys to their own channels. Either may be absent — a tab with no doc open, a
/// caller that is not the author — and each only widens what opens.
#[derive(Clone, Copy, Default)]
pub struct Holdings<'a> {
    pub doc: Option<(&'a Doc, &'a Store, AuthorId)>,
    pub app_key: Option<&'a [u8; 32]>,
}

/// Open a channel object, answering with its payload and the content key it opened with:
/// by the read key in its head; failing that as its author, when `author` is this identity;
/// failing that by the key this identity climbed to as a member, for the epoch its head
/// says.
///
/// Verified on every route: the head is checked against `author` before anything in it is
/// believed, so a forged object fails here whichever route it would have taken.
pub async fn open_channel_object(
    holdings: &Holdings<'_>,
    channel_key: &[u8; 32],
    blob: &str,
    kind: pin_channel::Kind,
    author: &str,
) -> Result<(String, pin_channel::ContentKey), String> {
    let signer = pin_channel::Signer::Author(author);
    let (payload, content) = match pin_channel::open(channel_key, blob, kind, signer) {
        Ok(opened) => (opened.payload, opened.content),
        Err(no_read_key) => {
            let own = holdings
                .app_key
                .filter(|k| bare_did(&own_did(k)) == bare_did(author));
            if let Some(app_key) = own {
                pin_channel::open_as_author(app_key, channel_key, blob, kind)?
            } else {
                let Some((doc, blobs, author_id)) = holdings.doc else {
                    return Err(no_read_key);
                };
                let epoch = pin_channel::head_epoch(channel_key, blob, kind, signer)?;
                let channel_id = pin_crypto::channel_id(channel_key);
                let content = membership::held_key(doc, blobs, author_id, &channel_id, epoch)
                    .await
                    .ok_or_else(|| format!("no content key held for epoch {epoch}"))?;
                let payload = pin_channel::open_with(channel_key, blob, &content, kind, signer)?;
                (payload, content)
            }
        }
    };
    let json = String::from_utf8(payload).map_err(|_| "payload is not UTF-8".to_string())?;
    Ok((json, content))
}

fn bare_did(did: &str) -> &str {
    did.strip_prefix("did:dht:").unwrap_or(did)
}

/// Download a channel object and open it with what this identity holds, answering with its
/// JSON, the blob exactly as fetched, and the key it opened with.
pub async fn fetch_channel_object(
    sia: &pin_sia::Session,
    holdings: &Holdings<'_>,
    channel_key: &[u8; 32],
    item_url: &str,
    kind: pin_channel::Kind,
    author: &str,
) -> Result<(String, String, pin_channel::ContentKey), String> {
    let bytes = sia.download_item(item_url).await?;
    let blob = String::from_utf8(bytes).map_err(|_| "object blob is not UTF-8".to_string())?;
    let (json, content) = open_channel_object(holdings, channel_key, &blob, kind, author).await?;
    Ok((json, blob, content))
}

/// Read a channel's manifest from K, opening it with what this identity holds. `None` when
/// the locator resolves to nothing, which is ordinary.
pub async fn resolve_channel(
    sia: &pin_sia::Session,
    holdings: &Holdings<'_>,
    channel_key: &[u8; 32],
    author: &str,
) -> Result<Option<pin_channel::Resolved>, String> {
    let Some(item_url) = pin_channel::resolve_url(channel_key).await? else {
        return Ok(None);
    };
    let (manifest_json, blob, content) = fetch_channel_object(
        sia,
        holdings,
        channel_key,
        &item_url,
        pin_channel::Kind::Manifest,
        author,
    )
    .await?;
    Ok(Some(pin_channel::Resolved {
        manifest_json,
        blob,
        content,
    }))
}

/// What a channel's page shows to somebody holding only K: its profile, as JSON, read from
/// the head of its current manifest and checked against `author`.
///
/// `None` when nothing is published at the locator, or when the channel's tier keeps its
/// profile under the content key — a secret channel, whose page shows nothing to anyone
/// who is not a member. Both read as "no page here", which is what a caller shows.
pub async fn resolve_channel_profile(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    author: &str,
) -> Result<Option<String>, String> {
    let Some(item_url) = pin_channel::resolve_url(channel_key).await? else {
        return Ok(None);
    };
    let bytes = sia.download_item(&item_url).await?;
    let blob = String::from_utf8(bytes).map_err(|_| "manifest is not text".to_string())?;
    pin_channel::open_profile(channel_key, &blob, pin_channel::Signer::Author(author))
}

/// Whether one of this identity's channels is one only its members may read.
pub(crate) fn members_only(settings: &SettingsView, channel_id: &str) -> bool {
    settings.my_channels.iter().any(|c| {
        c.channel_id == channel_id
            && matches!(c.visibility.as_deref(), Some("private") | Some("secret"))
    })
}

/// How this identity seals one of its own channels NOW: at the initial epoch with the read
/// key in the head for a channel anyone holding K may read, and for a members-only one at
/// its member tree's current epoch with no read key.
///
/// An error when the roster will not read, never a fallback: sealing a members-only channel
/// at the wrong epoch locks its members out, and sealing it the public way hands its
/// content to anyone holding K.
pub(crate) async fn channel_sealing<'a>(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    app_key: &[u8; 32],
    settings: &SettingsView,
    channel_key: &'a [u8; 32],
) -> Result<pin_channel::Sealing<'a>, String> {
    let channel_id = pin_crypto::channel_id(channel_key);
    if !members_only(settings, &channel_id) {
        return Ok(pin_channel::author_sealing(app_key, channel_key));
    }
    let seats = members::roster(doc, blobs, author_id, &channel_id).await?;
    let epoch = pin_channel::tree::Tree::from_roster(&seats).epoch();
    Ok(pin_channel::author_sealing_at(
        app_key,
        channel_key,
        epoch,
        true,
    ))
}

/// Whether a manifest says its channel is one only its members may read.
///
/// Read from the manifest being sealed rather than from settings, because a new channel's
/// settings entry is written only after its first manifest is published — and that first
/// manifest must already go out without a read key.
pub fn manifest_is_members_only(manifest_json: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct Visibility {
        #[serde(default)]
        visibility: Option<pin_manifest::ChannelVisibility>,
    }
    matches!(
        serde_json::from_str::<Visibility>(manifest_json)
            .ok()
            .and_then(|v| v.visibility),
        Some(pin_manifest::ChannelVisibility::Private | pin_manifest::ChannelVisibility::Secret)
    )
}

/// How its author seals a manifest: the public way, or — for a channel only its members may
/// read — at its member tree's current epoch with no read key.
///
/// The doc is needed only for the second, to read the roster, and a members-only manifest
/// with no doc to read it from is refused rather than sealed the public way, which would
/// hand its posts to anyone holding K.
pub async fn manifest_sealing<'a>(
    doc: Option<(&Doc, &Store, AuthorId)>,
    app_key: &[u8; 32],
    channel_key: &'a [u8; 32],
    manifest_json: &str,
) -> Result<pin_channel::Sealing<'a>, String> {
    if !manifest_is_members_only(manifest_json) {
        return Ok(pin_channel::author_sealing(app_key, channel_key));
    }
    let (doc, blobs, author_id) =
        doc.ok_or("a members-only channel is sealed at its roster's epoch, and no doc is open")?;
    let seats =
        members::roster(doc, blobs, author_id, &pin_crypto::channel_id(channel_key)).await?;
    let epoch = pin_channel::tree::Tree::from_roster(&seats).epoch();
    Ok(pin_channel::author_sealing_at(
        app_key,
        channel_key,
        epoch,
        true,
    ))
}

/// A value in one of this identity's own channel docs, opened at whatever epoch it was
/// sealed: the author derives every epoch's key, so a value written before a rotation reads
/// as readily as one written after. Reading it with the current key alone would drop every
/// older value — and a floor republished from that drops what they held.
pub(crate) fn open_own_doc_value<T: serde::de::DeserializeOwned>(
    app_key: &[u8; 32],
    channel_key: &[u8; 32],
    bytes: &[u8],
) -> Option<T> {
    let blob = std::str::from_utf8(bytes).ok()?;
    let (json, _) =
        pin_channel::open_as_author(app_key, channel_key, blob, pin_channel::Kind::DocValue)
            .ok()?;
    serde_json::from_slice(&json).ok()
}

/// How this identity seals a value it writes into one of its own channel docs: under the
/// channel's content key, with no read key in the head.
///
/// No read key because the doc is reached only through a ticket found under that key, so
/// anyone reading a value already holds it. Sealed at all because the doc stays put across
/// a rotation: a removed member who kept the namespace id from a ticket they once held
/// syncs on, and what they sync is sealed under a key they no longer have.
pub(crate) fn doc_sealing(sealing: pin_channel::Sealing<'_>) -> pin_channel::Sealing<'_> {
    pin_channel::Sealing {
        publish_read_key: false,
        ..sealing
    }
}

/// A channel-doc value, sealed for writing.
pub(crate) fn seal_doc_value<T: serde::Serialize>(
    sealing: &pin_channel::Sealing,
    value: &T,
) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(value).map_err(|e| format!("encode: {e}"))?;
    pin_channel::seal(sealing, pin_channel::Kind::DocValue, &json).map(String::into_bytes)
}

/// A channel-doc value, opened with the content key the reader holds. `None` for anything
/// that will not open or parse — a value sealed at another epoch among them, which is the
/// reader's cue that its key is out of date rather than that the value is absent.
pub(crate) fn open_doc_value<T: serde::de::DeserializeOwned>(
    channel_key: &[u8; 32],
    content: &pin_channel::ContentKey,
    author: &str,
    bytes: &[u8],
) -> Option<T> {
    let blob = std::str::from_utf8(bytes).ok()?;
    let json = pin_channel::open_with(
        channel_key,
        blob,
        content,
        pin_channel::Kind::DocValue,
        pin_channel::Signer::Author(author),
    )
    .ok()?;
    serde_json::from_slice(&json).ok()
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

/// How many whole-doc scans have happened — test-only, and an instrument rather than a
/// statistic.
///
/// `list_rkeys` costs the size of the WHOLE doc however small the collection, so "how many
/// times did one pass do this" is a property worth asserting — and it is not one any output
/// reveals: scanning once and scanning once per subject produce identical results and differ
/// only in how long they take. A timing assertion is the alternative, and a flaky one.
#[cfg(test)]
pub(crate) mod scans {
    use std::cell::Cell;

    // Per THREAD, not global: the suite runs tests in parallel, and a shared counter would
    // have each reading everyone else's scans. `#[tokio::test]` is a current-thread runtime,
    // so one test's awaited work stays on one thread — and anything that did escape to
    // another would go UNcounted rather than be miscounted, which a reader of this has to
    // know, and is why every assertion on it also insists the count is non-zero.
    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) fn count() {
        COUNT.with(|c| c.set(c.get() + 1));
    }

    /// Start counting from here.
    pub(crate) fn reset() {
        COUNT.with(|c| c.set(0));
    }

    pub(crate) fn taken() -> usize {
        COUNT.with(|c| c.get())
    }
}

/// How many records have been read back one at a time — test-only, the same kind of
/// instrument as `scans` and thread-local for the same reason.
///
/// A read is ~40 µs where a scan over tens of thousands of entries is ~25 ms, so at scale
/// the reads are the cost; and like a scan, reading a record for nothing produces the same
/// output as not reading it.
#[cfg(test)]
pub(crate) mod reads {
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) fn count() {
        COUNT.with(|c| c.set(c.get() + 1));
    }

    /// Start counting from here.
    pub(crate) fn reset() {
        COUNT.with(|c| c.set(0));
    }

    pub(crate) fn taken() -> usize {
        COUNT.with(|c| c.get())
    }
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

    #[cfg(test)]
    scans::count();

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
/// Seconds since the epoch from an ISO-8601 timestamp, or `None` when it won't parse.
///
/// Deliberately without a fallback. What an unreadable timestamp should mean depends
/// entirely on what the caller does with the answer: `repack` reads it as very old,
/// because the cost of being wrong is one redundant repack; `discover`'s eviction reads it
/// as unknown and keeps the record, because the cost of being wrong there is a deletion.
/// Baking either into the parse would hand the other one the wrong default silently.
pub(crate) fn iso_secs(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|d| d.timestamp())
        .ok()
}

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

/// Which channels a pass should keep cached: the ones this identity reads, less its own.
///
/// Own channels are excluded because their freshest state is local — the app reflects a
/// publish immediately — so a cached copy could only ever be the same or staler, and
/// serving a staler one would make a just-published post disappear.
///
/// Each with its author's did, which every object read from it must be signed by. A channel
/// with no did — only a legacy link that named nobody makes one — cannot be verified, so it
/// is not read at all.
fn wanted_channels<'a>(
    settings: &SettingsView,
    reading: &'a Reading,
) -> Vec<(&'a str, &'a str, &'a str)> {
    let owned: std::collections::HashSet<&str> = settings
        .my_channels
        .iter()
        .map(|c| c.channel_id.as_str())
        .collect();
    reading
        .channels
        .iter()
        .filter(|c| !owned.contains(c.channel_id.as_str()))
        .filter_map(|c| {
            Some((
                c.channel_id.as_str(),
                c.channel_key.as_str(),
                c.did_dht.as_deref()?,
            ))
        })
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
///
/// `content` is the key the resolved manifest opened with, for a cached one whose head
/// carries no read key — a channel only its members may read. A cached manifest from an
/// earlier epoch will not open with it, and that too answers "not older": a rotation is
/// newer by construction.
pub(crate) fn is_older_than_cached(
    channel_key: &[u8; 32],
    author: &str,
    resolved_json: &str,
    cached_blob: Option<&[u8]>,
    content: Option<&pin_channel::ContentKey>,
) -> bool {
    let Some(cached) = cached_blob else {
        return false;
    };
    let Ok(cached_str) = std::str::from_utf8(cached) else {
        return false;
    };
    let signer = pin_channel::Signer::Author(author);
    let cached_json = match pin_channel::open_blob(channel_key, cached_str, signer) {
        Ok(json) => json,
        Err(_) => {
            let Some(content) = content else {
                return false;
            };
            let Ok(payload) = pin_channel::open_with(
                channel_key,
                cached_str,
                content,
                pin_channel::Kind::Manifest,
                signer,
            ) else {
                return false;
            };
            let Ok(json) = String::from_utf8(payload) else {
                return false;
            };
            json
        }
    };
    match (published_at(resolved_json), published_at(&cached_json)) {
        // Strictly older only. Equal timestamps mean the same instant with different
        // content, and refusing that would be the worse error.
        (Some(fresh), Some(held)) => fresh < held,
        _ => false,
    }
}

/// Download a channel's manifest and open it with whatever key this identity holds for it,
/// answering with the manifest, the blob exactly as fetched, and the key it opened with.
async fn fetch_held(
    ctx: &PullContext,
    channel_id: &str,
    channel_key: &[u8; 32],
    item_url: &str,
    author: &str,
) -> Result<(String, String, pin_channel::ContentKey), String> {
    let _ = channel_id;
    fetch_channel_object(
        &ctx.sia,
        &Holdings {
            doc: Some((&ctx.doc, &ctx.blobs, ctx.author_id)),
            app_key: Some(&ctx.app_key),
        },
        channel_key,
        item_url,
        pin_channel::Kind::Manifest,
        author,
    )
    .await
}

/// One pass: refresh every subscribed channel's cached manifest and published counts, and
/// drop the cache for channels no longer subscribed.
///
/// Never gives up the whole pass for one channel. A channel that fails is counted and
/// left for the next pass — one unreachable author must not stop the rest from being
/// kept current.
pub async fn pull_once(ctx: &PullContext) -> Result<PullOutcome, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;

    let reading = reading::read_now(&ctx.doc, &ctx.blobs, ctx.author_id, &settings).await;
    let wanted = wanted_channels(&settings, &reading);
    let mut outcome = PullOutcome::default();

    // Climb every membership first, so a rotation lands before this pass reads anything
    // sealed under the new key. A climb that cannot run costs the members-only channels
    // this pass and nothing else, so it never stops the pull.
    if let Ok(climb) = membership::climb_once(
        &net::LiveNetwork::new(ctx.sia.clone()),
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        &ctx.app_key,
    )
    .await
    {
        outcome.climb = climb;
    }

    for (channel_id, channel_key_b64, author) in &wanted {
        let Some(k) = pin_crypto::channel_key_from_base64(channel_key_b64) else {
            // A key we can't decode can never resolve; counting it as failed would
            // make the next pass retry something that cannot succeed.
            continue;
        };
        // Independent of the manifest below: a channel whose posts haven't moved can still
        // have counts that have, so neither half's skip may stand in for the other's.
        pull_tallies(ctx, channel_id, &k, author, &mut outcome).await;

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

        match fetch_held(ctx, channel_id, &k, &mark.url, author).await {
            Ok((manifest_json, blob, content)) => {
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
                if is_older_than_cached(
                    &k,
                    author,
                    &manifest_json,
                    cached.as_deref(),
                    Some(&content),
                ) {
                    outcome.stale += 1;
                    continue;
                }
                match ctx
                    .doc
                    .set_bytes(
                        ctx.author_id,
                        record_key(SUB_COLLECTION, channel_id),
                        blob.into_bytes(),
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

    // Only on a complete set. A followed person nobody has read yet, or whose record has
    // faded, is missing from `wanted` for want of a reading — dropping their cache on that
    // would be deleting by absence. What waits is the cleanup, and it runs on the next pass
    // that can say.
    if reading.settled() {
        outcome.dropped = drop_unsubscribed(ctx, &wanted).await;
        drop_tallies_for_gone_channels(ctx, &settings, &wanted).await;
    }
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
    wanted: &[(&'a str, &'a str, &'a str)],
) -> std::collections::HashSet<&'a str> {
    wanted
        .iter()
        .map(|(id, _, _)| *id)
        .chain(settings.my_channels.iter().map(|c| c.channel_id.as_str()))
        .collect()
}

/// Delete cached tallies for channels this identity neither follows nor owns.
async fn drop_tallies_for_gone_channels(
    ctx: &PullContext,
    settings: &SettingsView,
    wanted: &[(&str, &str, &str)],
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
async fn drop_unsubscribed(ctx: &PullContext, wanted: &[(&str, &str, &str)]) -> usize {
    use n0_future::StreamExt as _;

    let keep: std::collections::HashSet<&str> = wanted.iter().map(|(id, _, _)| *id).collect();
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

    /// A manifest sealed as its author would seal it. Any AppKey will do: a reader takes the
    /// content key from the head.
    /// Who `sealed` signs as.
    fn author() -> String {
        crate::own_did(&[1u8; 32])
    }

    fn sealed(k: &[u8; 32], iso: &str) -> Vec<u8> {
        pin_channel::seal(
            &pin_channel::author_sealing(&[1u8; 32], k),
            pin_channel::Kind::Manifest,
            published(iso).as_bytes(),
        )
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
            &author(),
            &published("2026-08-01T11:00:00.000Z"),
            Some(&cached),
            None
        ));
    }

    #[test]
    fn a_newer_or_equal_resolve_is_written() {
        let k = [7u8; 32];
        let cached = sealed(&k, "2026-08-01T12:00:00.000Z");
        // Newer — the ordinary case.
        assert!(!is_older_than_cached(
            &k,
            &author(),
            &published("2026-08-01T13:00:00.000Z"),
            Some(&cached),
            None
        ));
        // Same instant, and by construction different content, since an identical
        // manifest would be a harmless rewrite either way. Refusing would be worse
        // than allowing.
        assert!(!is_older_than_cached(
            &k,
            &author(),
            &published("2026-08-01T12:00:00.000Z"),
            Some(&cached),
            None
        ));
    }

    #[test]
    fn a_members_only_cache_is_compared_with_the_key_the_fresh_copy_opened_with() {
        // No read key in either head, so the cached manifest opens only with C — the key
        // the resolved one just opened with, when both are at one epoch.
        let k = [7u8; 32];
        let content = pin_channel::ContentKey {
            epoch: 3,
            key: [5u8; 32],
        };
        let members_only = |content: pin_channel::ContentKey| pin_channel::Sealing {
            content,
            publish_read_key: false,
            ..pin_channel::author_sealing(&[1u8; 32], &k)
        };
        let cached = pin_channel::seal(
            &members_only(content),
            pin_channel::Kind::Manifest,
            published("2099-01-01T00:00:00Z").as_bytes(),
        )
        .unwrap()
        .into_bytes();
        let older = published("2026-01-01T00:00:00Z");
        assert!(is_older_than_cached(
            &k,
            &author(),
            &older,
            Some(&cached),
            Some(&content)
        ));
        // Without the key the guard cannot compare, and steps aside as it always has.
        assert!(!is_older_than_cached(
            &k,
            &author(),
            &older,
            Some(&cached),
            None
        ));
        // A key for another epoch: a rotation, newer by construction.
        let rotated = pin_channel::ContentKey {
            epoch: 4,
            key: [6u8; 32],
        };
        assert!(!is_older_than_cached(
            &k,
            &author(),
            &older,
            Some(&cached),
            Some(&rotated)
        ));
    }

    #[test]
    fn a_guard_that_cannot_compare_gets_out_of_the_way() {
        // Nothing cached yet — the first pass must always write.
        let k = [7u8; 32];
        assert!(!is_older_than_cached(
            &k,
            &author(),
            &published("2026-01-01T00:00:00Z"),
            None,
            None
        ));
        // A blob sealed under a DIFFERENT key won't open. Blocking the channel forever
        // would be a worse answer than writing a manifest we can read.
        let other = sealed(&[9u8; 32], "2099-01-01T00:00:00Z");
        assert!(!is_older_than_cached(
            &k,
            &author(),
            &published("2026-01-01T00:00:00Z"),
            Some(&other),
            None
        ));
        // A manifest with no version marker can't be ranked, so it doesn't block.
        let cached = sealed(&k, "2099-01-01T00:00:00Z");
        assert!(!is_older_than_cached(
            &k,
            &author(),
            r#"{"items":[]}"#,
            Some(&cached),
            None
        ));
    }

    /// The cached set for settings with no followed person held — watches alone.
    fn wanted(s: &SettingsView) -> Vec<(String, String)> {
        let r = reading(s, &Default::default());
        wanted_channels(s, &r)
            .into_iter()
            .map(|(a, b, _)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn a_followed_persons_profile_channels_are_cached() {
        // Following a person copies nothing into the subscription list, so this is the one
        // route their channels have into the cache.
        let s = settings(
            r#"{
              "subscriptions": [{"channelID": "w", "channelKey": "kw", "didDht": "did:dht:author"}],
              "handleFollows": ["did:dht:alice"]
            }"#,
        );
        let held = std::collections::BTreeMap::from([(
            "did:dht:alice".to_string(),
            serde_json::from_str::<DirectoryRecord>(
                r#"{"tier":"full","channels":[{"channelID":"a1","key":"k1","name":"One"}]}"#,
            )
            .unwrap(),
        )]);
        let r = reading(&s, &held);
        assert_eq!(
            wanted_channels(&s, &r),
            vec![("w", "kw", "did:dht:author"), ("a1", "k1", "did:dht:alice")]
        );
    }

    #[test]
    fn a_subscription_naming_no_author_is_not_read() {
        // Everything read from a channel must be signed by its author, and a legacy link
        // that named nobody gives nothing to check that against.
        let s = settings(r#"{"subscriptions": [{"channelID": "x", "channelKey": "kx"}]}"#);
        assert!(wanted(&s).is_empty());
    }

    #[test]
    fn wanted_channels_excludes_the_users_own() {
        // Owners auto-subscribe to their own channels, so the subscription list
        // contains them — and caching one could serve a staler copy than the local
        // state a publish just wrote.
        let s = settings(
            r#"{
              "subscriptions": [
                {"channelID": "aaa", "channelKey": "k1", "didDht": "did:dht:author"},
                {"channelID": "bbb", "channelKey": "k2", "didDht": "did:dht:author"}
              ],
              "myChannels": [{"channelID": "aaa"}]
            }"#,
        );
        assert_eq!(wanted(&s), vec![("bbb".into(), "k2".into())]);
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
              "subscriptions": [{"channelID": "aaa", "channelKey": "k1", "didDht": "did:dht:author", "label": "x"}]
            }"#,
        );
        assert_eq!(wanted(&s), vec![("aaa".into(), "k1".into())]);

        // And an absent list is an empty one, not a decode failure.
        let empty = settings(r#"{"version": 3}"#);
        assert!(wanted(&empty).is_empty());
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
                {"channelID": "aaa", "channelKey": "k1", "didDht": "did:dht:author"},
                {"channelID": "bbb", "channelKey": "k2", "didDht": "did:dht:author"}
              ],
              "myChannels": [{"channelID": "aaa"}]
            }"#,
        );
        let r = reading(&s, &Default::default());
        let keep = tally_channels_to_keep(&s, &wanted_channels(&s, &r));
        assert!(keep.contains("aaa"));
        assert!(keep.contains("bbb"));
    }

    #[test]
    fn an_unsubscribed_channels_counts_are_dropped() {
        let s = settings(r#"{"subscriptions": [], "myChannels": []}"#);
        let r = reading(&s, &Default::default());
        assert!(!tally_channels_to_keep(&s, &wanted_channels(&s, &r)).contains("gone"));
    }

    // --- the conversation cache -----------------------------------------------

    const THREAD_SUBJECT: &str = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";

    fn a_comment(when: &str, body: &str) -> pin_engagement::Endorsement {
        pin_engagement::Endorsement::sign_comment(
            &[5u8; 32],
            THREAD_SUBJECT,
            "bafkreiabc",
            when,
            None,
            body,
            Vec::new(),
            Vec::new(),
        )
        .unwrap()
    }

    fn conversation(
        comments: &[pin_engagement::Endorsement],
        updated: &str,
    ) -> pin_engagement::Conversation {
        pin_engagement::Conversation {
            comments: comments.to_vec(),
            updated_at: updated.to_string(),
        }
    }

    #[tokio::test]
    async fn a_cached_conversation_is_not_rewritten_when_only_the_clock_moved() {
        // The same rule the tally beside it keeps, and for the same reason: this doc is
        // snapshotted WHOLE to Sia against a fingerprint of its contents. `updatedAt` is
        // stamped when the fold RAN, not when the conversation moved, and the engagement
        // pass re-folds every subject it observed rather than only the ones that changed
        // — so a comparison covering the stamp rewrites this record every crawling pass
        // and mints a fresh snapshot object with it, for a conversation nobody touched.
        let world = crate::testnet::World::new();
        let me = crate::testnet::Identity::new(&world, 1).await;
        let held = a_comment("2026-09-20T12:00:00.000Z", "hello");

        let first = conversation(&[held.clone()], "2026-09-20T12:00:00.000Z");
        assert!(
            cache_thread(
                &me.doc,
                &me.blobs,
                me.author_id,
                "ch1",
                THREAD_SUBJECT,
                &first
            )
            .await,
            "a subject's first conversation has to land"
        );

        // The next crawling pass, ten minutes on. Same comment, same set, new stamp.
        let again = conversation(&[held], "2026-09-20T12:10:00.000Z");
        assert!(
            !cache_thread(
                &me.doc,
                &me.blobs,
                me.author_id,
                "ch1",
                THREAD_SUBJECT,
                &again
            )
            .await,
            "an unchanged conversation must not be rewritten"
        );
    }

    #[tokio::test]
    async fn a_cached_conversation_is_rewritten_when_a_comment_arrives() {
        // The other half, or the guard above is satisfied by a cache that never writes.
        let world = crate::testnet::World::new();
        let me = crate::testnet::Identity::new(&world, 1).await;
        let first_comment = a_comment("2026-09-20T12:00:00.000Z", "hello");
        let second_comment = a_comment("2026-09-20T12:05:00.000Z", "and again");

        let first = conversation(&[first_comment.clone()], "2026-09-20T12:00:00.000Z");
        cache_thread(
            &me.doc,
            &me.blobs,
            me.author_id,
            "ch1",
            THREAD_SUBJECT,
            &first,
        )
        .await;

        let grown = conversation(&[first_comment, second_comment], "2026-09-20T12:10:00.000Z");
        assert!(
            cache_thread(
                &me.doc,
                &me.blobs,
                me.author_id,
                "ch1",
                THREAD_SUBJECT,
                &grown
            )
            .await
        );
    }

    #[test]
    fn a_conversation_older_than_the_cached_one_is_refused() {
        // Two feeders land here at different distances from the source: the author's own
        // fold arrives over live sync in seconds, where a floor read comes off a pointer
        // a browser resolves through relays minutes behind. Taking the floor's answer
        // unconditionally would drop a comment already on screen.
        let first = a_comment("2026-09-20T12:00:00.000Z", "hello");
        let second = a_comment("2026-09-20T12:05:00.000Z", "and again");
        let held = conversation(&[first.clone(), second], "2026-09-20T12:10:00.000Z");
        let stale = conversation(&[first], "2026-09-20T12:00:00.000Z");
        // Not the unchanged case — the sets genuinely differ, so it is the clock that
        // has to refuse this one.
        assert!(!thread_is_current(Some(&held), &stale));
        assert!(thread_is_older(Some(&held), &stale));
    }
}
