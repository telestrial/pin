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

use std::collections::HashMap;
use std::str::FromStr as _;
use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, engine::LiveEvent, store::Query, AuthorId, DocTicket};
use n0_future::{boxed::BoxStream, StreamExt as _};
use pin_derive::record_key;

use crate::channeldoc::{manifest_key, TICKET_PREFIX};
use crate::{is_older_than_cached, read_record, read_settings, SUB_COLLECTION};

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
                watched.insert((*channel_id).to_string(), Watched { key: k, doc });
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

    loop {
        let result = reconcile(&ctx, &mut watched, &mut events).await;
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
                match push_manifest(&ctx, &channel_id, w).await {
                    Push::Wrote => pushed += 1,
                    Push::Stale => stale += 1,
                    Push::Nothing => {}
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

    #[test]
    fn a_peer_appearing_is_not_something_arriving() {
        // Swarm membership changes say who we're talking to, not that a manifest
        // moved. Re-reading on them would be work for nothing on every neighbour churn.
        let peer = iroh::PublicKey::from_bytes(&[0u8; 32]).unwrap();
        assert!(!is_remote_arrival(&LiveEvent::NeighborUp(peer)));
        assert!(!is_remote_arrival(&LiveEvent::NeighborDown(peer)));
    }
}
