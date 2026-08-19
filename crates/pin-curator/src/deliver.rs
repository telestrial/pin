//! Tell people what this identity endorsed, instead of waiting to be found.
//!
//! Everything else in engagement is pull-shaped: an author's crawl reads the directories
//! of people in their graph and folds what it finds. That works exactly as far as the
//! graph reaches, and no further — an author who has never heard of you does not read your
//! directory, so a like on their post is one they can never count. Delivery is the other
//! half, and it is the ONLY route for engagement from outside the graph.
//!
//! A knock carries the signed record itself, so the receiver verifies it on the spot: a
//! `did:dht` IS its ed25519 public key, so checking costs a parse and no network at all.
//! That is what makes accepting a stranger's knock affordable, and it is why this sends
//! the record rather than a pointer to one — a pointer would make an unauthenticated
//! stranger able to trigger a download.
//!
//! **Who to knock comes from the record where it can.** A public subject carries plaintext
//! coordinates, and the author's did:dht is in them. An unlisted one carries none — that
//! absence IS its tiering — so the target is recovered by recomputing subjects over the
//! subscribed channels this identity holds keys for. Same table either way; only the
//! source differs.
//!
//! **Where to dial comes from the target's own record.** Their published coordinates carry
//! a relay URL per endpoint, so a dial is made from what was resolved rather than by
//! handing a bare node id to iroh's discovery service — see the `instance` module docs for
//! why that distinction is worth the packet space.
//!
//! **Taking one back is pushed too, and has to be.** Withdrawing an endorsement deletes the
//! record where it lived, and an author who found it by crawling our directory sees the
//! absence on their next pass. An author who learned of it by knock has no crawl of us at
//! all — so without a signed withdrawal sent the same way, delivery would only ever ADD to
//! an out-of-graph count and nothing would ever take away.
//!
//! The delivery mark is what makes that possible: it outlives the endorsement, so a mark
//! with nothing behind it IS the withdrawal, and it carries the target because by then the
//! record that named one is gone.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use iroh::{Endpoint, EndpointAddr};
use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, engine::LiveEvent, AuthorId};
use n0_future::StreamExt as _;
use pin_engagement::Endorsement;

use crate::{read_record, read_settings, InstanceAddr, SettingsView};

/// How long to give one dial before moving to the next endpoint.
///
/// Short on purpose: an identity advertises several endpoints and the first is only the
/// most likely to answer, not the certain one. Waiting out a sleeping desktop would keep
/// us from trying the tab that is actually awake.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the whole knock gets once a connection is open.
const KNOCK_TIMEOUT: Duration = Duration::from_secs(10);

/// Everything a delivery pass needs.
pub struct DeliverContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// The endpoint this instance already has. Borrowed rather than bound: a second
    /// endpoint would need its own relay connection, and dialing from the one that is
    /// already up is what a peer sees us as anyway.
    pub endpoint: Endpoint,
    pub app_key: [u8; 32],
}

/// What one pass did about ONE endorsement — the decisions it made, in order.
///
/// Kept because the interesting failures here are all silent by nature: a target that
/// can't be worked out, coordinates that name an endpoint without locating it, a dial
/// nobody answers. Each leaves the same trace in the doc as never having tried, which is
/// nothing. A count says a pass delivered nothing; this says why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DeliverStep {
    /// The endorsement, by its own address.
    pub rkey: String,
    /// Who this is about, once worked out — the author of the endorsed item.
    pub target: Option<String>,
    /// How many endpoints the target advertises, and how many of those say enough to
    /// dial. `endpoints > 0` with `dialable == 0` is an identity advertised but
    /// unreachable, which is invisible from every other angle.
    pub endpoints: usize,
    pub dialable: usize,
    /// delivered | already | no target | own | unreachable.
    pub result: &'static str,
}

