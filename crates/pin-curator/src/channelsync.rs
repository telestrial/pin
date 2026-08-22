//! Live-sync each subscribed channel from its author's node — the subscriber half of
//! the content-resolution ladder's top rung, and the counterpart to `channeldoc`.
//!
//! What it buys is latency. The polling rung below re-resolves every subscribed channel
//! on a slow cadence, which is what makes a channel readable at all; this imports the
//! author's channel doc and is then PUSHED their writes as they happen. A channel whose
//! author publishes no ticket, or is offline, or unreachable, is the ordinary case and
//! not an error — it simply stays on the rung below.
//!
//! IT LANDS WHERE THE POLLING RUNG LANDS. A pushed manifest is written to
//! `sub/<channelID>`, the same record a resolved one goes to, sealed exactly as it
//! arrived. So the two rungs are indistinguishable downstream, they share the one
//! recency guard (see `is_older_than_cached`), and the frontend needs no second path:
//! whatever renders is already watching that record through the doc's change feed.
//!
//! COUNTS RIDE THE SAME IMPORT. A channel's published tallies live in that same replica,
//! so a subscriber already holding it is pushed a count the moment its author folds one —
//! where the floor rung has to resolve a pkarr pointer and download a Sia object to learn
//! the same thing. They land in `tally/<id>:<subject>`, the one address this identity's
//! screens read, written through the same `cache_tally` the floor writes with, so the
//! recency guard decides between the two rungs rather than whichever ran last.
//!
//! Writes only, though: an author who deletes a tally (an unlike taking a count to zero
//! removes the record) leaves the cached copy behind, and the floor rung's pass is what
//! drops it. Counts get faster here; correctness still comes from below.
//!
//! That guard matters more here than it looks. A tab resolves through pkarr relays that
//! lag the DHT by minutes, so its own polling pass can easily find an OLDER manifest
//! than one that arrived by push. Writing it anyway would un-publish a post. Both
//! writers going through the same comparison is what makes the two rungs safe to run at
//! once.
//!
//! NO SPAWNING. Each imported doc gives an event stream, and they are merged into one
//! stream this loop's own task polls. Spawning a pump per channel would need a task
//! bound that differs by target — the executor is the caller's business, and pushing
//! that difference down here is exactly what the shared crate exists to avoid.

use std::collections::{HashMap, HashSet};
use std::str::FromStr as _;
use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, engine::LiveEvent, store::Query, AuthorId, DocTicket};
use n0_future::{boxed::BoxStream, StreamExt as _};
use pin_derive::record_key;
use pin_engagement::Aggregate;

use crate::channeldoc::{manifest_key, TICKET_PREFIX};
use crate::engagement::{conversation_key, tally_key};
use crate::{cache_tally, is_older_than_cached, read_record, read_settings, SUB_COLLECTION};

/// Everything a pass needs, gathered by whichever engine is running it.
pub struct ChannelSyncContext {
    /// The identity's own doc: where the subscription list is read from and where a
    /// pushed manifest is written to.
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    pub docs: iroh_docs::api::DocsApi,
    /// The Sia AppKey, for the settings key. Each channel's own key comes from the
    /// subscription entry.
    pub app_key: [u8; 32],
}

/// What one reconcile pass did. Reported when the loop re-checks its subscriptions, not
/// on every pushed manifest — those are counted into the next report.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ChannelSyncOutcome {
    /// Channels newly imported this pass — a live sync that didn't exist before.
    pub imported: usize,
    /// Channels currently being live-synced, including the ones imported this pass.
    pub watching: usize,
    /// Subscribed channels whose author publishes no resolvable ticket. Ordinary: they
    /// keep being served by the polling rung.
    pub unavailable: usize,
    /// Channels that failed to import. The next pass retries.
    pub failed: usize,
    /// Manifests pushed into `sub/<id>` since the last report.
    pub pushed: usize,
    /// Pushed manifests refused for being older than what's cached.
    pub stale: usize,
    /// Published counts cached into `tally/<id>:<subject>` since the last report.
    pub tallies: usize,
    /// Published conversations cached into `thread/<id>:<subject>` since the last report.
    pub threads: usize,
}

