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
use pin_engagement::{Endorsement, Retraction};

use crate::{read_record, read_settings, InstanceAddr, SettingsView};

/// How long to give one dial before moving to the next endpoint.
///
/// Short on purpose: an identity advertises several endpoints and the first is only the
/// most likely to answer, not the certain one. Waiting out a sleeping desktop would keep
/// us from trying the tab that is actually awake.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the whole knock gets once a connection is open.
const KNOCK_TIMEOUT: Duration = Duration::from_secs(10);

/// The two kinds of record this loop delivers, and where each keeps its marks.
///
/// Separate keyspaces on both sides. A mark is keyed by the record's own rkey, and the two
/// shapes are `{kind}:{subject}` and `{subject}:{id}` — both a pair around one colon, so a
/// parser told to guess between them would sometimes read a 52-character subject as a kind.
/// What gets built from a misread key here is a SIGNED withdrawal of something else, which
/// is worse than a parse that fails.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
enum Lane {
    /// like, pin, repost — one record per subject per kind.
    Gestures,
    /// Comments, which break that singleton: one actor, several records on one subject.
    Comments,
}

impl Lane {
    const ALL: [Lane; 2] = [Lane::Gestures, Lane::Comments];

    fn records(self) -> &'static str {
        match self {
            Lane::Gestures => pin_derive::ENDORSE_COLLECTION,
            Lane::Comments => pin_derive::COMMENT_COLLECTION,
        }
    }

    fn marks(self) -> &'static str {
        match self {
            Lane::Gestures => pin_derive::DELIVER_COLLECTION,
            Lane::Comments => pin_derive::COMMENT_DELIVER_COLLECTION,
        }
    }

    /// The withdrawal a mark left without its record calls for, built from the key alone —
    /// by now the key is the only surviving description of what went.
    ///
    /// `None` for a key this lane cannot read, which is forgotten rather than retried.
    fn withdrawal(self, seed: &[u8], rkey: &str, now_iso: &str) -> Option<Retraction> {
        match self {
            Lane::Gestures => {
                let (kind, subject) = pin_derive::parse_endorse_rkey(rkey)?;
                Retraction::sign(seed, kind, subject, now_iso).ok()
            }
            Lane::Comments => {
                // Named, because a subject alone is ambiguous once one actor can have
                // several comments on it.
                let (subject, id) = pin_derive::parse_comment_rkey(rkey)?;
                Retraction::sign_comment_withdrawal(seed, subject, now_iso, id).ok()
            }
        }
    }
}

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

/// This identity's records in one lane, by rkey.
async fn own_records(ctx: &DeliverContext, lane: Lane) -> BTreeMap<String, Endorsement> {
    let rkeys = crate::list_rkeys(&ctx.doc, ctx.author_id, lane.records())
        .await
        .unwrap_or_default();
    let mut out = BTreeMap::new();
    for rkey in rkeys {
        let Ok(Some(raw)) =
            read_record(&ctx.doc, &ctx.blobs, ctx.author_id, lane.records(), &rkey).await
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
/// arrived. The receiver closes its (empty) side once it has parked the frame, and resets
/// the stream when it hasn't, so this read completing is what makes the delivery mark
/// honest: a refusal reads as a failure here, no mark is written, and the next pass tries
/// again — the next endpoint first, since another instance of the same identity may have
/// room where this one had none.
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
    let mut outcome = DeliverOutcome::default();

    // Built lazily: it opens every cached manifest, and a pass with nothing undelivered —
    // which is most of them — needs no table at all. Shared across the lanes, since a
    // comment and a like on one post resolve to the same author.
    let mut subjects: Option<HashMap<String, String>> = None;

    for lane in Lane::ALL {
        deliver_lane(
            ctx,
            lane,
            own_did,
            now_iso,
            &settings,
            &mut subjects,
            &mut outcome,
        )
        .await;
    }
    Ok(outcome)
}

/// One lane's pass: deliver what is undelivered, then tell people about what went.
#[allow(clippy::too_many_arguments)]
async fn deliver_lane(
    ctx: &DeliverContext,
    lane: Lane,
    own_did: &str,
    now_iso: &str,
    settings: &SettingsView,
    subjects: &mut Option<HashMap<String, String>>,
    outcome: &mut DeliverOutcome,
) {
    let records = own_records(ctx, lane).await;

    for (rkey, record) in &records {
        let held = read_mark(ctx, lane, rkey).await;
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
            *subjects = Some(subscribed_subjects(ctx, settings).await);
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
                lane,
                rkey,
                &DeliverMark {
                    sig: record.sig.clone(),
                    target: Some(target),
                },
            )
            .await;
            outcome.delivered += 1;
        } else {
            // No mark: an undelivered record stays undelivered, and the next pass tries
            // again. Recording a knock that didn't land would lose it for good.
            outcome.unreachable += 1;
        }
    }

    let orphans = retract_orphans(ctx, lane, &records, now_iso).await;
    outcome.retracted += orphans.retracted;
    outcome.retract_failed += orphans.failed;
    outcome.dropped += orphans.dropped;
}

