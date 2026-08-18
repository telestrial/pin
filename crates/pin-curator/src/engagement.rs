//! Fold what others have endorsed into the counts this identity publishes.
//!
//! This is the author's half of engagement, and the reason Pin needs no AppView. Nobody
//! writes into anybody else's repo: an engager records their endorsement in their own
//! directory, and the author reads it, verifies it, holds it, and publishes a tally over
//! what they hold. Firehose becomes a crawl; AppView becomes the person whose surface it
//! is.
//!
//! Three properties shape the whole loop.
//!
//! **Verification costs nothing and never fails for want of a lookup.** A `did:dht` IS its
//! ed25519 public key, so a record is checked against the string it carries — no packet, no
//! prior contact. So there is no verification deficit to report, ever, and the only thing a
//! holder cannot prove by holding a signature is that an endorsement still STANDS.
//!
//! **Which makes retention the honest thing to publish.** A record is withdrawn by being
//! removed from its actor's directory, so noticing means re-checking that directory. This
//! loop does exactly that every pass, and stamps a subject's tally with the time only when
//! EVERY actor behind it was reached — so a stale check reads as stale instead of being
//! quietly presented as fresh.
//!
//! Re-checking is usually not re-reading. Sia is content-addressed, so an actor's directory
//! pointer is an exact validator: unchanged means byte-identical, which proves their
//! endorsements still stand without downloading anything. In steady state a pass is one DHT
//! resolve per actor and no Sia reads at all, and retention — the reason it repeats — turns
//! out to be the cheap part rather than the expensive one.
//!
//! **An absence only means withdrawal when we actually looked.** An actor we couldn't
//! reach keeps their records: treating unreachable as withdrawn would empty a count on a
//! bad network, and deletion-by-absence is the mistake this codebase has already made
//! twice, in the orphan sweep and in settings.
//!
//! **A crawl cannot reach strangers, so knocks land here too.** It only ever finds
//! endorsements from people whose directories it has reason to read — someone outside the
//! graph has no such directory as far as we are concerned. Their endorsement arrives by
//! `/hey`, and this loop is where it becomes a count, for two reasons that both point
//! here: matching a subject needs the table of what this identity publishes, and a record
//! that doesn't mark its subject as touched is one the fold never re-runs, so the knock
//! would sit in the log without moving a number.
//!
//! A knocked record is held to the same bar as a crawled one — signed by the actor it
//! names, and about something we publish — plus one a crawled record doesn't need: it may
//! not displace something NEWER. A directory read is current state at the source, so it
//! wins outright; a knock is an assertion somebody sent us, and a replayed old one must
//! not be able to undo what has happened since.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{
    api::{Doc, DocsApi},
    AuthorId, Capability, NamespaceSecret,
};
use pin_engagement::{Aggregate, Endorsement};

use crate::{read_record, read_settings, SettingsView};

/// Everything a pass needs.
pub struct EngagementContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// Channel docs are opened here to publish a tally into them, the same way the
    /// channel-doc loop opens them to serve a manifest.
    pub docs: DocsApi,
    /// A connected Sia session: a directory's records live in a blob, and reading somebody
    /// else's endorsements means downloading it.
    pub sia: Arc<pin_sia::Session>,
    pub app_key: [u8; 32],
    /// Knocks parked by whatever is serving `/hey` on this instance. Drained here rather
    /// than in a loop of its own, because turning one into a count needs this pass's
    /// subject table and has to mark the subject touched so the tally is re-folded.
    pub inbox: pin_rpc::HeyInbox,
}

/// What one pass did. Reported rather than summarised, because "reached nobody" and "found
/// nothing" are different states and an instance that can't tell you which is not much use.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct EngagementOutcome {
    /// Actors whose endorsements were read this pass — by download, or by confirming their
    /// directory pointer hadn't moved.
    pub reached: usize,
    /// Of those, the ones confirmed by pointer alone, with no download. The number this
    /// loop most wants to be large: it is the whole graph in steady state.
    pub skipped: usize,
    /// Actors in the graph we couldn't read. Their held records stay.
    pub unreachable: usize,
    /// Records newly held, or updated because their content moved.
    pub added: usize,
    /// Records withdrawn — gone from an actor's directory that we DID read.
    pub withdrawn: usize,
    /// Subjects whose tally was rewritten.
    pub tallies: usize,
    /// Subjects whose tally was removed because nothing endorses them any more.
    pub cleared: usize,
    /// Endorsements that named something this identity doesn't publish. Ordinary: an
    /// actor's directory holds everything they endorsed, most of it somebody else's.
    pub not_ours: usize,
    /// Records that failed verification. Not an error — a forgery failing is the system
    /// working — but worth counting, because a number that climbs is worth knowing about.
    pub rejected: usize,
    /// Knocked records taken into the log this pass. The out-of-graph half: engagement
    /// from someone whose directory this identity has no reason to read.
    pub knocked: usize,
    /// Knocks that named something we publish but were older than what is already held.
    /// A replay, or a duplicate the sender retried — harmless either way, and counted so
    /// a climbing number is visible.
    pub stale_knocks: usize,
    /// Knocks whose signature didn't hold up.
    ///
    /// Counted apart from the crawl's `rejected`, and likewise `knocks_not_ours` from
    /// `not_ours`, because the two mean opposite things. Reading somebody's directory
    /// turns up everything they ever endorsed, nearly all of it other people's — so a
    /// crawl's `not_ours` is the ordinary case and says nothing. A KNOCK was aimed at us
    /// deliberately, so one we discard is a real disagreement about what we publish or who
    /// signed it, and blurring the two hid exactly that.
    pub knocks_rejected: usize,
    /// Knocks about a subject this identity doesn't publish.
    pub knocks_not_ours: usize,
    /// Channels whose tallies were republished to Sia and the DHT — the floor rung, and
    /// the only copy a reader without a live replica ever sees. Zero on a quiet pass:
    /// the publish is fingerprinted on the counts themselves.
    pub published: usize,
    /// Channels whose floor publish failed. Retried next pass, and it will be: the
    /// fingerprint doesn't advance until one succeeds.
    pub publish_failed: usize,
}

/// Where a subject lives, so its tally reaches the right channel's doc.
type SubjectTable = HashMap<String, String>;

/// Every subject this identity publishes: one per post, one per attachment.
///
/// Built by opening each owned channel's manifest, which is what makes matching possible at
/// all — a subject is a hash, so the only way to recognise one is to recompute it over
/// something you already hold. That is also what keeps an unlisted channel's counts private:
/// nobody without K can compute its subjects, so nobody else can tell what a record for one
/// refers to.
async fn own_subjects(
    ctx: &EngagementContext,
    settings: &SettingsView,
) -> Result<SubjectTable, String> {
    let mut table = SubjectTable::new();
    for owned in &settings.my_channels {
        let Some(k) = pin_crypto::channel_key_from_base64(&owned.channel_key) else {
            continue;
        };
        let Ok(Some(sealed)) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            OWN_CHANNEL_COLLECTION,
            &owned.channel_id,
        )
        .await
        else {
            // No manifest recorded yet — nothing published, so nothing to be endorsed.
            continue;
        };
        let Ok(blob) = String::from_utf8(sealed) else {
            continue;
        };
        let Ok(json) = pin_crypto::decrypt(&k, &blob) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<pin_manifest::ChannelManifest>(&json) else {
            continue;
        };

        for item in &manifest.items {
            table.insert(
                pin_crypto::engagement_subject(&owned.channel_id, &item.published_at),
                owned.channel_id.clone(),
            );
            for att in item.attachments.iter().flatten() {
                // An attachment with no content hash has no identity, so no subject. Its
                // count is simply absent, which is better than one attached to the wrong
                // file.
                if let Some(hash) = &att.content_hash {
                    table.insert(
                        pin_crypto::attachment_subject(&owned.channel_id, &item.published_at, hash),
                        owned.channel_id.clone(),
                    );
                }
            }
        }
    }
    Ok(table)
}