/// One channel this instance is live-syncing.
struct Watched {
    /// The channel's K — to open a pushed manifest for the recency check.
    key: [u8; 32],
    /// The imported replica, read when its stream says something arrived.
    doc: Doc,
}

/// Import any subscribed channel not already being watched, and drop the ones no longer
/// subscribed.
///
/// Never gives up the whole pass for one channel: an author who can't be reached must
/// not stop the rest from being watched.
async fn reconcile(
    ctx: &ChannelSyncContext,
    watched: &mut HashMap<String, Watched>,
    events: &mut n0_future::MergeUnbounded<BoxStream<(String, LiveEvent)>>,
) -> Result<ChannelSyncOutcome, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;
    let wanted = crate::wanted_channels(&settings);
    let mut outcome = ChannelSyncOutcome::default();

    // An unsubscribed channel stops being watched. Its stream is left in the merge to
    // end on its own — dropping the `Doc` is what stops the sync, and a stray event for
    // a channel we no longer watch is ignored below.
    let keep: std::collections::HashSet<&str> = wanted.iter().map(|(id, _)| *id).collect();
    watched.retain(|id, _| keep.contains(id.as_str()));

    for (channel_id, channel_key_b64) in &wanted {
        if watched.contains_key(*channel_id) {
            continue;
        }
        let Some(k) = pin_crypto::channel_key_from_base64(channel_key_b64) else {
            outcome.failed += 1;
            continue;
        };
        match import_channel(ctx, channel_id, &k).await {
            Ok(Some((doc, stream))) => {
                events.push(stream);
                let w = Watched { key: k, doc };
                // What a replica already holds is not re-emitted when it is re-imported,
                // so an instance that restarts would otherwise learn a channel's counts
                // only when the floor rung next ran.
                outcome.tallies += scan_tallies(ctx, channel_id, &w).await;
                watched.insert((*channel_id).to_string(), w);
                outcome.imported += 1;
            }
            Ok(None) => outcome.unavailable += 1,
            Err(_) => outcome.failed += 1,
        }
    }

    outcome.watching = watched.len();
    Ok(outcome)
}

/// Resolve one channel's read ticket and import it, live-syncing from its author.
///
/// `Ok(None)` when the author publishes no ticket, or it hasn't propagated — the
/// ordinary case, and the reason this returns an option rather than an error.
///
/// Subscribes BEFORE starting sync, so the first reconciliation's events can't be
/// missed: that initial catch-up is the one we most want to see.
#[allow(clippy::type_complexity)]
async fn import_channel(
    ctx: &ChannelSyncContext,
    channel_id: &str,
    channel_key: &[u8; 32],
) -> Result<Option<(Doc, BoxStream<(String, LiveEvent)>)>, String> {
    let seed = pin_derive::channel_doc_ticket_seed(channel_key);
    let public_key = pin_pkarr::public_key_from_seed(&seed)?;
    let records = match pin_pkarr::resolve(&public_key).await {
        Ok(r) => r,
        // Unresolvable reads the same as unpublished here: either way there is no live
        // path to this author right now.
        Err(_) => return Ok(None),
    };
    let raw = pin_pkarr::rejoin_txt(&records, TICKET_PREFIX);
    if raw.is_empty() {
        return Ok(None);
    }
    let ticket = DocTicket::from_str(&raw).map_err(|e| format!("{channel_id}: bad ticket: {e}"))?;
    let DocTicket { capability, nodes } = ticket;

    let doc = ctx
        .docs
        .import_namespace(capability)
        .await
        .map_err(|e| format!("{channel_id}: import: {e}"))?;
    let stream = doc
        .subscribe()
        .await
        .map_err(|e| format!("{channel_id}: subscribe: {e}"))?;
    doc.start_sync(nodes)
        .await
        .map_err(|e| format!("{channel_id}: start sync: {e}"))?;

    let id = channel_id.to_string();
    let tagged: BoxStream<(String, LiveEvent)> =
        Box::pin(stream.filter_map(move |ev| ev.ok().map(|ev| (id.clone(), ev))));
    Ok(Some((doc, tagged)))
}