/// What became of the marks with no endorsement behind them.
#[derive(Default)]
struct Orphans {
    retracted: usize,
    failed: usize,
    dropped: usize,
}

/// Who to tell that a record went, and what to tell them.
///
/// `None` when there is nothing to say or nobody to say it to — a mark written before
/// targets were recorded, or a key this lane cannot read. Those are forgotten, since
/// retrying something that can never be built would keep the mark forever.
fn withdrawal_from<'a>(
    lane: Lane,
    seed: &[u8],
    rkey: &str,
    mark: Option<&'a DeliverMark>,
    now_iso: &str,
) -> Option<(&'a str, Retraction)> {
    let target = mark?.target.as_deref()?;
    Some((target, lane.withdrawal(seed, rkey, now_iso)?))
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
    lane: Lane,
    records: &BTreeMap<String, Endorsement>,
    now_iso: &str,
) -> Orphans {
    let marks = crate::list_rkeys(&ctx.doc, ctx.author_id, lane.marks())
        .await
        .unwrap_or_default();
    let seed = pin_derive::did_dht_seed(&ctx.app_key);
    let mut out = Orphans::default();

    for rkey in marks {
        if records.contains_key(&rkey) {
            continue;
        }
        let held = read_mark(ctx, lane, &rkey).await;
        // Stamped now, since when it was withdrawn was never observed. Later is the safe
        // direction: a withdrawal is honoured only if it is newer than the record it
        // names, so noticing late can only make it more clearly newer.
        let Some((target, record)) = withdrawal_from(lane, &seed, &rkey, held.as_ref(), now_iso)
        else {
            if forget_mark(ctx, lane, &rkey).await {
                out.dropped += 1;
            }
            continue;
        };
        let Ok(value) = serde_json::to_value(&record) else {
            out.failed += 1;
            continue;
        };

        let endpoints = resolve_endpoints(target).await;
        if knock(ctx, &endpoints, &value).await && forget_mark(ctx, lane, &rkey).await {
            out.retracted += 1;
        } else {
            out.failed += 1;
        }
    }
    out
}

async fn forget_mark(ctx: &DeliverContext, lane: Lane, rkey: &str) -> bool {
    crate::delete_record(&ctx.doc, ctx.author_id, lane.marks(), rkey)
        .await
        .is_ok()
}

async fn read_mark(ctx: &DeliverContext, lane: Lane, rkey: &str) -> Option<DeliverMark> {
    let raw = read_record(&ctx.doc, &ctx.blobs, ctx.author_id, lane.marks(), rkey)
        .await
        .ok()??;
    serde_json::from_slice(&raw).ok()
}

async fn write_mark(ctx: &DeliverContext, lane: Lane, rkey: &str, mark: &DeliverMark) {
    let Ok(bytes) = serde_json::to_vec(mark) else {
        return;
    };
    let _ = crate::write_record(&ctx.doc, ctx.author_id, lane.marks(), rkey, bytes).await;
}

/// Whether an event says this identity endorsed or commented on something.
///
/// Both directions count. A local write is this instance's own click; a remote one is
/// another instance of the same identity syncing in a record it may not have been in a
/// position to deliver itself, and whichever instance is up should carry it.
///
/// Everything else in the doc — tallies, the engagement log, this loop's own delivery
/// marks — is other work, and waking on it would run a pass per doc write. The marks
/// matter most: waking on those is a loop feeding itself.
fn deliverable_written(event: &LiveEvent) -> bool {
    let key = match event {
        LiveEvent::InsertLocal { entry } => entry.key(),
        LiveEvent::InsertRemote { entry, .. } => entry.key(),
        _ => return false,
    };
    let key = String::from_utf8_lossy(key);
    Lane::ALL
        .iter()
        .any(|lane| key.starts_with(&pin_derive::collection_prefix(lane.records())))
}

