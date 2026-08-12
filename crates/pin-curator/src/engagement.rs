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
//! removed from its actor's directory, so noticing means re-reading that directory. This
//! loop does exactly that every pass, and stamps a subject's tally with the time only when
//! EVERY actor behind it was reached — so a stale check reads as stale instead of being
//! quietly presented as fresh.
//!
//! **An absence only means withdrawal when we actually looked.** An actor we couldn't
//! reach keeps their records: treating unreachable as withdrawn would empty a count on a
//! bad network, and deletion-by-absence is the mistake this codebase has already made
//! twice, in the orphan sweep and in settings.
//!
//! What it does NOT do: reach strangers. A crawl only ever finds endorsements from people
//! whose directories it has reason to read. Engagement from outside the graph arrives by
//! `/hey` instead — that is what the knock is FOR, and it is a separate rung.

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
}

/// What one pass did. Reported rather than summarised, because "reached nobody" and "found
/// nothing" are different states and an instance that can't tell you which is not much use.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct EngagementOutcome {
    /// Actors whose endorsements were read this pass.
    pub reached: usize,
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

/// One actor's current endorsements, read from their published directory.
///
/// Errors mean "couldn't read", which is what keeps their held records alive. An actor who
/// has published a directory with no endorsements returns an empty list — a real answer,
/// and the one that withdraws.
async fn fetch_endorsements(
    ctx: &EngagementContext,
    did: &str,
) -> Result<Vec<Endorsement>, String> {
    let records = pin_pkarr::resolve(did).await?;
    let url = pin_pkarr::rejoin_txt(&records, crate::identity::DIR_PREFIX);
    if url.is_empty() {
        return Err(format!("{did}: no directory published"));
    }
    let bytes = ctx.sia.download_item(&url).await?;
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

/// One pass: read the graph, hold what's verified and ours, withdraw what's gone, and
/// republish every tally that moved.
pub async fn engagement_once(
    ctx: &EngagementContext,
    own_did: &str,
    now_iso: String,
) -> Result<EngagementOutcome, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;
    let subjects = own_subjects(ctx, &settings).await?;
    let mut outcome = EngagementOutcome::default();
    if subjects.is_empty() {
        // Nothing published, so nothing can be endorsed. Not a failure.
        return Ok(outcome);
    }

    // What we found, keyed the way the log is keyed.
    let mut found: BTreeMap<(String, String), Endorsement> = BTreeMap::new();
    // Actors whose directory we actually read. Only these can withdraw anything.
    let mut reached: BTreeSet<String> = BTreeSet::new();

    // Ourselves first, locally.
    reached.insert(own_did.to_string());
    let mut all = vec![(own_did.to_string(), own_endorsements(ctx).await)];

    for did in graph_actors(&settings) {
        if did == own_did {
            continue;
        }
        match fetch_endorsements(ctx, &did).await {
            Ok(records) => {
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
            found.insert((record.subject.clone(), record.actor.clone()), record);
        }
    }

    // Reconcile the held log against what this pass saw.
    let mut touched: BTreeSet<String> = found.keys().map(|(subject, _)| subject.clone()).collect();
    let held = crate::list_rkeys(
        &ctx.doc,
        ctx.author_id,
        pin_derive::ENGAGEMENT_LOG_COLLECTION,
    )
    .await
    .unwrap_or_default();

    let found_keys: BTreeSet<(String, String)> = found.keys().cloned().collect();
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

    for ((subject, actor), record) in &found {
        let rkey = pin_derive::engagement_log_rkey(subject, actor);
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
        let records: Vec<Endorsement> = found
            .iter()
            .filter(|((held_subject, _), _)| held_subject == subject)
            .map(|(_, record)| record.clone())
            .collect();

        let channel_doc = open_channel_doc(ctx, channel_id).await?;
        if records.is_empty() {
            // Nothing endorses it any more. The tally goes rather than sitting at zero:
            // a reader treats an absent tally and a zero one the same, and one fewer
            // record is one fewer thing to sync.
            let _ = channel_doc.del(ctx.author_id, tally_key(subject)).await;
            outcome.cleared += 1;
            continue;
        }

        // Stamped as retention-checked only when EVERY actor behind this subject was read
        // this pass. Otherwise the previous stamp is carried forward, so a stale check
        // reads as stale rather than being presented as fresh.
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
        outcome.tallies += 1;
    }

    Ok(outcome)
}

/// Whether a held record should be withdrawn, and the subject whose tally then moves.
///
/// A record goes only when its actor was READ this pass and no longer says it. Absence from
/// an actor we couldn't reach means nothing — that is the difference between a withdrawal
/// and a bad network, and conflating them would empty a count for the duration of an outage.
/// Deletion by absence is the mistake this codebase has already made twice.
fn withdrawal(
    rkey: &str,
    found: &BTreeSet<(String, String)>,
    reached: &BTreeSet<String>,
) -> Option<String> {
    let (subject, actor) = pin_derive::parse_engagement_log_rkey(rkey)?;
    if found.contains(&(subject.to_string(), actor.to_string())) {
        return None;
    }
    if !reached.contains(actor) {
        return None;
    }
    Some(subject.to_string())
}

/// The retention time a subject's published tally already claims, if any.
///
/// Read author-agnostically, the way a subscriber reads a channel doc: only the author can
/// write to that namespace, so any entry at this key is ours.
async fn held_retention(
    ctx: &EngagementContext,
    channel_doc: &Doc,
    subject: &str,
) -> Option<String> {
    let entry = channel_doc
        .get_one(iroh_docs::store::Query::single_latest_per_key().key_exact(tally_key(subject)))
        .await
        .ok()??;
    let bytes = ctx.blobs.get_bytes(entry.content_hash()).await.ok()?;
    let held: Aggregate = serde_json::from_slice(&bytes).ok()?;
    // Any kind's stamp will do: they are written together, so they agree.
    held.kinds
        .values()
        .find_map(|t| t.retention_checked_at.clone())
}

fn tally_key(subject: &str) -> Vec<u8> {
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
pub async fn run_engagement_loop(
    ctx: EngagementContext,
    own_did: String,
    cadence: Duration,
    now_iso: impl Fn() -> String,
    on_pass: impl Fn(Result<EngagementOutcome, String>),
) -> ! {
    loop {
        on_pass(engagement_once(&ctx, &own_did, now_iso()).await);
        n0_future::time::sleep(cadence).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUBJECT: &str = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
    const ALICE: &str = "did:dht:alice";
    const BOB: &str = "did:dht:bob";

    fn keys(pairs: &[(&str, &str)]) -> BTreeSet<(String, String)> {
        pairs
            .iter()
            .map(|(s, a)| (s.to_string(), a.to_string()))
            .collect()
    }

    fn dids(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|d| d.to_string()).collect()
    }

    #[test]
    fn a_record_its_actor_still_publishes_is_kept() {
        let rkey = pin_derive::engagement_log_rkey(SUBJECT, ALICE);
        assert_eq!(
            withdrawal(&rkey, &keys(&[(SUBJECT, ALICE)]), &dids(&[ALICE])),
            None
        );
    }

    #[test]
    fn a_record_its_actor_no_longer_publishes_is_withdrawn() {
        // Read their directory, the endorsement is gone: that is a withdrawal, and the
        // count has to fall. Without this an unlike would never take effect.
        let rkey = pin_derive::engagement_log_rkey(SUBJECT, ALICE);
        assert_eq!(
            withdrawal(&rkey, &keys(&[]), &dids(&[ALICE])),
            Some(SUBJECT.to_string())
        );
    }

    #[test]
    fn a_record_belonging_to_an_actor_we_could_not_reach_is_kept() {
        // THE one that matters. An actor we didn't read says nothing about whether they
        // still endorse, so treating their absence as a withdrawal would empty every count
        // they contribute to for as long as their relay, their DHT record, or the network
        // is unhappy.
        let rkey = pin_derive::engagement_log_rkey(SUBJECT, ALICE);
        assert_eq!(withdrawal(&rkey, &keys(&[]), &dids(&[BOB])), None);
        assert_eq!(withdrawal(&rkey, &keys(&[]), &dids(&[])), None);
    }

    #[test]
    fn one_actors_withdrawal_does_not_touch_anothers_record() {
        // Both endorse the same subject; only Bob was read and only Bob stopped. Alice's
        // record is not his to withdraw.
        let alice_key = pin_derive::engagement_log_rkey(SUBJECT, ALICE);
        let bob_key = pin_derive::engagement_log_rkey(SUBJECT, BOB);
        let found = keys(&[(SUBJECT, ALICE)]);
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
}