/// Whether an event means something arrived that we should re-read.
///
/// Covers content-ready as well as insert-remote: iroh-blobs content lags the entry
/// metadata, so a reader woken only by insert-remote would intermittently find the
/// value not yet downloadable.
fn is_remote_arrival(event: &LiveEvent) -> bool {
    matches!(
        event,
        LiveEvent::InsertRemote { .. }
            | LiveEvent::ContentReady { .. }
            | LiveEvent::PendingContentReady
    )
}

/// Copy a channel's freshly-pushed manifest into `sub/<id>`, unless it's older than what
/// is already cached.
///
/// Returns whether it wrote. Never throws upward: a manifest that isn't readable yet is
/// the normal state between an entry arriving and its content downloading, and the next
/// event covers it.
async fn push_manifest(ctx: &ChannelSyncContext, channel_id: &str, watched: &Watched) -> Push {
    let Ok(Some(entry)) = watched
        .doc
        .get_one(Query::single_latest_per_key().key_exact(manifest_key()))
        .await
    else {
        return Push::Nothing;
    };
    let Ok(sealed) = ctx.blobs.get_bytes(entry.content_hash()).await else {
        // Content not downloaded yet — a content-ready event will bring us back.
        return Push::Nothing;
    };
    let Ok(sealed_str) = std::str::from_utf8(&sealed) else {
        return Push::Nothing;
    };
    let Ok(json) = pin_channel::open_blob(&watched.key, sealed_str) else {
        return Push::Nothing;
    };

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
    if is_older_than_cached(&watched.key, &json, cached.as_deref()) {
        return Push::Stale;
    }

    match ctx
        .doc
        .set_bytes(
            ctx.author_id,
            record_key(SUB_COLLECTION, channel_id),
            sealed.to_vec(),
        )
        .await
    {
        Ok(_) => Push::Wrote,
        Err(_) => Push::Nothing,
    }
}

enum Push {
    Wrote,
    Stale,
    Nothing,
}

/// What an arriving key names, when it names anything.
///
/// A channel's replica carries its manifest, its counts and its conversations in one
/// keyspace, so an event is routed by what arrived rather than by re-reading everything.
enum Named<'a> {
    Tally(&'a str),
    Conversation(&'a str),
}

fn named(key: &str) -> Option<Named<'_>> {
    if let Some(subject) = tally_subject(key) {
        return Some(Named::Tally(subject));
    }
    conversation_subject(key).map(Named::Conversation)
}

/// The subject a key names, when that key is a published conversation.
fn conversation_subject(key: &str) -> Option<&str> {
    key.strip_prefix(&pin_derive::collection_prefix(
        pin_derive::CONVERSATION_COLLECTION,
    ))
}

/// The subject a key names, when that key is a published tally.
///
/// A channel's replica carries its manifest and its counts in one keyspace, so the event
/// stream is routed by what arrived rather than by re-reading everything: an author who
/// folds fifty subjects at once emits fifty events, and answering each with a full scan
/// would be quadratic in a channel's own size.
fn tally_subject(key: &str) -> Option<&str> {
    key.strip_prefix(&pin_derive::collection_prefix(
        pin_derive::ENGAGEMENT_COLLECTION,
    ))
}

/// The key an event says arrived, for the events that say.
///
/// Content-ready carries a hash rather than a key, which is the whole reason the caller
/// keeps a pending set: an entry can land before the value it points at is downloadable.
fn arrival_key(event: &LiveEvent) -> Option<String> {
    match event {
        LiveEvent::InsertRemote { entry, .. } => {
            Some(String::from_utf8_lossy(entry.key()).to_string())
        }
        _ => None,
    }
}