/// The main doc's collection of owned channels' manifests.
const OWN_CHANNEL_COLLECTION: &str = "channel";

/// The identities whose endorsements this pass will look for.
///
/// Everyone this identity has a reason to read: the channels it follows, the people it
/// follows wholesale, and the authors it subscribes to. A crawl reaches no further, and
/// deliberately — engagement from outside the graph comes by knock.
fn graph_actors(settings: &SettingsView) -> BTreeSet<String> {
    let mut actors = BTreeSet::new();
    for f in &settings.follows {
        if let Some(did) = f.get("didDht").and_then(|v| v.as_str()) {
            actors.insert(did.to_string());
        }
    }
    for did in &settings.handle_follows {
        actors.insert(did.clone());
    }
    for sub in &settings.subscriptions {
        if let Some(did) = sub.did_dht.as_deref() {
            actors.insert(did.to_string());
        }
    }
    actors
}

/// What the crawl last read to completion for one actor.
///
/// Only ever written after a directory was downloaded AND parsed. Recording a pointer we
/// merely SAW would skip that actor forever on the strength of a download that failed —
/// the same "advance only on success" rule the settings mirror's fingerprint follows.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct CrawlMark {
    url: String,
    epoch: u32,
}

/// Bumped when what we EXTRACT from a directory changes — a new endorsement kind, a schema
/// move, a fix to the parse.
///
/// An unchanged pointer proves the bytes are identical; it says nothing about whether our
/// reading of them is still current. Without this, changing the parse would skip every
/// actor indefinitely and the change would never take effect on anyone already crawled.
const CRAWL_EPOCH: u32 = 1;

/// Whether an actor's directory can be answered from the log instead of downloaded.
///
/// Named rather than inlined because skipping is the dangerous direction: a wrong "no"
/// costs one download, a wrong "yes" means never reading that actor again. Both reasons to
/// say no — no mark at all, and a mark from an older parse — are easy to lose in a `==`.
fn may_skip(held: Option<&CrawlMark>, current: &CrawlMark) -> bool {
    held == Some(current)
}

/// Where an actor's directory currently is, or an error meaning we couldn't find out.
async fn resolve_directory_url(did: &str) -> Result<String, String> {
    let records = pin_pkarr::resolve(did).await?;
    let url = pin_pkarr::rejoin_txt(&records, crate::identity::DIR_PREFIX);
    if url.is_empty() {
        return Err(format!("{did}: no directory published"));
    }
    Ok(url)
}

/// The mark held for an actor, or None if we've never read them to completion.
async fn read_crawl_mark(ctx: &EngagementContext, did: &str) -> Option<CrawlMark> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        pin_derive::CRAWL_COLLECTION,
        did,
    )
    .await
    .ok()??;
    serde_json::from_slice(&raw).ok()
}

/// Record that this actor's directory was read to completion at this pointer.
///
/// Skipped when it would write what is already there: every write to this doc is a change
/// announced to every instance syncing it, and a pass that changed nothing should be silent.
async fn write_crawl_mark(ctx: &EngagementContext, did: &str, mark: &CrawlMark) {
    if read_crawl_mark(ctx, did).await.as_ref() == Some(mark) {
        return;
    }
    let Ok(bytes) = serde_json::to_vec(mark) else {
        return;
    };
    let _ = crate::write_record(
        &ctx.doc,
        ctx.author_id,
        pin_derive::CRAWL_COLLECTION,
        did,
        bytes,
    )
    .await;
}

/// The endorsements this identity already holds from one actor, read back out of the log.
///
/// What a skipped download would have produced, and exactly equivalent to it: the log holds
/// what we extracted from that same blob last time, and the blob is byte-identical. Only the
/// subjects we publish are in there, so an actor's endorsements of OTHER people's posts —
/// discarded on a real read anyway — simply don't appear.
async fn held_endorsements(ctx: &EngagementContext, rkeys: &[String]) -> Vec<Endorsement> {
    let mut out = Vec::new();
    for rkey in rkeys {
        let Ok(Some(raw)) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            pin_derive::ENGAGEMENT_LOG_COLLECTION,
            rkey,
        )
        .await
        else {
            continue;
        };
        if let Ok(record) = serde_json::from_slice::<Endorsement>(&raw) {
            out.push(record);
        }
    }
    out
}

/// Whether a log key belongs in one subject's fold.
///
/// The subject comes from PARSING rather than from a prefix match, so a key this version
/// can't address is left out of the count rather than half-read into it. Every key starts
/// with its subject, so a prefix test would take one anyway — and a record folded under a
/// key nothing can address is one that can never be withdrawn either.
fn folds_into(rkey: &str, subject: &str) -> bool {
    matches!(pin_derive::parse_engagement_log_rkey(rkey), Some((s, _, _)) if s == subject)
}

/// Every record this identity holds about one subject.
///
/// A scan of the log, which is keyed subject-first for exactly this. Unreadable entries
/// are skipped rather than failing the fold: one bad record must not take a whole count
/// with it.
async fn log_records_for(ctx: &EngagementContext, subject: &str) -> Vec<Endorsement> {
    let rkeys = crate::list_rkeys(
        &ctx.doc,
        ctx.author_id,
        pin_derive::ENGAGEMENT_LOG_COLLECTION,
    )
    .await
    .unwrap_or_default();

    let mut out = Vec::new();
    for rkey in rkeys.iter().filter(|k| folds_into(k, subject)) {
        let Ok(Some(raw)) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            pin_derive::ENGAGEMENT_LOG_COLLECTION,
            rkey,
        )
        .await
        else {
            continue;
        };
        if let Ok(record) = serde_json::from_slice::<Endorsement>(&raw) {
            out.push(record);
        }
    }
    out
}

/// Where one record belongs in the log.
///
/// Derived from the record itself, so everything that has to agree on a record's address
/// — the working set, the write, the lookup a knock is compared against — asks the same
/// question of the same thing rather than each assembling an answer.
fn log_key(record: &Endorsement) -> String {
    pin_derive::engagement_log_rkey(&record.subject, &record.kind, &record.actor)
}

/// When the record already held at one log key says it was made, if there is one.
///
/// What a knock is compared against, so a replayed record can't displace something newer.
/// Unreadable counts as absent, which lets the knock through — the write path compares
/// bytes before writing anyway, so the worst case is re-writing what is already there.
async fn held_created_at(ctx: &EngagementContext, rkey: &str) -> Option<String> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        pin_derive::ENGAGEMENT_LOG_COLLECTION,
        rkey,
    )
    .await
    .ok()??;
    serde_json::from_slice::<Endorsement>(&raw)
        .ok()
        .map(|e| e.created_at)
}