/// What one pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DeliverOutcome {
    /// Endorsements knocked through to their author this pass.
    pub delivered: usize,
    /// Endorsements already delivered, unchanged since. The steady state.
    pub already: usize,
    /// Endorsements whose author couldn't be reached. Retried next pass — the mark is
    /// only written once a knock lands.
    pub unreachable: usize,
    /// Endorsements with nobody to knock: no reference, and no subscribed channel whose
    /// subjects match. Ordinary for an endorsement made before its channel loaded.
    pub no_target: usize,
    /// Endorsements of this identity's own items. Nothing to deliver — the fold reads
    /// them locally.
    pub own: usize,
    /// Withdrawals knocked through: a gesture taken back, and its author told.
    pub retracted: usize,
    /// Withdrawals whose author couldn't be reached. The mark stays, so the next pass
    /// tries again — an author left counting something withdrawn is the failure this
    /// exists to prevent, and forgetting the mark would make it permanent.
    pub retract_failed: usize,
    /// Delivery marks forgotten without telling anyone: written before marks recorded a
    /// target, so there is nobody to tell.
    pub dropped: usize,
    /// One entry per endorsement considered, for when the counts aren't enough to say
    /// what went wrong.
    pub steps: Vec<DeliverStep>,
}

/// What was last delivered for one endorsement, and to whom.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct DeliverMark {
    /// The signature of the record that was sent.
    sig: String,
    /// The author it was sent to.
    ///
    /// Recorded because this mark outlives the endorsement: once the gesture is withdrawn
    /// the record is gone, and with it the reference that named its author and the
    /// subject table entry that could have recovered one. The mark is then the only thing
    /// that still knows who was told, which is exactly who has to hear it was taken back.
    ///
    /// Absent on marks written before retraction existed. Those can only be forgotten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

/// Whether an endorsement still needs knocking through.
///
/// Compared by SIGNATURE rather than by presence. An endorsement re-signed against an
/// edited item asserts something new about a different version, and the author has to hear
/// it; a mark that only recorded "delivered" would swallow that silently. The signature is
/// deterministic for given content, so an unchanged record compares equal and a rewritten
/// one does not.
fn needs_delivery(held: Option<&DeliverMark>, sig: &str) -> bool {
    held.map(|m| m.sig.as_str()) != Some(sig)
}

/// Who to knock about one endorsement.
///
/// The record's own coordinates first — a public subject carries the author's did:dht, and
/// it has been checked against the subject hash by then, so it cannot name someone else's
/// channel. Otherwise the subject is looked up among the channels this identity holds keys
/// for, which is how an unlisted channel's author is found: their record carries no
/// coordinates by design, but we can recompute the subject ourselves.
fn target_for(record: &Endorsement, subjects: &HashMap<String, String>) -> Option<String> {
    if let Some(r) = &record.reference {
        return Some(r.did_dht.clone());
    }
    subjects.get(&record.subject).cloned()
}

/// Turn published coordinates into something dialable.
///
/// An endpoint with no address is dropped rather than dialed: dialing a bare id is exactly
/// the fall-through to a discovery service that publishing addresses exists to avoid, and
/// a peer that advertised no address has said it doesn't know where it is.
fn dialable(addr: &InstanceAddr) -> Option<EndpointAddr> {
    let id = addr.node_id.parse().ok()?;
    let relay = addr.relay.as_deref()?.parse().ok()?;
    Some(EndpointAddr::new(id).with_relay_url(relay))
}

/// Every subject belonging to a channel this identity subscribes to, mapped to that
/// channel's author.
///
/// Built only when something actually needs it — it opens each cached manifest, and most
/// passes have nothing undelivered at all. A subscription with no did:dht names nobody to
/// knock, and a channel with no cached manifest has no subjects to compute yet; both are
/// ordinary and contribute nothing.
async fn subscribed_subjects(
    ctx: &DeliverContext,
    settings: &SettingsView,
) -> HashMap<String, String> {
    let mut table = HashMap::new();
    for sub in &settings.subscriptions {
        let Some(did) = sub.did_dht.as_deref() else {
            continue;
        };
        let Some(k) = pin_crypto::channel_key_from_base64(&sub.channel_key) else {
            continue;
        };
        let Ok(Some(sealed)) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            crate::SUB_COLLECTION,
            &sub.channel_id,
        )
        .await
        else {
            continue;
        };
        let Ok(blob) = String::from_utf8(sealed) else {
            continue;
        };
        let Ok(json) = pin_channel::open_blob(&k, &blob) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<pin_manifest::ChannelManifest>(&json) else {
            continue;
        };

        for item in &manifest.items {
            table.insert(
                pin_crypto::engagement_subject(&sub.channel_id, &item.published_at),
                did.to_string(),
            );
            for att in item.attachments.iter().flatten() {
                if let Some(hash) = &att.content_hash {
                    table.insert(
                        pin_crypto::attachment_subject(&sub.channel_id, &item.published_at, hash),
                        did.to_string(),
                    );
                }
            }
        }
    }
    table
}