/// Copy one subject's published tally out of a watched replica and into the cache this
/// identity's screens read.
///
/// `NotReady` is the ordinary state between an entry syncing and its content downloading,
/// and is why it is worth distinguishing from having nothing to do: the caller holds the
/// subject and retries it when content lands, where treating the two alike would drop the
/// count until the floor rung next ran.
/// Copy one subject's published conversation out of a watched replica and into the cache.
///
/// The same three answers a tally push gives, and for the same reason: an entry can sync
/// before its content is downloadable, and treating that as nothing to do would leave the
/// words missing until the floor rung next ran.
async fn push_conversation(
    ctx: &ChannelSyncContext,
    channel_id: &str,
    watched: &Watched,
    subject: &str,
) -> TallyPush {
    let Ok(Some(entry)) = watched
        .doc
        .get_one(Query::single_latest_per_key().key_exact(conversation_key(subject)))
        .await
    else {
        return TallyPush::Nothing;
    };
    let Ok(bytes) = ctx.blobs.get_bytes(entry.content_hash()).await else {
        return TallyPush::NotReady;
    };
    let Ok(conversation) = serde_json::from_slice::<pin_engagement::Conversation>(&bytes) else {
        return TallyPush::Nothing;
    };
    if crate::cache_thread(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        channel_id,
        subject,
        &conversation,
    )
    .await
    {
        TallyPush::Cached
    } else {
        TallyPush::Nothing
    }
}

async fn push_tally(
    ctx: &ChannelSyncContext,
    channel_id: &str,
    watched: &Watched,
    subject: &str,
) -> TallyPush {
    let Ok(Some(entry)) = watched
        .doc
        .get_one(Query::single_latest_per_key().key_exact(tally_key(subject)))
        .await
    else {
        // No such entry: either never published, or withdrawn. Nothing to cache either
        // way — dropping a cached one is the floor rung's job.
        return TallyPush::Nothing;
    };
    let Ok(bytes) = ctx.blobs.get_bytes(entry.content_hash()).await else {
        return TallyPush::NotReady;
    };
    let Ok(aggregate) = serde_json::from_slice::<Aggregate>(&bytes) else {
        return TallyPush::Nothing;
    };
    if cache_tally(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        channel_id,
        subject,
        &aggregate,
    )
    .await
    {
        TallyPush::Cached
    } else {
        TallyPush::Nothing
    }
}

enum TallyPush {
    Cached,
    NotReady,
    Nothing,
}

/// Cache every tally a watched replica currently holds. Used at import, where there is no
/// event to route from.
async fn scan_tallies(ctx: &ChannelSyncContext, channel_id: &str, watched: &Watched) -> usize {
    let Ok(subjects) = crate::list_rkeys(
        &watched.doc,
        ctx.author_id,
        pin_derive::ENGAGEMENT_COLLECTION,
    )
    .await
    else {
        return 0;
    };
    let mut cached = 0;
    for subject in subjects {
        // A value that hasn't downloaded yet is left to the event that says it has.
        if matches!(
            push_tally(ctx, channel_id, watched, &subject).await,
            TallyPush::Cached
        ) {
            cached += 1;
        }
    }
    cached
}