/// One actor's current endorsements, downloaded from their published directory.
///
/// Errors mean "couldn't read", which is what keeps their held records alive. An actor who
/// has published a directory with no endorsements returns an empty list — a real answer,
/// and the one that withdraws.
async fn download_endorsements(
    ctx: &EngagementContext,
    did: &str,
    url: &str,
) -> Result<Vec<Endorsement>, String> {
    let bytes = ctx.sia.download_item(url).await?;
    let doc: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("{did}: directory: {e}"))?;

    let Some(list) = doc.get("endorsements").and_then(|v| v.as_array()) else {
        // A directory from before endorsements existed, or one with none. Either way the
        // answer is "none", which is a successful read.
        return Ok(Vec::new());
    };
    // Skip anything that won't parse rather than failing the actor: one malformed record
    // must not make everything else they endorsed unreadable.
    Ok(list
        .iter()
        .filter_map(|v| serde_json::from_value::<Endorsement>(v.clone()).ok())
        .collect())
}

/// This identity's OWN endorsements, read straight out of the doc.
///
/// Never over the network, for the same reason a display name isn't: the published copy lags
/// local edits and may not have propagated. And they belong in the tally — an author is pin
/// #1 on their own post, so leaving themselves out would make a fresh post read zero.
async fn own_endorsements(ctx: &EngagementContext) -> Vec<Endorsement> {
    let rkeys = crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::ENDORSE_COLLECTION)
        .await
        .unwrap_or_default();
    let mut out = Vec::new();
    for rkey in rkeys {
        let Ok(Some(raw)) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            pin_derive::ENDORSE_COLLECTION,
            &rkey,
        )
        .await
        else {
            continue;
        };
        if let Ok(record) = serde_json::from_slice::<Endorsement>(&raw) {
            out.push(record);
        }
    }
    out
}

/// What a knocked record is worth once it has been looked at.
#[derive(Debug, PartialEq, Eq)]
enum KnockVerdict {
    /// Signed, ours, and newer than anything held — take it.
    Accept,
    /// Not signed by the identity it names, or its coordinates don't hash to its subject.
    Rejected,
    /// About something this identity doesn't publish. Ordinary: a subject is a hash, and
    /// one we can't compute belongs to somebody else.
    NotOurs,
    /// Older than what is already held for this actor and subject.
    Stale,
}

/// Whether a knocked record should be taken into the log.
///
/// Verification first, because everything after it presumes a record that holds up. Then
/// the subject, because a knock about somebody else's item is not ours to count. Then
/// recency — and that last check is the one a CRAWLED record doesn't get: reading an
/// actor's directory returns their current state, so it is authoritative by construction,
/// where a knock is an assertion pushed at us and could be a replay of something long
/// since withdrawn.
///
/// `crawled` is whether this pass already read this record from the actor's own
/// directory. If it did, that reading wins outright: it came from the source, this pass,
/// and no timestamp comparison can improve on it.
fn knock_verdict(
    record: &Endorsement,
    subjects: &SubjectTable,
    crawled: bool,
    held_created_at: Option<&str>,
) -> KnockVerdict {
    if record.verify().is_err() {
        return KnockVerdict::Rejected;
    }
    if !subjects.contains_key(&record.subject) {
        return KnockVerdict::NotOurs;
    }
    if crawled {
        return KnockVerdict::Stale;
    }
    match held_created_at {
        None => KnockVerdict::Accept,
        Some(held) if record.supersedes(held) => KnockVerdict::Accept,
        Some(_) => KnockVerdict::Stale,
    }
}