/// This identity's endorsements, by rkey.
async fn own_endorsements(ctx: &DeliverContext) -> BTreeMap<String, Endorsement> {
    let rkeys = crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::ENDORSE_COLLECTION)
        .await
        .unwrap_or_default();
    let mut out = BTreeMap::new();
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
            out.insert(rkey, record);
        }
    }
    out
}

/// Where a target can currently be dialed, in the order they advertised.
async fn resolve_endpoints(did: &str) -> Vec<InstanceAddr> {
    let Ok(records) = pin_pkarr::resolve(did).await else {
        return Vec::new();
    };
    crate::parse_endpoints(&pin_pkarr::rejoin_txt(
        &records,
        crate::identity::IROH_PREFIX,
    ))
}

/// Knock once, at whichever advertised endpoint answers first.
///
/// Returns whether the record was handed over. There is no reply to read — a knock is a
/// unidirectional stream by design — so what this can report is that the stream was
/// written and closed cleanly, which is QUIC confirming the peer received it.
/// Hand one record to a target, trying its endpoints in turn.
///
/// Takes the record already as JSON rather than as an `Endorsement`, because the same
/// dial-and-send serves a withdrawal: `pin-rpc` is a courier that never parses what it
/// carries, so what varies between the two is only what was serialized.
async fn knock(
    ctx: &DeliverContext,
    endpoints: &[InstanceAddr],
    record: &serde_json::Value,
) -> bool {
    let frame = pin_rpc::hey_request(record);

    for addr in endpoints.iter().filter_map(dialable) {
        let Ok(Ok(conn)) =
            n0_future::time::timeout(DIAL_TIMEOUT, ctx.endpoint.connect(addr, pin_rpc::ALPN)).await
        else {
            continue;
        };
        let sent = n0_future::time::timeout(KNOCK_TIMEOUT, send_knock(&conn, &frame))
            .await
            .unwrap_or(false);
        conn.close(0u32.into(), b"bye");
        if sent {
            return true;
        }
    }
    false
}

/// Hand one knock over, and wait until the receiver has actually taken it.
///
/// The wait is the point. `finish()` closes our side of the stream and says nothing about
/// the peer having read it, so a sender that finished and closed the connection would tear
/// the stream down underneath the receiver's read — marking knocks delivered that never
/// arrived. The receiver closes its (empty) side once it has parked the frame, so this read
/// completing is what makes the delivery mark honest.
async fn send_knock(conn: &iroh::endpoint::Connection, frame: &[u8]) -> bool {
    let Ok((mut send, mut recv)) = conn.open_bi().await else {
        return false;
    };
    if send.write_all(frame).await.is_err() {
        return false;
    }
    if send.finish().is_err() {
        return false;
    }
    // Empty by protocol; what matters is that it completes rather than what it holds.
    recv.read_to_end(pin_rpc::MAX_FRAME).await.is_ok()
}