/// Reconcile subscriptions, then pump pushed manifests until the next reconcile is due —
/// forever.
///
/// Two cadences: `cadence` once every subscribed channel is being watched, and `retry`
/// while any is not. Reconciling is only about WHO to listen to — a manifest arrives the
/// moment its author writes it — so the slow cadence costs nothing, and the fast one
/// exists purely so a ticket that wasn't resolvable a moment ago is picked up promptly.
///
/// Returned rather than spawned, for the same reason the other loops are: the caller
/// owns the executor, and that placement is the one genuine difference between running
/// this natively and running it in a tab.
pub async fn run_channel_sync_loop(
    ctx: ChannelSyncContext,
    cadence: Duration,
    retry: Duration,
    on_pass: impl Fn(Result<ChannelSyncOutcome, String>),
) -> ! {
    let mut watched: HashMap<String, Watched> = HashMap::new();
    let mut events: n0_future::MergeUnbounded<BoxStream<(String, LiveEvent)>> =
        n0_future::MergeUnbounded::new();
    // Carried into the next report: a push happens between reconciles, so counting it
    // there is the only way it gets counted at all.
    let mut pushed = 0usize;
    let mut stale = 0usize;
    let mut tallies = 0usize;
    let mut threads = 0usize;
    // Subjects whose entry has arrived but whose value hasn't downloaded, by channel.
    // Retried when content lands, because nothing else would come back for them.
    let mut pending: HashMap<String, HashSet<String>> = HashMap::new();

    loop {
        let result = reconcile(&ctx, &mut watched, &mut events).await;
        pending.retain(|id, _| watched.contains_key(id));
        // Come back sooner while something is still unwatched. An author's ticket takes
        // a little while to become resolvable after they publish it, so a subscriber
        // that misses it on the first look would otherwise sit out the whole cadence
        // over a few seconds of propagation.
        let wait = match &result {
            Ok(o) if o.unavailable == 0 && o.failed == 0 => cadence,
            _ => retry,
        };
        on_pass(result.map(|mut o| {
            o.pushed = std::mem::take(&mut pushed);
            o.stale = std::mem::take(&mut stale);
            // Added to, not assigned: an import scans the replica it just took on, and
            // that count is already in the outcome.
            o.tallies += std::mem::take(&mut tallies);
            o.threads += std::mem::take(&mut threads);
            o
        }));

        // Wait out the cadence, handling anything pushed in the meantime. The pump only
        // finishes when every stream has ended, and then it waits too — so a subscriber
        // with no live channels sleeps rather than spinning.
        let pump = async {
            while let Some((channel_id, event)) = events.next().await {
                if !is_remote_arrival(&event) {
                    continue;
                }
                // A channel dropped from `watched` between the event and now is no
                // longer subscribed; its stray events are ignored.
                let Some(w) = watched.get(&channel_id) else {
                    continue;
                };
                let key = arrival_key(&event);
                match key.as_deref().and_then(named) {
                    // A count landed and the event named it, so nothing else is re-read.
                    Some(Named::Tally(subject)) => {
                        let subject = subject.to_string();
                        match push_tally(&ctx, &channel_id, w, &subject).await {
                            TallyPush::Cached => tallies += 1,
                            TallyPush::NotReady => {
                                pending
                                    .entry(channel_id.clone())
                                    .or_default()
                                    .insert(subject);
                            }
                            TallyPush::Nothing => {}
                        }
                    }
                    Some(Named::Conversation(subject)) => {
                        let subject = subject.to_string();
                        match push_conversation(&ctx, &channel_id, w, &subject).await {
                            TallyPush::Cached => threads += 1,
                            TallyPush::NotReady => {
                                pending
                                    .entry(channel_id.clone())
                                    .or_default()
                                    .insert(subject);
                            }
                            TallyPush::Nothing => {}
                        }
                    }
                    // The manifest, or a content event — which says a value downloaded
                    // without saying whose, and is the only thing that brings a tally
                    // waiting on its content back.
                    None => {
                        match push_manifest(&ctx, &channel_id, w).await {
                            Push::Wrote => pushed += 1,
                            Push::Stale => stale += 1,
                            Push::Nothing => {}
                        }
                        for subject in pending.get(&channel_id).cloned().unwrap_or_default() {
                            // Both, because a pending subject records that SOMETHING for it
                            // wasn't downloadable yet and not which. Each retry is a local
                            // lookup that answers Nothing when there is nothing there.
                            let mut settled = match push_tally(&ctx, &channel_id, w, &subject).await
                            {
                                TallyPush::Cached => {
                                    tallies += 1;
                                    true
                                }
                                TallyPush::Nothing => true,
                                TallyPush::NotReady => false,
                            };
                            settled &= match push_conversation(&ctx, &channel_id, w, &subject).await
                            {
                                TallyPush::Cached => {
                                    threads += 1;
                                    true
                                }
                                TallyPush::Nothing => true,
                                TallyPush::NotReady => false,
                            };
                            if settled {
                                if let Some(set) = pending.get_mut(&channel_id) {
                                    set.remove(&subject);
                                }
                            }
                        }
                    }
                }
            }
            n0_future::time::sleep(wait).await;
        };
        n0_future::future::race(pump, n0_future::time::sleep(wait)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_arriving_late_still_wakes_a_re_read() {
        // The gotcha this exists for: iroh-blobs downloads a value AFTER its entry
        // syncs, so a reader woken only by insert-remote finds the manifest present and
        // unreadable — and then never looks again. Both content events have to count.
        assert!(is_remote_arrival(&LiveEvent::PendingContentReady));
        assert!(is_remote_arrival(&LiveEvent::ContentReady {
            hash: iroh_blobs::Hash::from([7u8; 32]),
        }));
    }

    /// An entry carrying `key`, as a remote arrival would.
    fn arrival(key: &str) -> LiveEvent {
        let id = iroh_docs::sync::RecordIdentifier::new(
            iroh_docs::NamespaceId::from(&[1u8; 32]),
            iroh_docs::AuthorId::from(&[2u8; 32]),
            key,
        );
        // A non-empty length: `Record::new` insists a zero-length record carry the hash
        // of the empty range, and the length is nothing to do with what's under test.
        let record = iroh_docs::sync::Record::new(iroh_blobs::Hash::from([3u8; 32]), 1, 0);
        LiveEvent::InsertRemote {
            from: iroh::PublicKey::from_bytes(&[0u8; 32]).unwrap(),
            entry: iroh_docs::sync::Entry::new(id, record),
            content_status: iroh_docs::ContentStatus::Complete,
        }
    }

    #[test]
    fn a_published_conversation_routes_to_its_subject() {
        // Its own collection beside the counts, so a row that wants a number reads a small
        // entry and only opening a post pulls the words.
        assert!(matches!(
            named("conversation/abc"),
            Some(Named::Conversation("abc"))
        ));
        assert!(matches!(named("engagement/abc"), Some(Named::Tally("abc"))));
        assert!(named("thread/chan:abc").is_none());
        assert!(named("tally/chan:abc").is_none());
    }

    #[test]
    fn a_published_tally_routes_to_its_subject() {
        // The routing that keeps the pump linear: an author folding fifty subjects emits
        // fifty events, and answering each with a full scan of the replica would be
        // quadratic in the channel's own size.
        assert_eq!(tally_subject("engagement/abc"), Some("abc"));
        // The manifest shares the keyspace, and reading it as a tally would leave the one
        // record this loop existed to push unwritten.
        let manifest = String::from_utf8(manifest_key()).unwrap();
        assert_eq!(tally_subject(&manifest), None);
        // A near-miss: our own cache lives under a different collection, and the channel
        // replica never holds one.
        assert_eq!(tally_subject("tally/chan:abc"), None);
    }

    #[test]
    fn an_arrival_names_its_key_but_content_does_not() {
        // Why the pending set exists. An entry can land before the value it points at is
        // downloadable, and the event that says the value arrived carries a hash rather
        // than a key — so a subject caught mid-download has nothing to route on, and
        // something has to remember it.
        assert_eq!(
            arrival_key(&arrival("engagement/abc")).as_deref(),
            Some("engagement/abc")
        );
        assert_eq!(arrival_key(&LiveEvent::PendingContentReady), None);
        assert_eq!(
            arrival_key(&LiveEvent::ContentReady {
                hash: iroh_blobs::Hash::from([7u8; 32]),
            }),
            None
        );
    }

    #[test]
    fn a_peer_appearing_is_not_something_arriving() {
        // Swarm membership changes say who we're talking to, not that a manifest
        // moved. Re-reading on them would be work for nothing on every neighbour churn.
        let peer = iroh::PublicKey::from_bytes(&[0u8; 32]).unwrap();
        assert!(!is_remote_arrival(&LiveEvent::NeighborUp(peer)));
        assert!(!is_remote_arrival(&LiveEvent::NeighborDown(peer)));
    }
}