/// One pass: read the graph, take what was knocked through, hold what's verified and
/// ours, withdraw what's gone, and republish every tally that moved.
/// `crawl` says whether to go and read the graph's directories this pass.
///
/// The loop does two jobs whose costs are nothing alike. FOLDING is local: this identity's
/// own endorsements plus the records already held, turned into a tally. It touches no
/// network and takes milliseconds. CRAWLING is a DHT resolve and possibly a Sia download
/// per actor in the graph, which is why the loop's cadence is measured in minutes.
///
/// Pacing them together made a count that needs no network wait on one that does: publish a
/// post, and the 1 that says you are keeping it alive — derived entirely from a record you
/// just wrote — took as long to appear as reading everybody else's directories. So a
/// fold-only pass runs often and a crawling pass runs on the slow cadence.
pub async fn engagement_once(
    ctx: &EngagementContext,
    own_did: &str,
    now_iso: String,
    crawl: bool,
) -> Result<EngagementOutcome, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;
    let subjects = own_subjects(ctx, &settings).await?;
    let mut outcome = EngagementOutcome::default();

    // Emptied whatever happens to them. A knock left parked would be re-examined every
    // pass forever, and the inbox has a ceiling it would eventually reach.
    let knocks = pin_rpc::drain(&ctx.inbox);

    if subjects.is_empty() {
        // Nothing published, so nothing can be endorsed — including by knock. Not a
        // failure, and not a reason to hold on to what was knocked.
        outcome.not_ours = knocks.len();
        return Ok(outcome);
    }

    // What we found, keyed BY the log's own key rather than by something built to match
    // it. The two agreeing is then a property of the code instead of a thing to remember:
    // when this was a `(subject, actor)` pair it silently disagreed with a log key that
    // was meant to include the gesture, and one person's like and pin became one record.
    let mut found: BTreeMap<String, Endorsement> = BTreeMap::new();
    // Actors whose directory we actually read. Only these can withdraw anything.
    let mut reached: BTreeSet<String> = BTreeSet::new();

    // Ourselves first, locally.
    reached.insert(own_did.to_string());
    let mut all = vec![(own_did.to_string(), own_endorsements(ctx).await)];

    // Listed before the crawl rather than after, because an actor whose pointer hasn't
    // moved is answered from here instead of over the network.
    let held = crate::list_rkeys(
        &ctx.doc,
        ctx.author_id,
        pin_derive::ENGAGEMENT_LOG_COLLECTION,
    )
    .await
    .unwrap_or_default();
    let mut held_by_actor: HashMap<&str, Vec<String>> = HashMap::new();
    for rkey in &held {
        if let Some((_, _, actor)) = pin_derive::parse_engagement_log_rkey(rkey) {
            held_by_actor.entry(actor).or_default().push(rkey.clone());
        }
    }

    for did in graph_actors(&settings) {
        if did == own_did {
            continue;
        }
        // A fold-only pass reads nobody. Their held records still count — dropping them
        // would make every fast pass halve the numbers a crawl had established — but
        // nobody is marked reached, so nothing can be withdrawn on the strength of a
        // reading that didn't happen.
        if !crawl {
            let rkeys = held_by_actor.get(did.as_str()).cloned().unwrap_or_default();
            all.push((did, held_endorsements(ctx, &rkeys).await));
            continue;
        }
        let url = match resolve_directory_url(&did).await {
            Ok(url) => url,
            Err(_) => {
                outcome.unreachable += 1;
                continue;
            }
        };

        // An unchanged pointer means byte-identical bytes, so what we extracted last time
        // IS what we would extract now. Answering from the log skips the download — the
        // heavy half, and the flaky one, since it is the QUIC path.
        let mark = CrawlMark {
            url,
            epoch: CRAWL_EPOCH,
        };
        if may_skip(read_crawl_mark(ctx, &did).await.as_ref(), &mark) {
            let rkeys = held_by_actor.get(did.as_str()).cloned().unwrap_or_default();
            let records = held_endorsements(ctx, &rkeys).await;
            reached.insert(did.clone());
            outcome.skipped += 1;
            all.push((did, records));
            continue;
        }

        match download_endorsements(ctx, &did, &mark.url).await {
            Ok(records) => {
                // After the parse, never before: a mark written on a failed read would skip
                // this actor forever with nothing in hand.
                write_crawl_mark(ctx, &did, &mark).await;
                reached.insert(did.clone());
                all.push((did, records));
            }
            Err(_) => outcome.unreachable += 1,
        }
    }
    outcome.reached = reached.len();

    for (did, records) in all {
        for record in records {
            // The actor is what verification is anchored to, so a record claiming somebody
            // else has no business in their directory.
            if record.actor != did {
                outcome.rejected += 1;
                continue;
            }
            if record.verify().is_err() {
                outcome.rejected += 1;
                continue;
            }
            if !subjects.contains_key(&record.subject) {
                outcome.not_ours += 1;
                continue;
            }
            found.insert(log_key(&record), record);
        }
    }

    // Then what was knocked through. After the crawl, so a record read from its actor's
    // own directory this pass is already in `found` and takes precedence.
    for knock in knocks {
        let Ok(record) = serde_json::from_value::<Endorsement>(knock.record) else {
            outcome.knocks_rejected += 1;
            continue;
        };
        let key = log_key(&record);
        let held_at = held_created_at(ctx, &key).await;
        match knock_verdict(
            &record,
            &subjects,
            found.contains_key(&key),
            held_at.as_deref(),
        ) {
            KnockVerdict::Accept => {
                found.insert(key, record);
                outcome.knocked += 1;
            }
            KnockVerdict::Rejected => outcome.knocks_rejected += 1,
            KnockVerdict::NotOurs => outcome.knocks_not_ours += 1,
            KnockVerdict::Stale => outcome.stale_knocks += 1,
        }
    }

    // Reconcile the held log against what this pass saw. `held` was listed before the
    // crawl, and nothing has written to that collection since.
    let mut touched: BTreeSet<String> = found.values().map(|r| r.subject.clone()).collect();
    let found_keys: BTreeSet<String> = found.keys().cloned().collect();
    for rkey in &held {
        let Some(subject) = withdrawal(rkey, &found_keys, &reached) else {
            continue;
        };
        if crate::delete_record(
            &ctx.doc,
            ctx.author_id,
            pin_derive::ENGAGEMENT_LOG_COLLECTION,
            rkey,
        )
        .await
        .is_ok()
        {
            outcome.withdrawn += 1;
            touched.insert(subject);
        }
    }

    for (rkey, record) in &found {
        let bytes = serde_json::to_vec(record).map_err(|e| format!("encode record: {e}"))?;
        // Compare before writing: a pass that found the same records must not rewrite them,
        // because every write here is a change announced to every instance syncing this doc.
        let unchanged = matches!(
            read_record(
                &ctx.doc,
                &ctx.blobs,
                ctx.author_id,
                pin_derive::ENGAGEMENT_LOG_COLLECTION,
                &rkey
            )
            .await,
            Ok(Some(existing)) if existing == bytes
        );
        if unchanged {
            continue;
        }
        crate::write_record(
            &ctx.doc,
            ctx.author_id,
            pin_derive::ENGAGEMENT_LOG_COLLECTION,
            &rkey,
            bytes,
        )
        .await?;
        outcome.added += 1;
    }

    // Republish every tally that moved.
    for subject in &touched {
        let Some(channel_id) = subjects.get(subject) else {
            continue;
        };
        // From the LOG, not from what this pass happened to see.
        //
        // `found` is one pass's observations: this identity's own endorsements, the actors
        // it crawled, and whatever was knocked through. A knocked record is in there for
        // exactly the pass it arrived on — its actor is outside the graph by definition, so
        // no later crawl reloads it — and folding from `found` therefore counted it once
        // and then quietly un-counted it on the next pass. The number appeared and vanished
        // while the record sat in the log the whole time.
        //
        // The log IS the backing set a count asserts, so it is what a count is folded from.
        // `found` keeps its job of deciding what the log should say; it just stops standing
        // in for the log afterwards.
        let records = log_records_for(ctx, subject).await;

        let channel_doc = open_channel_doc(ctx, channel_id).await?;
        if records.is_empty() {
            // Nothing endorses it any more. The tally goes rather than sitting at zero:
            // a reader treats an absent tally and a zero one the same, and one fewer
            // record is one fewer thing to sync.
            let _ = channel_doc.del(ctx.author_id, tally_key(subject)).await;
            crate::clear_cached_tally(&ctx.doc, ctx.author_id, channel_id, subject).await;
            outcome.cleared += 1;
            continue;
        }

        // Stamped as retention-checked only when EVERY actor behind this subject was read
        // this pass. Otherwise the previous stamp is carried forward, so a stale check
        // reads as stale rather than being presented as fresh.
        //
        // An actor confirmed by pointer counts as read, and that is the point rather than a
        // shortcut: byte-identical bytes are a STRONGER proof their endorsements still stand
        // than downloading and re-parsing would be. So retention stops being the thing that
        // makes a pass expensive.
        let all_reached = records.iter().all(|r| reached.contains(&r.actor));
        let retention = if all_reached {
            Some(now_iso.clone())
        } else {
            held_retention(ctx, &channel_doc, subject).await
        };

        let aggregate = pin_engagement::fold(&records, retention, now_iso.clone())?;
        let bytes = serde_json::to_vec(&aggregate).map_err(|e| format!("encode tally: {e}"))?;
        channel_doc
            .set_bytes(ctx.author_id, tally_key(subject), bytes)
            .await
            .map_err(|e| format!("write tally {subject}: {e}"))?;
        // And where this identity's own screens read it. Free here — the fold is already
        // in hand — where a screen reaching the channel doc for it would have to hold that
        // replica, which for a channel you own means deriving a namespace the UI has no
        // other reason to know.
        crate::cache_tally(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            channel_id,
            subject,
            &aggregate,
        )
        .await;
        outcome.tallies += 1;
    }

    // Then the floor, for every owned channel rather than only the ones that moved.
    // Each call is a local read and a fingerprint compare, and doing it unconditionally
    // is what makes a failed upload self-healing: the fingerprint doesn't advance until
    // a publish lands, so the next pass retries on its own rather than waiting for some
    // unrelated endorsement to mark the channel dirty again.
    for owned in &settings.my_channels {
        let Some(k) = pin_crypto::channel_key_from_base64(&owned.channel_key) else {
            continue;
        };
        match publish_channel_tallies(ctx, &owned.channel_id, &k).await {
            Ok(true) => outcome.published += 1,
            Ok(false) => {}
            Err(_) => outcome.publish_failed += 1,
        }
    }

    Ok(outcome)
}

/// Whether a held record should be withdrawn, and the subject whose tally then moves.
///
/// A record goes only when its actor was READ this pass and no longer says it. Absence from
/// an actor we couldn't reach means nothing — that is the difference between a withdrawal
/// and a bad network, and conflating them would empty a count for the duration of an outage.
/// Deletion by absence is the mistake this codebase has already made twice.
fn withdrawal(rkey: &str, found: &BTreeSet<String>, reached: &BTreeSet<String>) -> Option<String> {
    let (subject, _, actor) = pin_derive::parse_engagement_log_rkey(rkey)?;
    if found.contains(rkey) {
        return None;
    }
    if !reached.contains(actor) {
        return None;
    }
    Some(subject.to_string())
}