/// One pass: knock through every endorsement whose author hasn't heard it yet.
///
/// Never gives up the whole pass for one endorsement. An author who can't be reached is
/// counted and left for the next pass, because their being asleep says nothing about
/// anyone else's reachability.
pub async fn deliver_once(
    ctx: &DeliverContext,
    own_did: &str,
    now_iso: &str,
) -> Result<DeliverOutcome, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;
    let records = own_endorsements(ctx).await;
    let mut outcome = DeliverOutcome::default();

    // Built lazily: it opens every cached manifest, and a pass with nothing undelivered —
    // which is most of them — needs no table at all.
    let mut subjects: Option<HashMap<String, String>> = None;

    for (rkey, record) in &records {
        let held = read_mark(ctx, rkey).await;
        let mut step = DeliverStep {
            rkey: rkey.clone(),
            target: None,
            endpoints: 0,
            dialable: 0,
            result: "already",
        };
        if !needs_delivery(held.as_ref(), &record.sig) {
            outcome.already += 1;
            outcome.steps.push(step);
            continue;
        }

        if subjects.is_none() {
            subjects = Some(subscribed_subjects(ctx, &settings).await);
        }
        let Some(target) = target_for(record, subjects.as_ref().expect("just built")) else {
            outcome.no_target += 1;
            step.result = "no target";
            outcome.steps.push(step);
            continue;
        };
        step.target = Some(target.clone());
        if target == own_did {
            // Our own item. The fold reads these straight out of the doc, so there is
            // nobody to tell.
            outcome.own += 1;
            step.result = "own";
            outcome.steps.push(step);
            continue;
        }

        let endpoints = resolve_endpoints(&target).await;
        step.endpoints = endpoints.len();
        step.dialable = endpoints.iter().filter_map(dialable).count();
        let Ok(value) = serde_json::to_value(record) else {
            outcome.no_target += 1;
            step.result = "no target";
            outcome.steps.push(step);
            continue;
        };
        let sent = knock(ctx, &endpoints, &value).await;
        step.result = if sent { "delivered" } else { "unreachable" };
        outcome.steps.push(step);
        if sent {
            write_mark(
                ctx,
                rkey,
                &DeliverMark {
                    sig: record.sig.clone(),
                    target: Some(target),
                },
            )
            .await;
            outcome.delivered += 1;
        } else {
            // No mark: an undelivered endorsement stays undelivered, and the next pass
            // tries again. Recording a knock that didn't land would lose it for good.
            outcome.unreachable += 1;
        }
    }

    let orphans = retract_orphans(ctx, &records, now_iso).await;
    outcome.retracted = orphans.retracted;
    outcome.retract_failed = orphans.failed;
    outcome.dropped = orphans.dropped;
    Ok(outcome)
}

/// What became of the marks with no endorsement behind them.
#[derive(Default)]
struct Orphans {
    retracted: usize,
    failed: usize,
    dropped: usize,
}

/// What a mark left without its endorsement is worth telling somebody about.
///
/// `None` when there is nothing to say or nobody to say it to — a mark written before
/// targets were recorded, or a key that doesn't name a gesture. Those are forgotten, since
/// retrying something that can never be built would keep the mark forever.
fn withdrawal_from<'a>(
    rkey: &'a str,
    mark: Option<&'a DeliverMark>,
) -> Option<(&'a str, &'a str, &'a str)> {
    let target = mark?.target.as_deref()?;
    let (kind, subject) = pin_derive::parse_endorse_rkey(rkey)?;
    Some((target, kind, subject))
}

/// Tell the authors of withdrawn endorsements that they were withdrawn.
///
/// A mark with no endorsement behind it means the gesture is gone: the record was deleted
/// where it lived, and this is the receipt of having told somebody about it. An author who
/// found the endorsement by crawling our directory sees the absence on their next pass, but
/// one who learned of it by knock has no crawl of us at all — so without this they count it
/// forever, and the count is wrong in the direction that flatters.
///
/// The mark is deleted only once the withdrawal has landed. An unreachable author leaves it
/// in place to be retried, which is the same rule delivery follows and for the same reason:
/// forgetting a knock that didn't arrive makes the error permanent.
///
/// The subject and kind come from the mark's own key, since by now they exist nowhere else.
async fn retract_orphans(
    ctx: &DeliverContext,
    records: &BTreeMap<String, Endorsement>,
    now_iso: &str,
) -> Orphans {
    let marks = crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::DELIVER_COLLECTION)
        .await
        .unwrap_or_default();
    let seed = pin_derive::did_dht_seed(&ctx.app_key);
    let mut out = Orphans::default();

    for rkey in marks {
        if records.contains_key(&rkey) {
            continue;
        }
        let held = read_mark(ctx, &rkey).await;
        let Some((target, kind, subject)) = withdrawal_from(&rkey, held.as_ref()) else {
            if forget_mark(ctx, &rkey).await {
                out.dropped += 1;
            }
            continue;
        };

        // Stamped now rather than when the gesture was withdrawn, which we never observed.
        // Later is the safe direction: a withdrawal is honoured only if it is newer than
        // the endorsement it names, so noticing late can only make it more clearly newer.
        let Ok(record) = pin_engagement::Retraction::sign(&seed, kind, subject, now_iso) else {
            out.failed += 1;
            continue;
        };
        let Ok(value) = serde_json::to_value(&record) else {
            out.failed += 1;
            continue;
        };

        let endpoints = resolve_endpoints(&target).await;
        if knock(ctx, &endpoints, &value).await && forget_mark(ctx, &rkey).await {
            out.retracted += 1;
        } else {
            out.failed += 1;
        }
    }
    out
}