/// What ended a wait.
enum Woke {
    /// A record was written, so there is something new to deliver.
    Written,
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
                            Some(Ok(ev)) if deliverable_written(&ev) => return Woke::Written,
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
            Woke::Written => n0_future::time::sleep(settle).await,
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
    fn only_a_deliverable_record_wakes_delivery() {
        assert!(deliverable_written(&wrote("endorse/like:abc")));
        // Both lanes, or a comment would wait out a whole cadence — and a comment is a
        // thing a person just wrote, sitting on somebody else's post.
        assert!(deliverable_written(&wrote("comment/abc:def")));
        assert!(!deliverable_written(&wrote("comment-deliver/abc:def")));

        // The one that would feed the loop itself: a pass writes a mark for everything it
        // delivers, so waking on those means a knock schedules the pass that follows it,
        // forever.
        assert!(!deliverable_written(&wrote("deliver/like:abc")));
        // And the doc carries every other loop's writes. Tallies alone land on a
        // 30-second cadence, so waking on them is a pass per tally for as long as anyone
        // is endorsing anything.
        assert!(!deliverable_written(&wrote("tally/chan:abc")));
        assert!(!deliverable_written(&wrote(
            "engagement-log/abc:like:did:dht:x"
        )));

        // Swarm churn says who we're talking to, not that anything was written.
        let peer = iroh::PublicKey::from_bytes(&[0u8; 32]).unwrap();
        assert!(!deliverable_written(&LiveEvent::NeighborUp(peer)));
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
            body: None,
            body_url: None,
            attachments: Vec::new(),
            facets: Vec::new(),
        }
    }

    fn mark(sig: &str) -> DeliverMark {
        DeliverMark {
            sig: sig.into(),
            target: Some("did:dht:author".into()),
        }
    }

    const SEED: [u8; 32] = [3u8; 32];
    const WHEN: &str = "2026-08-22T12:00:00.000Z";
    const SUBJECT_HASH: &str = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";

    #[test]
    fn an_orphaned_mark_says_who_to_tell_and_what_about() {
        // The mark outlives the record, so by the time a withdrawal is noticed this key and
        // this target are the only surviving description of what went.
        let rkey = pin_derive::endorse_rkey("like", SUBJECT_HASH);
        let held = mark("sig-a");
        let (target, record) =
            withdrawal_from(Lane::Gestures, &SEED, &rkey, Some(&held), WHEN).unwrap();
        assert_eq!(target, "did:dht:author");
        assert_eq!(record.kind, "like");
        assert_eq!(record.subject, SUBJECT_HASH);
        // A gesture is a singleton at its address, so there is nothing to name.
        assert_eq!(record.target, None);
        assert!(record.verify().is_ok());
    }

    #[test]
    fn an_orphaned_comment_mark_names_the_comment_that_went() {
        // The reason the lanes are separate. One actor can leave several comments on one
        // subject, so a withdrawal naming only the subject would be ambiguous across them —
        // and this key is all that is left to build it from.
        let id = "pcuo7dgvhdlgkmqk6dqxvxqxrvpwbeh7kfxvcmtzegkkxpn2xtxq";
        let rkey = pin_derive::comment_rkey(SUBJECT_HASH, id);
        let held = mark("sig-a");
        let (target, record) =
            withdrawal_from(Lane::Comments, &SEED, &rkey, Some(&held), WHEN).unwrap();
        assert_eq!(target, "did:dht:author");
        assert_eq!(record.kind, pin_engagement::KIND_COMMENT);
        assert_eq!(record.subject, SUBJECT_HASH);
        assert_eq!(record.target.as_deref(), Some(id));
        assert!(record.verify().is_ok());
    }

    #[test]
    fn each_lane_reads_its_own_key_shape() {
        // Both shapes are a pair around one colon, so either parses as the other. A comment
        // key read as a gesture key yields a KIND of 52 base32 characters and a subject of
        // the comment id — a signed withdrawal of something that was never endorsed.
        let id = "pcuo7dgvhdlgkmqk6dqxvxqxrvpwbeh7kfxvcmtzegkkxpn2xtxq";
        let comment_key = pin_derive::comment_rkey(SUBJECT_HASH, id);
        let misread = Lane::Gestures
            .withdrawal(&SEED, &comment_key, WHEN)
            .unwrap();
        assert_eq!(misread.kind, SUBJECT_HASH);
        assert_ne!(misread.subject, SUBJECT_HASH);

        // Which is why they never share a keyspace.
        assert_ne!(Lane::Gestures.marks(), Lane::Comments.marks());
        assert_ne!(Lane::Gestures.records(), Lane::Comments.records());
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
        assert!(withdrawal_from(Lane::Gestures, &SEED, &rkey, Some(&legacy), WHEN).is_none());
        assert!(withdrawal_from(Lane::Gestures, &SEED, &rkey, None, WHEN).is_none());

        // And a key neither lane can read: signing a withdrawal from a half-read key would
        // assert something about a subject that doesn't exist.
        for lane in Lane::ALL {
            assert!(withdrawal_from(lane, &SEED, "nocolon", Some(&mark("sig-a")), WHEN).is_none());
        }
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