/// One subject's published tally, or `None` when it publishes none.
///
/// Read author-agnostically, the way a subscriber reads a channel doc: only the author can
/// write to that namespace, so any entry at this key is ours.
async fn read_tally(
    ctx: &EngagementContext,
    channel_doc: &Doc,
    subject: &str,
) -> Option<Aggregate> {
    let entry = channel_doc
        .get_one(iroh_docs::store::Query::single_latest_per_key().key_exact(tally_key(subject)))
        .await
        .ok()??;
    let bytes = ctx.blobs.get_bytes(entry.content_hash()).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The retention time a subject's published tally already claims, if any.
async fn held_retention(
    ctx: &EngagementContext,
    channel_doc: &Doc,
    subject: &str,
) -> Option<String> {
    // Any kind's stamp will do: they are written together, so they agree.
    read_tally(ctx, channel_doc, subject)
        .await?
        .kinds
        .values()
        .find_map(|t| t.retention_checked_at.clone())
}

// --- the floor rung ---------------------------------------------------------------

/// Every tally a channel currently publishes, read back out of its own replica.
///
/// Read from the doc rather than re-folded from this pass's records, and the difference
/// bites: an actor we couldn't reach contributes nothing to `found`, so folding from it
/// would under-count for the duration of an outage — the very failure the withdrawal
/// guard exists to prevent. The doc holds what was last written for EVERY subject,
/// including ones this pass never touched, so the floor and the replica say the same
/// thing by construction rather than by two folds agreeing.
async fn read_tallies(
    ctx: &EngagementContext,
    channel_doc: &Doc,
) -> Result<BTreeMap<String, Aggregate>, String> {
    let subjects = crate::list_rkeys(
        channel_doc,
        ctx.author_id,
        pin_derive::ENGAGEMENT_COLLECTION,
    )
    .await?;
    let mut map = BTreeMap::new();
    for subject in subjects {
        if let Some(tally) = read_tally(ctx, channel_doc, &subject).await {
            map.insert(subject, tally);
        }
    }
    Ok(map)
}

/// A fingerprint of what a channel's tallies assert.
///
/// Fingerprinting the map verbatim would mint a fresh Sia object every cadence for every
/// channel anyone has ever endorsed, since the volatile fields move on every pass.
fn substance(map: &BTreeMap<String, Aggregate>) -> Result<String, String> {
    let stripped: BTreeMap<&str, BTreeMap<&str, (usize, &str)>> = map
        .iter()
        .map(|(subject, aggregate)| (subject.as_str(), crate::asserted(aggregate)))
        .collect();
    let json = serde_json::to_string(&stripped).map_err(|e| format!("fingerprint: {e}"))?;
    Ok(pin_crypto::content_hash(json.as_bytes()))
}

/// Publish one channel's tallies where anyone holding its key can read them.
///
/// This is engagement's floor. A tally also lives in the channel's iroh-docs replica and
/// arrives there within seconds — but that reaches only live subscribers, and everyone
/// who can read a channel holds K while most of them hold no replica: someone opening a
/// pasted subscribe URL, someone browsing a public channel from a directory, a
/// subscriber whose author is asleep. Derived state has to travel the same road as
/// authored state or it reaches a fraction of its audience.
///
/// Public and self-gating on purpose. A knock landing between passes should be able to
/// push the floor forward without waiting for the next crawl, and calling this when
/// nothing moved costs one local read.
///
/// Returns whether anything was uploaded.
pub async fn publish_channel_tallies(
    ctx: &EngagementContext,
    channel_id: &str,
    channel_key: &[u8; 32],
) -> Result<bool, String> {
    let channel_doc = open_channel_doc(ctx, channel_id).await?;
    let map = read_tallies(ctx, &channel_doc).await?;

    let rkey = pin_derive::published_engagement_rkey(channel_id);
    let published_key = pin_derive::published_key(&ctx.app_key);
    let previous =
        crate::read_published(&ctx.doc, &ctx.blobs, ctx.author_id, &published_key, &rkey).await;
    if nothing_to_publish(&map, previous.as_ref()) {
        return Ok(false);
    }

    let fingerprint = substance(&map)?;
    if previous.as_ref().and_then(|p| p.fp.as_deref()) == Some(fingerprint.as_str()) {
        return Ok(false);
    }

    let json = serde_json::to_string(&map).map_err(|e| format!("encode tallies: {e}"))?;
    let published = pin_channel::publish_tallies(&ctx.sia, channel_key, &json).await?;

    // Record before reclaiming, and keep the generation just superseded alive: a pointer
    // takes seconds to propagate, so a reader can still be resolving the object it
    // replaces. Same keep-2 rule the manifest publish follows — the object reclaimed is
    // the one from two publishes ago, which nothing can still be pointed at.
    crate::write_published(
        &ctx.doc,
        ctx.author_id,
        &published_key,
        &rkey,
        &crate::PublishedState {
            id: published.object_id.clone(),
            url: Some(published.item_url),
            older_id: previous.as_ref().map(|p| p.id.clone()),
            fp: Some(fingerprint),
        },
    )
    .await;

    if let Some(stale) = reclaimable(previous.as_ref(), &published.object_id) {
        let _ = ctx.sia.delete_object(&stale).await;
    }
    Ok(true)
}

/// Whether there is anything worth publishing at all.
///
/// A channel nobody has endorsed folds to an empty map, and publishing that would mint
/// a Sia object — a whole slab — to say "nothing", plus a DHT record pointing at it.
/// That is most channels, most of the time, so it is worth not doing.
///
/// Once something HAS been published the empty map stops being nothing: it means every
/// endorsement was withdrawn, and that has to reach the floor or a reader keeps seeing
/// counts for a set that no longer exists. So the skip is specifically "empty AND never
/// published", not "empty".
fn nothing_to_publish(
    map: &BTreeMap<String, Aggregate>,
    previous: Option<&crate::PublishedState>,
) -> bool {
    map.is_empty() && previous.is_none()
}

/// The object a publish may now reclaim: the one from two generations back.
///
/// Never the generation just superseded — that is the grace copy a reader mid-resolve
/// still needs — and never one that is somehow current again, which a republish of
/// identical bytes would produce.
fn reclaimable(previous: Option<&crate::PublishedState>, current: &str) -> Option<String> {
    let previous = previous?;
    let stale = previous.older_id.as_deref()?;
    if stale.is_empty() || stale == current || stale == previous.id {
        return None;
    }
    Some(stale.to_string())
}

/// Where one subject's published tally lives inside a channel's own doc.
///
/// Shared with the channel-sync loop, which reads the same key out of a replica it holds
/// as a subscriber. Two spellings of it would put an author's counts somewhere their
/// readers never look, and nothing would report an error.
pub(crate) fn tally_key(subject: &str) -> Vec<u8> {
    pin_derive::record_key(pin_derive::ENGAGEMENT_COLLECTION, subject)
}

/// Open one of this identity's channel docs. Idempotent, and the same derivation the
/// channel-doc loop uses, so both reach the same replica.
async fn open_channel_doc(ctx: &EngagementContext, channel_id: &str) -> Result<Doc, String> {
    let seed = pin_derive::channel_doc_seed(&ctx.app_key, channel_id);
    ctx.docs
        .import_namespace(Capability::Write(NamespaceSecret::from_bytes(&seed)))
        .await
        .map_err(|e| format!("channel doc {channel_id}: open: {e}"))
}

/// Pass, wait, repeat — forever. Returned rather than spawned, so the caller decides which
/// executor it belongs on: tokio imposes a `Send` bound a browser can't satisfy, and which
/// executor a task runs on is the one genuinely per-target question here.
/// Whether this pass should read the graph as well as fold.
///
/// Zero and one both mean "every pass", so a caller that doesn't want the split can't
/// accidentally ask for a loop that never crawls — which would leave an identity folding
/// its own records forever and never learning what anyone else did.
fn should_crawl(pass: u32, crawl_every: u32) -> bool {
    crawl_every <= 1 || pass % crawl_every == 0
}

/// Whether this pass should read the graph as well as fold.
///
/// A knock-woken pass folds only. The tick it would otherwise advance is what spaces the
/// crawl out, so letting knocks drive it would hand somebody else the schedule on which
/// this identity resolves and downloads every directory in its graph: twenty likes in a
/// row and a crawl fires. The due crawl isn't lost — the tick hasn't moved, so the next
/// scheduled pass at that tick still takes it.
fn crawl_this_pass(ticks: u32, crawl_every: u32, knock_woken: bool) -> bool {
    !knock_woken && should_crawl(ticks, crawl_every)
}

/// What ended a wait.
enum Woke {
    /// The cadence came round.
    Scheduled,
    /// A knock landed.
    Knock,
}

/// Pass, wait, repeat — forever.
///
/// Every pass folds; one in `crawl_every` scheduled passes also reads the graph. So a count
/// derived from local records appears at `cadence`, and the expensive half still runs at
/// `cadence * crawl_every`. The first pass crawls, so a fresh start doesn't wait to learn
/// what it missed while it was down.
///
/// A knock wakes it early, because a knock IS the count moving: an out-of-graph like
/// reaches this identity no other way, and waiting out the cadence to fold one is the last
/// stretch of delay between someone liking a post and its author showing it. What that
/// wake does not do is crawl — see `crawl_this_pass`.
pub async fn run_engagement_loop(
    ctx: EngagementContext,
    own_did: String,
    cadence: Duration,
    crawl_every: u32,
    now_iso: impl Fn() -> String,
    on_pass: impl Fn(Result<EngagementOutcome, String>),
) -> ! {
    let mut ticks: u32 = 0;
    let mut knock_woken = false;
    loop {
        let crawl = crawl_this_pass(ticks, crawl_every, knock_woken);
        on_pass(engagement_once(&ctx, &own_did, now_iso(), crawl).await);

        let scheduled = async {
            n0_future::time::sleep(cadence).await;
            Woke::Scheduled
        };
        let knocked = async {
            pin_rpc::wait(&ctx.inbox).await;
            Woke::Knock
        };
        knock_woken = match n0_future::future::race(scheduled, knocked).await {
            Woke::Scheduled => {
                ticks = ticks.wrapping_add(1);
                false
            }
            Woke::Knock => true,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUBJECT: &str = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
    const ALICE: &str = "did:dht:alice";
    const BOB: &str = "did:dht:bob";
    const LIKE: &str = pin_engagement::KIND_LIKE;
    const PIN: &str = pin_engagement::KIND_PIN;

    /// The log keys a pass found, built the way the pass builds them.
    fn keys(triples: &[(&str, &str, &str)]) -> BTreeSet<String> {
        triples
            .iter()
            .map(|(s, k, a)| pin_derive::engagement_log_rkey(s, k, a))
            .collect()
    }

    fn dids(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|d| d.to_string()).collect()
    }

    #[test]
    fn a_fresh_start_crawls_before_it_settles_into_folding() {
        // The first pass reads the graph, so a restart doesn't wait out the slow cadence
        // to learn what happened while it was down.
        assert!(should_crawl(0, 20));
        for pass in 1..20 {
            assert!(!should_crawl(pass, 20), "pass {pass} should only fold");
        }
        assert!(should_crawl(20, 20));
    }

    #[test]
    fn a_loop_asked_not_to_split_still_crawls_every_pass() {
        // Zero would otherwise be a division by zero, and one has to mean "every pass" —
        // either read as "never crawl" would leave an identity folding its own records
        // forever and never learning what anyone else did.
        for pass in 0..5 {
            assert!(should_crawl(pass, 0));
            assert!(should_crawl(pass, 1));
        }
    }

    #[test]
    fn a_knock_folds_but_never_crawls() {
        // Otherwise a stranger sets the schedule on which this identity resolves and
        // downloads every directory in its graph: knocks advance the tick, twenty likes
        // land, and a crawl fires because somebody else decided it should.
        assert!(!crawl_this_pass(0, 20, true));
        assert!(!crawl_this_pass(20, 20, true));
        // Including the case a knock can't opt out of — every pass crawls here, and a
        // knock still must not be what triggers one.
        assert!(!crawl_this_pass(3, 1, true));

        // And the crawl a knock stepped in front of isn't lost: the tick didn't move, so
        // the next scheduled pass at that same tick still takes it.
        assert!(crawl_this_pass(0, 20, false));
        assert!(crawl_this_pass(20, 20, false));
        assert!(!crawl_this_pass(7, 20, false));
    }

    // --- what a knock is worth ---------------------------------------------------

    const SEED: [u8; 32] = [3u8; 32];
    const WHEN: &str = "2026-08-16T12:00:00.000Z";

    fn knocked(subject: &str, when: &str) -> Endorsement {
        Endorsement::sign(
            &SEED,
            pin_engagement::KIND_LIKE,
            subject,
            "bafkreisomething",
            when,
            None,
        )
        .unwrap()
    }

    fn ours(subject: &str) -> SubjectTable {
        SubjectTable::from([(subject.to_string(), "chan".to_string())])
    }

    #[test]
    fn a_signed_knock_about_something_we_publish_is_taken() {
        // The whole point of the knock: an endorsement from someone whose directory this
        // identity has no reason to read, and would therefore never find.
        assert_eq!(
            knock_verdict(&knocked(SUBJECT, WHEN), &ours(SUBJECT), false, None),
            KnockVerdict::Accept
        );
    }

    #[test]
    fn a_knock_that_does_not_verify_is_rejected() {
        // Anyone can dial and send bytes, so the signature is the only thing standing
        // between a count and whatever a stranger felt like asserting.
        let mut forged = knocked(SUBJECT, WHEN);
        forged.subject = SUBJECT.into();
        forged.sig = pin_crypto::b64_encode(&[0u8; 64]);
        assert_eq!(
            knock_verdict(&forged, &ours(SUBJECT), false, None),
            KnockVerdict::Rejected
        );
    }

    #[test]
    fn a_knock_about_somebody_elses_item_is_not_ours_to_count() {
        // A subject is a hash, so one we can't compute over our own items belongs to
        // someone else — and counting it would let anyone inflate any number by
        // knocking us about it.
        assert_eq!(
            knock_verdict(&knocked("other", WHEN), &ours(SUBJECT), false, None),
            KnockVerdict::NotOurs
        );
    }

    #[test]
    fn a_replayed_knock_cannot_displace_something_newer() {
        // THE check a crawled record doesn't need. A directory read is current state at
        // the source; a knock is an assertion pushed at us, so an old one re-sent could
        // otherwise undo a withdrawal or restore a superseded version.
        let old = knocked(SUBJECT, "2026-08-16T11:00:00.000Z");
        assert_eq!(
            knock_verdict(&old, &ours(SUBJECT), false, Some(WHEN)),
            KnockVerdict::Stale
        );
        // Re-sending the identical record is not an update either.
        assert_eq!(
            knock_verdict(&knocked(SUBJECT, WHEN), &ours(SUBJECT), false, Some(WHEN)),
            KnockVerdict::Stale
        );
    }

    #[test]
    fn a_knock_newer_than_what_is_held_is_taken() {
        let fresh = knocked(SUBJECT, "2026-08-16T13:00:00.000Z");
        assert_eq!(
            knock_verdict(&fresh, &ours(SUBJECT), false, Some(WHEN)),
            KnockVerdict::Accept
        );
    }

    #[test]
    fn a_record_this_pass_read_at_its_source_beats_the_knock_of_it() {
        // The actor's own directory is where their current state lives, so a reading of
        // it this pass cannot be improved on by a copy somebody pushed — whatever the
        // timestamps say. A knock arriving alongside is a duplicate, not an update.
        let fresh = knocked(SUBJECT, "2099-01-01T00:00:00.000Z");
        assert_eq!(
            knock_verdict(&fresh, &ours(SUBJECT), true, None),
            KnockVerdict::Stale
        );
    }

    #[test]
    fn verification_is_checked_before_anything_else() {
        // Order matters for what gets reported: an unverifiable record about somebody
        // else's item is a forgery first. Reading it as merely not-ours would hide the
        // one number worth watching climb.
        let mut forged = knocked("other", WHEN);
        forged.sig = pin_crypto::b64_encode(&[0u8; 64]);
        assert_eq!(
            knock_verdict(&forged, &ours(SUBJECT), false, None),
            KnockVerdict::Rejected
        );
    }

    #[test]
    fn a_record_its_actor_still_publishes_is_kept() {
        let rkey = pin_derive::engagement_log_rkey(SUBJECT, LIKE, ALICE);
        assert_eq!(
            withdrawal(&rkey, &keys(&[(SUBJECT, LIKE, ALICE)]), &dids(&[ALICE])),
            None
        );
    }

    #[test]
    fn a_record_its_actor_no_longer_publishes_is_withdrawn() {
        // Read their directory, the endorsement is gone: that is a withdrawal, and the
        // count has to fall. Without this an unlike would never take effect.
        let rkey = pin_derive::engagement_log_rkey(SUBJECT, LIKE, ALICE);
        assert_eq!(
            withdrawal(&rkey, &keys(&[]), &dids(&[ALICE])),
            Some(SUBJECT.to_string())
        );
    }

    #[test]
    fn dropping_one_gesture_leaves_the_other_alone() {
        // Alice unliked but still pins. Only the like is withdrawn — before the gesture
        // was in the key these were one record, so one of the two counts was always
        // wrong: either the pin vanished with the like, or the like survived it.
        let like_key = pin_derive::engagement_log_rkey(SUBJECT, LIKE, ALICE);
        let pin_key = pin_derive::engagement_log_rkey(SUBJECT, PIN, ALICE);
        let found = keys(&[(SUBJECT, PIN, ALICE)]);
        let reached = dids(&[ALICE]);
        assert_eq!(
            withdrawal(&like_key, &found, &reached),
            Some(SUBJECT.to_string())
        );
        assert_eq!(withdrawal(&pin_key, &found, &reached), None);
    }

    #[test]
    fn both_of_an_actors_gestures_fold_into_the_same_subject() {
        // The fold groups by the kind inside each record, so it only reports both counts
        // if both records reach it.
        assert!(folds_into(
            &pin_derive::engagement_log_rkey(SUBJECT, LIKE, ALICE),
            SUBJECT
        ));
        assert!(folds_into(
            &pin_derive::engagement_log_rkey(SUBJECT, PIN, ALICE),
            SUBJECT
        ));
        // Another item's records are not this item's count.
        let other = "aaxlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        assert!(!folds_into(
            &pin_derive::engagement_log_rkey(other, LIKE, ALICE),
            SUBJECT
        ));
    }

    #[test]
    fn a_record_keyed_before_the_gesture_was_in_it_is_not_folded() {
        // A key this version didn't write is not a record this version can place. Folding
        // by prefix would take one anyway — every key starts with its subject — and count
        // an actor it can neither address nor withdraw.
        let unaddressable = format!("{SUBJECT}:{ALICE}");
        assert!(unaddressable.starts_with(SUBJECT));
        assert!(!folds_into(&unaddressable, SUBJECT));
    }

    #[test]
    fn a_record_belonging_to_an_actor_we_could_not_reach_is_kept() {
        // THE one that matters. An actor we didn't read says nothing about whether they
        // still endorse, so treating their absence as a withdrawal would empty every count
        // they contribute to for as long as their relay, their DHT record, or the network
        // is unhappy.
        let rkey = pin_derive::engagement_log_rkey(SUBJECT, LIKE, ALICE);
        assert_eq!(withdrawal(&rkey, &keys(&[]), &dids(&[BOB])), None);
        assert_eq!(withdrawal(&rkey, &keys(&[]), &dids(&[])), None);
    }

    #[test]
    fn one_actors_withdrawal_does_not_touch_anothers_record() {
        // Both endorse the same subject; only Bob was read and only Bob stopped. Alice's
        // record is not his to withdraw.
        let alice_key = pin_derive::engagement_log_rkey(SUBJECT, LIKE, ALICE);
        let bob_key = pin_derive::engagement_log_rkey(SUBJECT, LIKE, BOB);
        let found = keys(&[(SUBJECT, LIKE, ALICE)]);
        let reached = dids(&[ALICE, BOB]);
        assert_eq!(withdrawal(&alice_key, &found, &reached), None);
        assert_eq!(
            withdrawal(&bob_key, &found, &reached),
            Some(SUBJECT.to_string())
        );
    }

    #[test]
    fn a_malformed_key_is_left_alone_rather_than_guessed_at() {
        assert_eq!(withdrawal("nocolon", &keys(&[]), &dids(&[ALICE])), None);
    }

    #[test]
    fn the_actor_set_is_every_identity_there_is_a_reason_to_read() {
        // Three sources, because there are three ways to have a reason: a channel you
        // follow, a person you follow wholesale, and an author you subscribe to. Parsed
        // from JSON rather than constructed, so this also pins the settings field names —
        // the class of mistake no compiler on either side can see.
        let settings: SettingsView = serde_json::from_str(
            r#"{
                "follows":[{"didDht":"did:dht:alice","channelID":"c1"}],
                "handleFollows":["did:dht:bob"],
                "subscriptions":[
                  {"channelID":"c2","channelKey":"KK","didDht":"did:dht:carol"},
                  {"channelID":"c3","channelKey":"KK"}
                ]
            }"#,
        )
        .unwrap();

        let actors = graph_actors(&settings);
        assert_eq!(
            actors,
            dids(&["did:dht:alice", "did:dht:bob", "did:dht:carol"])
        );
        // A legacy subscription with no did:dht contributes nobody rather than an empty
        // string, which would be an actor whose directory can never resolve.
        assert!(!actors.contains(""));
    }

    #[test]
    fn an_identity_named_twice_is_read_once() {
        // Following someone's channel AND subscribing to them is ordinary. Their directory
        // is one blob, and fetching it twice per pass would double the crawl's Sia reads.
        let settings: SettingsView = serde_json::from_str(
            r#"{
                "follows":[{"didDht":"did:dht:alice","channelID":"c1"}],
                "handleFollows":["did:dht:alice"],
                "subscriptions":[{"channelID":"c2","channelKey":"KK","didDht":"did:dht:alice"}]
            }"#,
        )
        .unwrap();
        assert_eq!(graph_actors(&settings).len(), 1);
    }

    fn tallies(
        count: usize,
        root: &str,
        updated: &str,
        retention: Option<&str>,
    ) -> BTreeMap<String, Aggregate> {
        let mut kinds = BTreeMap::new();
        kinds.insert(
            pin_engagement::KIND_LIKE.to_string(),
            pin_engagement::KindTally {
                count,
                set_root: root.to_string(),
                sample_actors: vec![ALICE.to_string()],
                retention_checked_at: retention.map(str::to_string),
            },
        );
        let mut map = BTreeMap::new();
        map.insert(
            SUBJECT.to_string(),
            Aggregate {
                kinds,
                updated_at: updated.to_string(),
            },
        );
        map
    }

    #[test]
    fn a_pass_that_only_moved_the_clock_does_not_republish() {
        // THE guard that makes the floor affordable. Every pass restamps `updatedAt`,
        // and every successful retention check restamps `retentionCheckedAt` — so a
        // fingerprint taken over the published map verbatim would mint a fresh Sia
        // object every cadence, for every channel anyone has ever endorsed, forever.
        let before = substance(&tallies(3, "root-a", "2026-08-12T10:00:00.000Z", None)).unwrap();
        let after = substance(&tallies(
            3,
            "root-a",
            "2026-08-12T10:10:00.000Z",
            Some("2026-08-12T10:10:00.000Z"),
        ))
        .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn a_count_that_moved_republishes() {
        let before = substance(&tallies(3, "root-a", "2026-08-12T10:00:00.000Z", None)).unwrap();
        let after = substance(&tallies(4, "root-b", "2026-08-12T10:00:00.000Z", None)).unwrap();
        assert_ne!(before, after);
    }

    #[test]
    fn the_same_count_over_a_different_set_republishes() {
        // One actor withdrawing as another arrives leaves the count identical and the
        // set entirely different. The root is a commitment over the set, which is why
        // it is fingerprinted rather than the number in front of it.
        let before = substance(&tallies(3, "root-a", "2026-08-12T10:00:00.000Z", None)).unwrap();
        let after = substance(&tallies(3, "root-b", "2026-08-12T10:00:00.000Z", None)).unwrap();
        assert_ne!(before, after);
    }

    #[test]
    fn a_channels_first_endorsement_republishes() {
        // An empty map has to fingerprint differently from a populated one, or a
        // channel's counts would never reach the floor at all.
        let empty = substance(&BTreeMap::new()).unwrap();
        let one = substance(&tallies(1, "root-a", "2026-08-12T10:00:00.000Z", None)).unwrap();
        assert_ne!(empty, one);
    }

    #[test]
    fn a_channel_nobody_has_endorsed_publishes_nothing() {
        // The common case by a wide margin, and the expensive one to get wrong: an
        // empty map would still mint a Sia object — a whole slab — to say "nothing",
        // and a DHT record pointing at it, on every channel that has never been
        // endorsed.
        assert!(nothing_to_publish(&BTreeMap::new(), None));
    }

    #[test]
    fn a_channel_emptied_of_endorsements_still_publishes_the_emptying() {
        // Once something has been published, empty stops meaning "nothing" and starts
        // meaning "every endorsement was withdrawn" — which has to reach the floor, or
        // a reader keeps seeing counts for a set that no longer exists.
        let previous = state("gen-1", None);
        assert!(!nothing_to_publish(&BTreeMap::new(), Some(&previous)));
    }

    #[test]
    fn a_channel_with_counts_publishes_them() {
        let map = tallies(1, "root-a", "2026-08-12T10:00:00.000Z", None);
        assert!(!nothing_to_publish(&map, None));
    }

    /// One subject's tally, out of the map [`tallies`] builds.
    fn state(id: &str, older: Option<&str>) -> crate::PublishedState {
        crate::PublishedState {
            id: id.to_string(),
            url: None,
            older_id: older.map(str::to_string),
            fp: None,
        }
    }

    #[test]
    fn the_generation_just_superseded_is_left_alive() {
        // The keep-2 rule, and the reason it exists: a pointer takes seconds to
        // propagate, so a reader can still be resolving the object this publish
        // replaces. Reclaiming it turns "slightly stale counts" into "object not
        // found" for everyone mid-read.
        assert_eq!(reclaimable(Some(&state("gen-2", None)), "gen-3"), None);
    }

    #[test]
    fn the_generation_before_that_is_reclaimed() {
        assert_eq!(
            reclaimable(Some(&state("gen-2", Some("gen-1"))), "gen-3"),
            Some("gen-1".to_string())
        );
    }

    #[test]
    fn a_first_publish_reclaims_nothing() {
        assert_eq!(reclaimable(None, "gen-1"), None);
    }

    #[test]
    fn an_object_that_is_current_again_is_never_reclaimed() {
        // Belt and braces against deleting live bytes: neither the object this publish
        // just wrote nor the one it is keeping as grace can be the reclaim target,
        // however the publish state got into that shape.
        assert_eq!(
            reclaimable(Some(&state("gen-1", Some("gen-1"))), "gen-2"),
            None
        );
        assert_eq!(
            reclaimable(Some(&state("gen-2", Some("gen-3"))), "gen-3"),
            None
        );
        // And an empty id names nothing, so it is not a reclaim target either.
        assert_eq!(reclaimable(Some(&state("gen-2", Some(""))), "gen-3"), None);
    }

    fn mark(url: &str, epoch: u32) -> CrawlMark {
        CrawlMark {
            url: url.to_string(),
            epoch,
        }
    }

    #[test]
    fn an_actor_we_have_never_read_is_downloaded() {
        // No mark means nothing in the log to answer from, so there is nothing to skip TO.
        assert!(!may_skip(None, &mark("sia://a", CRAWL_EPOCH)));
    }

    #[test]
    fn an_unchanged_pointer_is_answered_without_a_download() {
        // The whole point: content-addressing makes an identical URL a proof of identical
        // bytes, so last pass's extraction is this pass's answer.
        let held = mark("sia://a", CRAWL_EPOCH);
        assert!(may_skip(Some(&held), &mark("sia://a", CRAWL_EPOCH)));
    }

    #[test]
    fn a_moved_pointer_is_downloaded_again() {
        // A new URL is new bytes — an endorsement added, or withdrawn.
        let held = mark("sia://a", CRAWL_EPOCH);
        assert!(!may_skip(Some(&held), &mark("sia://b", CRAWL_EPOCH)));
    }

    #[test]
    fn a_pointer_read_by_an_older_parse_is_downloaded_again() {
        // The guard that keeps this from being a one-way door. An unchanged pointer proves
        // the BYTES are the same; it says nothing about whether our reading of them is
        // current. Drop the epoch and a new endorsement kind would never reach anyone
        // already crawled — silently, since every pass would report a clean skip.
        let held = mark("sia://a", CRAWL_EPOCH - 1);
        assert!(!may_skip(Some(&held), &mark("sia://a", CRAWL_EPOCH)));
    }
}