async fn forget_mark(ctx: &DeliverContext, rkey: &str) -> bool {
    crate::delete_record(
        &ctx.doc,
        ctx.author_id,
        pin_derive::DELIVER_COLLECTION,
        rkey,
    )
    .await
    .is_ok()
}

async fn read_mark(ctx: &DeliverContext, rkey: &str) -> Option<DeliverMark> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        pin_derive::DELIVER_COLLECTION,
        rkey,
    )
    .await
    .ok()??;
    serde_json::from_slice(&raw).ok()
}

async fn write_mark(ctx: &DeliverContext, rkey: &str, mark: &DeliverMark) {
    let Ok(bytes) = serde_json::to_vec(mark) else {
        return;
    };
    let _ = crate::write_record(
        &ctx.doc,
        ctx.author_id,
        pin_derive::DELIVER_COLLECTION,
        rkey,
        bytes,
    )
    .await;
}

/// Whether an event says this identity endorsed something.
///
/// Both directions count. A local write is this instance's own click; a remote one is
/// another instance of the same identity syncing in an endorsement it may not have been
/// in a position to deliver itself, and whichever instance is up should carry it.
///
/// Everything else in the doc — tallies, the engagement log, this loop's own delivery
/// marks — is other work, and waking on it would run a pass per doc write. The marks
/// matter most: waking on those is a loop feeding itself.
fn endorsement_written(event: &LiveEvent) -> bool {
    let key = match event {
        LiveEvent::InsertLocal { entry } => entry.key(),
        LiveEvent::InsertRemote { entry, .. } => entry.key(),
        _ => return false,
    };
    String::from_utf8_lossy(key).starts_with(&pin_derive::collection_prefix(
        pin_derive::ENDORSE_COLLECTION,
    ))
}

/// What ended a wait.
enum Woke {
    /// An endorsement was written, so there is something new to deliver.
    Endorsement,
    /// The cadence came round.
    Timeout,
    /// The doc's stream closed and will not wake us again.
    Ended,
}

/// Pass, wait, repeat — forever.
///
/// Woken by an endorsement being written, because a cadence alone cannot be short enough:
/// a like is a thing a person just did, and waiting out even a settled cadence to send it
/// is latency the author sees as a count that isn't there yet. The two cadences are the
/// backstop under that — a pass with something outstanding comes round quickly, a settled
/// one waits — so a wake that never arrives costs freshness rather than delivery.
///
/// Held for `settle` after a wake, so a burst costs one pass rather than one each: pinning
/// a channel writes an endorsement per item.
///
/// The clock belongs to the caller for the same reason every other loop's does.
pub async fn run_deliver_loop(
    ctx: DeliverContext,
    own_did: String,
    cadence: Duration,
    retry: Duration,
    settle: Duration,
    now_iso: impl Fn() -> String,
    on_pass: impl Fn(&Result<DeliverOutcome, String>),
) -> ! {
    // A doc whose stream is unavailable falls back to the cadence alone, which is slower
    // but never wrong.
    let mut events = ctx.doc.subscribe().await.ok().map(Box::pin);
    loop {
        let outcome = deliver_once(&ctx, &own_did, &now_iso()).await;
        // A FAILED pass counts as outstanding too. Its commonest cause is settings not
        // being written yet, which is where every fresh instance starts — and settling on
        // that would put the first knock a whole cadence away, on the one path engagement
        // from outside the graph has.
        let outstanding = !matches!(&outcome, Ok(o) if o.unreachable == 0 && o.no_target == 0 && o.retract_failed == 0);
        on_pass(&outcome);
        let wait = if outstanding { retry } else { cadence };

        let woke = match events.as_mut() {
            Some(stream) => {
                let woken = async {
                    loop {
                        match stream.next().await {
                            Some(Ok(ev)) if endorsement_written(&ev) => return Woke::Endorsement,
                            Some(_) => continue,
                            None => return Woke::Ended,
                        }
                    }
                };
                let timeout = async {
                    n0_future::time::sleep(wait).await;
                    Woke::Timeout
                };
                n0_future::future::race(woken, timeout).await
            }
            None => {
                n0_future::time::sleep(wait).await;
                Woke::Timeout
            }
        };
        match woke {
            Woke::Endorsement => n0_future::time::sleep(settle).await,
            Woke::Timeout => {}
            // Dropped rather than re-polled: a closed stream yields `None` forever, so
            // racing it again would return instantly and turn the cadence into a spin.
            Woke::Ended => events = None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUBJECT: &str = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";

    /// A local write of `key`, as the engine reports one.
    fn wrote(key: &str) -> LiveEvent {
        let id = iroh_docs::sync::RecordIdentifier::new(
            iroh_docs::NamespaceId::from(&[1u8; 32]),
            iroh_docs::AuthorId::from(&[2u8; 32]),
            key,
        );
        // A non-empty length: `Record::new` insists a zero-length record carry the hash of
        // the empty range, and the length is nothing to do with what's under test.
        let record = iroh_docs::sync::Record::new(iroh_blobs::Hash::from([3u8; 32]), 1, 0);
        LiveEvent::InsertLocal {
            entry: iroh_docs::sync::Entry::new(id, record),
        }
    }

    #[test]
    fn only_an_endorsement_wakes_delivery() {
        assert!(endorsement_written(&wrote("endorse/like:abc")));

        // The one that would feed the loop itself: a pass writes a mark for everything it
        // delivers, so waking on those means a knock schedules the pass that follows it,
        // forever.
        assert!(!endorsement_written(&wrote("deliver/like:abc")));
        // And the doc carries every other loop's writes. Tallies alone land on a
        // 30-second cadence, so waking on them is a pass per tally for as long as anyone
        // is endorsing anything.
        assert!(!endorsement_written(&wrote("tally/chan:abc")));
        assert!(!endorsement_written(&wrote(
            "engagement-log/abc:like:did:dht:x"
        )));

        // Swarm churn says who we're talking to, not that anything was written.
        let peer = iroh::PublicKey::from_bytes(&[0u8; 32]).unwrap();
        assert!(!endorsement_written(&LiveEvent::NeighborUp(peer)));
    }

    fn record(sig: &str, reference: Option<&str>) -> Endorsement {
        Endorsement {
            kind: pin_engagement::KIND_LIKE.into(),
            actor: "did:dht:me".into(),
            subject: SUBJECT.into(),
            version: "bafkreisomething".into(),
            created_at: "2026-08-16T12:00:00.000Z".into(),
            sig: sig.into(),
            reference: reference.map(|did| pin_engagement::SubjectRef {
                did_dht: did.into(),
                channel_id: "chan".into(),
                published_at: "2026-08-16T12:00:00.000Z".into(),
                attachment: None,
            }),
        }
    }

    fn mark(sig: &str) -> DeliverMark {
        DeliverMark {
            sig: sig.into(),
            target: Some("did:dht:author".into()),
        }
    }

    #[test]
    fn an_orphaned_mark_says_who_to_tell_and_what_about() {
        // The mark outlives the endorsement, so by the time a withdrawal is noticed this
        // key and this target are the only surviving record of what the gesture was.
        let subject = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
        let rkey = pin_derive::endorse_rkey("like", subject);
        assert_eq!(
            withdrawal_from(&rkey, Some(&mark("sig-a"))),
            Some(("did:dht:author", "like", subject))
        );
    }

    #[test]
    fn a_mark_with_nobody_to_tell_is_forgotten_rather_than_retried() {
        // Written before marks recorded a target. Nothing can be built from it, so
        // retrying would keep it forever and tell no one.
        let rkey = pin_derive::endorse_rkey("like", "subject");
        let legacy = DeliverMark {
            sig: "sig-a".into(),
            target: None,
        };
        assert_eq!(withdrawal_from(&rkey, Some(&legacy)), None);
        assert_eq!(withdrawal_from(&rkey, None), None);

        // And a key that names no gesture: signing a withdrawal from a half-read key
        // would assert something about a subject that doesn't exist.
        assert_eq!(withdrawal_from("nocolon", Some(&mark("sig-a"))), None);
    }

    #[test]
    fn an_endorsement_nobody_has_been_told_about_is_delivered() {
        assert!(needs_delivery(None, "sig-a"));
    }

    #[test]
    fn one_already_delivered_is_not_sent_again() {
        // The steady state. Without this every pass would re-knock every endorsement
        // this identity has ever made, at every author it has ever engaged with.
        assert!(!needs_delivery(Some(&mark("sig-a")), "sig-a"));
    }

    #[test]
    fn a_re_signed_endorsement_is_delivered_again() {
        // An endorsement rewritten against an edited item asserts something new about a
        // different version, and the author has to hear it. A mark that only recorded
        // "delivered" rather than what was delivered could not tell the two apart.
        assert!(needs_delivery(Some(&mark("sig-a")), "sig-b"));
    }

    #[test]
    fn a_public_records_own_coordinates_name_its_target() {
        // Already checked against the subject hash by the time it is held, so it cannot
        // name someone else's channel.
        let table = HashMap::new();
        assert_eq!(
            target_for(&record("s", Some("did:dht:author")), &table),
            Some("did:dht:author".to_string())
        );
    }

    #[test]
    fn an_unlisted_records_target_is_recovered_from_the_channels_we_hold() {
        // The record carries no coordinates — that absence IS the tiering — so the author
        // is found by recomputing the subject over a channel we hold the key for.
        let table = HashMap::from([(SUBJECT.to_string(), "did:dht:author".to_string())]);
        assert_eq!(
            target_for(&record("s", None), &table),
            Some("did:dht:author".to_string())
        );
    }

    #[test]
    fn an_endorsement_with_nobody_to_tell_is_left_alone() {
        // No coordinates and no matching channel: an endorsement made before its channel
        // loaded, or of one no longer subscribed. Not an error, and nothing to knock.
        assert_eq!(target_for(&record("s", None), &HashMap::new()), None);
    }

    /// A node id in the form an endpoint publishes it.
    ///
    /// HEX, because that is what `EndpointId`'s `Display` emits and the instance registry
    /// registers `endpoint.id().to_string()`. `FromStr` also accepts z-base32, so a
    /// hand-written literal in the other encoding parses happily and then fails to compare
    /// — which is why this is derived from a parse rather than written out twice.
    fn node_id() -> String {
        "1238ae212c14022ec58c4d4f3a8d97c88308caa7bee544a930bd9902c7d40ee1"
            .parse::<iroh::EndpointId>()
            .expect("a valid key")
            .to_string()
    }

    #[test]
    fn an_endpoint_that_says_where_it_is_can_be_dialed() {
        let addr = InstanceAddr {
            node_id: node_id(),
            relay: Some("https://use1-1.relay.n0.iroh.link./".into()),
        };
        let dial = dialable(&addr).expect("a well-formed endpoint is dialable");
        // The id survives publish → parse → dial unchanged, which is what makes the
        // published set usable at all.
        assert_eq!(dial.id.to_string(), addr.node_id);
        assert!(dial.addrs.iter().any(|a| a.is_relay()));
    }

    #[test]
    fn an_endpoint_with_no_address_is_not_dialed() {
        // THE point of publishing addresses. Dialing a bare id is the fall-through to a
        // discovery service that carrying the relay URL exists to avoid, so an endpoint
        // that didn't say where it is gets skipped rather than quietly looked up.
        assert!(dialable(&InstanceAddr {
            node_id: node_id(),
            relay: None,
        })
        .is_none());
    }

    #[test]
    fn a_malformed_endpoint_is_skipped_rather_than_panicking() {
        // Published coordinates are somebody else's bytes, so neither half can be trusted
        // to parse.
        assert!(dialable(&InstanceAddr {
            node_id: "not-a-key".into(),
            relay: Some("https://relay/".into()),
        })
        .is_none());
        assert!(dialable(&InstanceAddr {
            node_id: node_id(),
            relay: Some("not a url".into()),
        })
        .is_none());
    }
}
