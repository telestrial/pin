//! Taking comments in: what other people wrote on this identity's posts.
//!
//! The gesture lane and this one are the same shape at a distance — a signed record arrives,
//! is verified against the subject it names, and is held as the receipt a published thing is
//! folded from — and they differ in two ways that matter enough to keep them apart.
//!
//! **A comment is not a singleton at its address.** A gesture is one record per subject per
//! kind, which is what makes unliking work by absence and a duplicate knock harmless. One
//! person can leave three comments on one post, so a comment is addressed by its own id and
//! lives in its own collection — sharing the gesture log would make the second comment
//! replace the first, which is the shipped collision this codebase has already paid for
//! once.
//!
//! **A comment carries a payload the host then publishes.** A count is derived from records
//! nobody but the author reads; a conversation is the words themselves, put out under the
//! author's own channel. That is what makes the size limit in `pin-engagement` a real
//! defence rather than tidiness, and it is why the fold has somewhere to be moderated.
//!
//! Two routes in, the same pair the gesture lane has. A **knock** is the only route from
//! somebody whose blob this identity has no reason to read, and a **crawl** is the floor
//! under it for everybody in the graph — and the one that can withdraw, since only a blob
//! actually read can say a comment is gone.
//!
//! The crawl rides the directory read the gesture crawl already makes, so learning where an
//! actor's comments are costs nothing extra. Reading them is a second Sia fetch, and it
//! happens only when their directory moved. Its mark is kept apart from the directory's for
//! a reason worth stating: one mark covering both would be written when the endorsements
//! parsed, so a comments download that failed straight afterwards would leave the next pass
//! skipping that actor — and a skip counts as reached, which is how absence becomes
//! withdrawal. That is the same "inability to read must never become a write" this codebase
//! has been bitten by three times.
//!
//! One drain, two lanes. `pin-rpc` never parses a record, so the inbox carries both and
//! `engagement` splits them by the one field that says which — anything else would need two
//! drains over one inbox, and whichever ran second would find the other's knocks gone.

use std::collections::{BTreeMap, BTreeSet};

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_engagement::{Endorsement, Retraction};

use crate::engagement::{
    classify_knock, knock_verdict, retraction_verdict, EngagementContext, KnockVerdict, Knocked,
    RetractionVerdict, SubjectTable,
};
use crate::read_record;

/// What one pass did with the comments knocked at this identity.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CommentsOutcome {
    /// Comments taken into the log this pass.
    pub taken: usize,
    /// Knocks whose signature or shape didn't hold up — including a comment with no body,
    /// or one over the size limit, both of which `verify` refuses.
    pub rejected: usize,
    /// Comments about a subject this identity doesn't publish.
    pub not_ours: usize,
    /// Knocks older than what is already held at that address, or already held unchanged.
    /// A duplicate the sender retried, which is what makes redelivery safe.
    pub stale: usize,
    /// Comments removed because their author said so.
    pub retracted: usize,
    /// Withdrawals that didn't hold up, or had nothing to remove.
    pub retractions_ignored: usize,
    /// Withdrawals whose signature or `op` didn't hold up.
    pub retractions_rejected: usize,
    /// Withdrawals about a subject this identity doesn't publish.
    pub retractions_not_ours: usize,
    /// Actors whose comments were read this pass, by download or by confirming their pointer
    /// hadn't moved. Only these can withdraw anything.
    pub reached: usize,
    /// Of those, the ones answered by pointer alone. The whole graph, in steady state.
    pub skipped: usize,
    /// Actors in the graph whose comments couldn't be read. Their held records stay.
    pub unreachable: usize,
    /// Comments removed because the actor who wrote them no longer publishes them.
    pub withdrawn: usize,
    /// Subjects whose conversation was republished.
    pub published: usize,
    /// Comments held but left out of what was published, the subject having more than one
    /// entry can carry. Reported rather than swallowed: a cap nobody is told about reads as
    /// complete.
    pub dropped: usize,
    /// Channels whose conversations reached Sia and the DHT — the floor, and the only copy a
    /// reader without a live replica ever sees.
    pub published_floor: usize,
    /// Channels whose floor publish failed. Retried next pass, and it will be: the
    /// fingerprint does not advance until one succeeds.
    pub floor_failed: usize,
}

/// Whether a knocked payload belongs to this lane.
///
/// By the `kind` field, which both an endorsement and a withdrawal carry — so a comment and
/// the withdrawal of a comment sort together, which is what a lane has to mean for the
/// retraction to find the record it names.
pub(crate) fn is_comment(record: &serde_json::Value) -> bool {
    record.get("kind").and_then(|v| v.as_str()) == Some(pin_engagement::KIND_COMMENT)
}

/// Where one comment belongs in the log: the subject, its own id, then whose it is.
///
/// Derived from the record, so everything that has to agree on the address — the write, the
/// lookup a knock is compared against, the withdrawal that names it — asks the same question
/// of the same thing. The gesture lane learned that the hard way.
///
/// The actor is in the key because the reconcile needs it for every held record and cannot
/// afford a read each: a comment is withdrawn only when the actor who wrote it had their own
/// blob read this pass, so the sweep has to know whose each one is.
pub(crate) fn log_key(record: &Endorsement) -> String {
    pin_derive::comment_log_rkey(&record.subject, &record.comment_id(), &record.actor)
}

/// The address a withdrawal names, or `None` when it names nothing.
///
/// A comment withdrawal has to carry a target: the subject alone cannot say which of an
/// actor's comments is meant. One without it is refused rather than guessed at, since the
/// guess would delete somebody's other comment.
fn retraction_key(record: &Retraction) -> Option<String> {
    Some(pin_derive::comment_log_rkey(
        &record.subject,
        record.target.as_deref()?,
        &record.actor,
    ))
}

/// The timestamp a knock is compared against at one address.
///
/// A comment this pass has already accepted counts, even though nothing is written until the
/// end. Without that, a withdrawal arriving in the same drain as the comment it takes back
/// finds nothing held, is ignored as naming nothing, and the comment is written straight
/// afterwards — so a delivery that carried both would keep the thing that was withdrawn.
fn pending_or_held(
    found: &BTreeMap<String, Endorsement>,
    key: &str,
    held: Option<String>,
) -> Option<String> {
    found.get(key).map(|c| c.created_at.clone()).or(held)
}

/// When the comment already held at one address says it was made, if there is one.
async fn held_created_at(ctx: &EngagementContext, rkey: &str) -> Option<String> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        pin_derive::COMMENT_LOG_COLLECTION,
        rkey,
    )
    .await
    .ok()??;
    serde_json::from_slice::<Endorsement>(&raw)
        .ok()
        .map(|c| c.created_at)
}

/// What this identity last read of one actor's comments.
///
/// Its own mark, not the directory's — see the module docs. Carries the pointer rather than
/// a timestamp, because an unchanged Sia URL proves the bytes are identical: content
/// addressing gives an ETag nobody has to be trusted for.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq, Debug, Clone)]
struct CommentMark {
    url: String,
    epoch: u32,
}

/// Bumped when what gets EXTRACTED from a comments blob changes.
///
/// An unchanged pointer proves the bytes are identical; it says nothing about whether this
/// reading of them is still current, so without this a parse fix would never reach anyone
/// already crawled.
const COMMENT_EPOCH: u32 = 1;

/// Where an actor's comments are, as this pass found out.
///
/// `Absent` is a positive answer and the reason this is three-valued: an actor who published
/// a directory with no comments pointer HAS no comments, which withdraws everything held
/// from them. An actor whose directory could not be read says nothing at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CommentsAt {
    /// Their directory named a comments blob.
    Url(String),
    /// Their directory was read and named none.
    Absent,
    /// Their directory was confirmed unmoved, so the blob it points at is unmoved too.
    ///
    /// An actor whose directory could not be read at all is absent from the map rather than
    /// here: this state is a successful reading, and only a successful reading may withdraw.
    Unchanged,
}

/// Where a directory says its author's comments are.
///
/// Over the PARSED directory, so the distinction that matters is testable without a session:
/// a document that was read and names no blob means they have none, where a document that
/// was never read means nothing at all. Collapsing those is how an inability to read becomes
/// a withdrawal.
pub(crate) fn comments_at(directory: &serde_json::Value) -> CommentsAt {
    match directory.get("commentsURL").and_then(|v| v.as_str()) {
        Some(url) => CommentsAt::Url(url.to_string()),
        None => CommentsAt::Absent,
    }
}

/// Whether an actor's comments can be answered from the log instead of downloaded.
///
/// The dangerous direction is a wrong yes, which means never reading that actor again — so
/// both reasons to say no are named rather than folded into a comparison: no mark at all, and
/// a mark from an older parse.
fn may_skip(held: Option<&CommentMark>, current: &CommentMark) -> bool {
    held == Some(current)
}

/// Whether an actor whose directory did not move can be treated as read.
///
/// Yes only if their comments were read to completion at some point. An unchanged directory
/// proves their comments blob is unchanged too — the pointer to it lives IN the directory —
/// so a mark plus an unmoved directory is as good as a fresh read. With no mark there is
/// nothing to stand on, and treating that as reached would withdraw on the strength of a
/// download that never happened.
fn unchanged_counts_as_read(held: Option<&CommentMark>) -> bool {
    matches!(held, Some(m) if m.epoch == COMMENT_EPOCH)
}

async fn read_mark(ctx: &EngagementContext, did: &str) -> Option<CommentMark> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        pin_derive::COMMENT_CRAWL_COLLECTION,
        did,
    )
    .await
    .ok()??;
    serde_json::from_slice(&raw).ok()
}

async fn write_mark(ctx: &EngagementContext, did: &str, mark: &CommentMark) {
    if read_mark(ctx, did).await.as_ref() == Some(mark) {
        return;
    }
    let Ok(bytes) = serde_json::to_vec(mark) else {
        return;
    };
    let _ = crate::write_record(
        &ctx.doc,
        ctx.author_id,
        pin_derive::COMMENT_CRAWL_COLLECTION,
        did,
        bytes,
    )
    .await;
}

/// One actor's current comments, downloaded from the blob their directory points at.
///
/// Anything that won't parse is skipped rather than failing the actor: one malformed record
/// must not make everything else they wrote unreadable.
async fn download(
    ctx: &EngagementContext,
    did: &str,
    url: &str,
) -> Result<Vec<Endorsement>, String> {
    let bytes = ctx.sia.download_item(url).await?;
    let doc: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("{did}: comments: {e}"))?;
    let Some(list) = doc.get("comments").and_then(|v| v.as_array()) else {
        return Err(format!("{did}: comments blob has no records"));
    };
    Ok(list
        .iter()
        .filter_map(|v| serde_json::from_value::<Endorsement>(v.clone()).ok())
        .collect())
}

/// Read the comments of every actor whose blob this pass can reach.
///
/// Answers with the records found and the actors they were found for. Only an actor in that
/// set can lose a comment below: absence in a blob nobody read is not absence.
pub(crate) async fn crawl(
    ctx: &EngagementContext,
    at: &BTreeMap<String, CommentsAt>,
    outcome: &mut CommentsOutcome,
) -> (Vec<Endorsement>, BTreeSet<String>) {
    let mut records = Vec::new();
    let mut reached = BTreeSet::new();

    for (did, where_they_are) in at {
        match where_they_are {
            CommentsAt::Absent => {
                // Read, and they have none. The answer that withdraws.
                reached.insert(did.clone());
                outcome.reached += 1;
            }
            CommentsAt::Unchanged => {
                if unchanged_counts_as_read(read_mark(ctx, did).await.as_ref()) {
                    reached.insert(did.clone());
                    outcome.reached += 1;
                    outcome.skipped += 1;
                } else {
                    outcome.unreachable += 1;
                }
            }
            CommentsAt::Url(url) => {
                let mark = CommentMark {
                    url: url.clone(),
                    epoch: COMMENT_EPOCH,
                };
                if may_skip(read_mark(ctx, did).await.as_ref(), &mark) {
                    reached.insert(did.clone());
                    outcome.reached += 1;
                    outcome.skipped += 1;
                    continue;
                }
                match download(ctx, did, url).await {
                    Ok(found) => {
                        // After the parse, never before: a mark written on a failed read
                        // would skip this actor forever with nothing in hand.
                        write_mark(ctx, did, &mark).await;
                        reached.insert(did.clone());
                        outcome.reached += 1;
                        records.extend(found);
                    }
                    Err(_) => outcome.unreachable += 1,
                }
            }
        }
    }
    (records, reached)
}

/// What one minting pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MintOutcome {
    /// Comment bodies given an object of their own this pass.
    pub minted: usize,
    /// Bodies that could not be uploaded. Retried next pass; the comment still reads, it
    /// just cannot be taken custody of yet.
    pub failed: usize,
    /// Objects reclaimed because the comment they held was withdrawn.
    pub reclaimed: usize,
}

/// What object a comment's body was minted as. Keyed by the comment's own rkey and kept in
/// its own collection, so it OUTLIVES the record: a withdrawn comment takes its `bodyURL`
/// with it, and this is then the only thing that knows what to reclaim.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq, Debug)]
struct BodyObject {
    id: String,
}

/// Whether a comment still needs an object minting for its body.
///
/// Only a comment with words and no object yet. A record that already carries one is left
/// alone — minting again would mean a second object for the same bytes and a pin pointed at
/// whichever the last pass happened to write.
fn needs_minting(record: &Endorsement) -> bool {
    record
        .body
        .as_deref()
        .is_some_and(|body| !body.is_empty() && record.body_url.is_none())
}

/// Give each of this identity's comments a Sia object of its own, and reclaim the objects of
/// the ones withdrawn.
///
/// Here rather than where a comment is WRITTEN, and that is the point: the URL sits outside
/// the signature, so attaching it later needs no re-signing — which keeps writing a comment
/// a single local doc write with no session, no flaky leg, and no window where an upload
/// succeeded and the record that names it did not. This runs where the credentials already
/// are, which is where anything needing them belongs.
///
/// Best-effort per comment. A body that will not upload leaves the comment readable and
/// merely un-pinnable, and the next pass tries again.
pub async fn mint_bodies(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    sia: &pin_sia::Session,
) -> MintOutcome {
    let mut outcome = MintOutcome::default();
    let rkeys = crate::list_rkeys(doc, author_id, pin_derive::COMMENT_COLLECTION)
        .await
        .unwrap_or_default();

    for rkey in &rkeys {
        let Ok(Some(raw)) =
            read_record(doc, blobs, author_id, pin_derive::COMMENT_COLLECTION, rkey).await
        else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<Endorsement>(&raw) else {
            continue;
        };
        if !needs_minting(&record) {
            continue;
        }
        let body = record.body.clone().unwrap_or_default();

        // Bytes first, then the record that names them — the ordering every create in this
        // codebase takes. A failure here leaves the comment exactly as it was.
        let Ok(up) = sia.upload_item(body.into_bytes(), None).await else {
            outcome.failed += 1;
            continue;
        };

        let mut minted = record;
        minted.body_url = Some(up.item_url);
        let Ok(bytes) = serde_json::to_vec(&minted) else {
            outcome.failed += 1;
            continue;
        };
        if crate::write_record(doc, author_id, pin_derive::COMMENT_COLLECTION, rkey, bytes)
            .await
            .is_err()
        {
            outcome.failed += 1;
            continue;
        }
        // The mark after the record, so the thing that says what to reclaim is never written
        // for an object nothing points at.
        if let Ok(mark) = serde_json::to_vec(&BodyObject { id: up.id }) {
            let _ = crate::write_record(
                doc,
                author_id,
                pin_derive::COMMENT_OBJECT_COLLECTION,
                rkey,
                mark,
            )
            .await;
        }
        outcome.minted += 1;
    }

    outcome.reclaimed = reclaim_withdrawn(doc, blobs, author_id, sia, &rkeys).await;
    outcome
}

/// Delete the objects of comments that are gone, and forget their marks.
///
/// Positive identification, never deny-by-absence: a mark is acted on only because the
/// comment it names was LOOKED FOR in this identity's own doc and found missing — a local
/// read that cannot fail into looking empty the way a network one can.
async fn reclaim_withdrawn(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    sia: &pin_sia::Session,
    live: &[String],
) -> usize {
    let marks = crate::list_rkeys(doc, author_id, pin_derive::COMMENT_OBJECT_COLLECTION)
        .await
        .unwrap_or_default();
    let live: BTreeSet<&str> = live.iter().map(String::as_str).collect();
    let mut reclaimed = 0;

    for rkey in marks {
        if live.contains(rkey.as_str()) {
            continue;
        }
        let Ok(Some(raw)) = read_record(
            doc,
            blobs,
            author_id,
            pin_derive::COMMENT_OBJECT_COLLECTION,
            &rkey,
        )
        .await
        else {
            continue;
        };
        let Ok(mark) = serde_json::from_slice::<BodyObject>(&raw) else {
            continue;
        };
        // The mark goes only once the object has, or a failed delete would be forgotten and
        // the object left with nothing that knows about it.
        if sia.delete_object(&mark.id).await.is_ok() {
            let _ =
                crate::delete_record(doc, author_id, pin_derive::COMMENT_OBJECT_COLLECTION, &rkey)
                    .await;
            reclaimed += 1;
        }
    }
    reclaimed
}

/// This identity's own comments, read straight out of the doc.
///
/// Never over the network, for the reason the gesture lane gives: the published copy lags
/// what has just been written, and a fold that read it would drop a comment made seconds ago.
pub(crate) async fn own(ctx: &EngagementContext) -> Vec<Endorsement> {
    let rkeys = crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::COMMENT_COLLECTION)
        .await
        .unwrap_or_default();
    let mut out = Vec::new();
    for rkey in rkeys {
        let Ok(Some(raw)) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            pin_derive::COMMENT_COLLECTION,
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

/// Every comment this identity holds, as a subject in its own right.
///
/// A comment is engageable — it can be liked, kept, or replied to — and the host folds that
/// engagement for the same reason they fold a post's: the comment sits on their surface and
/// has no other one. So a record naming a comment has to pass the same "is this ours" gate a
/// record naming a post does, and this is what puts comments behind it.
///
/// Read from the KEYS alone, with no record opened: a held comment's key carries the subject
/// it is about and the comment's own id, and the subject is what says which channel the
/// engagement belongs in. A pass over hundreds of comments costs one listing.
///
/// The channel comes from the POST, which is what makes threading work without a second
/// derivation: a reply names a comment, that comment names a post, and the post names the
/// channel whose doc all of it is published in.
pub(crate) async fn held_as_subjects(
    doc: &Doc,
    author_id: AuthorId,
    posts: &SubjectTable,
) -> Vec<(String, String)> {
    let rkeys = crate::list_rkeys(doc, author_id, pin_derive::COMMENT_LOG_COLLECTION)
        .await
        .unwrap_or_default();
    rkeys
        .iter()
        .filter_map(|rkey| subject_of(rkey, posts))
        .collect()
}

/// The subject one held comment contributes, and the channel it belongs in.
///
/// Where the decisions are, and so where they can be tested: the listing above needs a doc,
/// what it MEANS does not.
///
/// `None` for a comment whose own subject this identity doesn't recognise — somebody else's
/// conversation, held by mistake or left behind by a post that went. Folding engagement on
/// one would publish a count into a channel doc for something this identity doesn't publish.
fn subject_of(rkey: &str, posts: &SubjectTable) -> Option<(String, String)> {
    let (subject, id, _) = pin_derive::parse_comment_log_rkey(rkey)?;
    Some((id.to_string(), posts.get(subject)?.clone()))
}

/// Whether a held key belongs to one subject.
///
/// By PARSING rather than by a prefix match, so a subject that happens to be a prefix of
/// another cannot pull in its records.
fn folds_into(rkey: &str, subject: &str) -> bool {
    matches!(pin_derive::parse_comment_log_rkey(rkey), Some((s, _, _)) if s == subject)
}

/// Every comment this identity holds about one subject.
///
/// A scan of the log, which is keyed subject-first for exactly this. Unreadable entries are
/// skipped rather than failing the read: one bad record must not take a whole conversation
/// with it.
pub(crate) async fn held_for(ctx: &EngagementContext, subject: &str) -> Vec<Endorsement> {
    let rkeys = crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::COMMENT_LOG_COLLECTION)
        .await
        .unwrap_or_default();

    let mut out = Vec::new();
    for rkey in rkeys.iter().filter(|k| folds_into(k, subject)) {
        let Ok(Some(raw)) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            pin_derive::COMMENT_LOG_COLLECTION,
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

/// Whether a held comment should go, and the subject whose conversation then moves.
///
/// Gone only when the actor who wrote it was READ this pass and it was not among what they
/// published. Every other case keeps it: an actor nobody could reach has said nothing, and
/// converting that into a delete is the mistake this codebase has made three times.
pub(crate) fn withdrawal(
    rkey: &str,
    found: &BTreeSet<String>,
    reached: &BTreeSet<String>,
) -> Option<String> {
    if found.contains(rkey) {
        return None;
    }
    let (subject, _, actor) = pin_derive::parse_comment_log_rkey(rkey)?;
    reached.contains(actor).then(|| subject.to_string())
}

/// Bring this identity's held comments up to date: what it wrote, what the graph published,
/// and what was knocked at it.
/// Answers with the subjects whose conversation moved, and the actors whose comments were
/// read — the second because a retention stamp may only claim what was actually confirmed,
/// and being reachable for endorsements says nothing about the separate blob.
pub async fn take_in(
    ctx: &EngagementContext,
    own_did: &str,
    subjects: &SubjectTable,
    knocks: Vec<serde_json::Value>,
    at: &BTreeMap<String, CommentsAt>,
) -> (CommentsOutcome, BTreeSet<String>, BTreeSet<String>) {
    let mut outcome = CommentsOutcome::default();
    let mut touched = BTreeSet::new();
    // Keyed the way the log is, so two records about one address resolve to one write.
    let mut found: BTreeMap<String, Endorsement> = BTreeMap::new();

    // Listed before anything is written, so the reconcile below sees the log as it stood.
    let held = crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::COMMENT_LOG_COLLECTION)
        .await
        .unwrap_or_default();

    // Ourselves first and locally: a comment on your own post is one you wrote, and reading
    // it back over the network would miss the one made a second ago.
    let (crawled, mut reached) = crawl(ctx, at, &mut outcome).await;
    reached.insert(own_did.to_string());

    for record in own(ctx).await.into_iter().chain(crawled) {
        // Verified even when it came from our own doc: a record that fails here is one no
        // count may rest on, whatever route it arrived by.
        if record.verify().is_err() {
            outcome.rejected += 1;
            continue;
        }
        if !subjects.contains_key(&record.subject) {
            // Their blob holds every comment they wrote, most of it on other people's posts.
            outcome.not_ours += 1;
            continue;
        }
        found.insert(log_key(&record), record);
    }

    // Then the knocks. After the crawl, so a record read from its actor's own blob this pass
    // already sits in `found` and takes precedence over an assertion pushed at us.
    for value in knocks {
        match classify_knock(value) {
            Some(Knocked::Endorse(record)) => {
                let key = log_key(&record);
                let held = held_created_at(ctx, &key).await;
                match knock_verdict(&record, subjects, found.contains_key(&key), held.as_deref()) {
                    KnockVerdict::Accept => {
                        found.insert(key, record);
                        outcome.taken += 1;
                    }
                    KnockVerdict::Rejected => outcome.rejected += 1,
                    KnockVerdict::NotOurs => outcome.not_ours += 1,
                    KnockVerdict::Stale => outcome.stale += 1,
                }
            }
            Some(Knocked::Retract(record)) => {
                let Some(key) = retraction_key(&record) else {
                    outcome.retractions_rejected += 1;
                    continue;
                };
                let held = pending_or_held(&found, &key, held_created_at(ctx, &key).await);
                match retraction_verdict(&record, subjects, false, held.as_deref()) {
                    RetractionVerdict::Accept => {
                        // Dropped from this pass's writes first, or the record would be
                        // deleted and then put straight back. Either half counts: a comment
                        // withdrawn before it was ever written leaves nothing in the doc to
                        // delete, and that is a withdrawal honoured rather than one lost.
                        let pending = found.remove(&key).is_some();
                        let deleted = crate::delete_record(
                            &ctx.doc,
                            ctx.author_id,
                            pin_derive::COMMENT_LOG_COLLECTION,
                            &key,
                        )
                        .await
                        .is_ok();
                        if pending || deleted {
                            touched.insert(record.subject.clone());
                            outcome.retracted += 1;
                        } else {
                            outcome.retractions_ignored += 1;
                        }
                    }
                    RetractionVerdict::Rejected => outcome.retractions_rejected += 1,
                    RetractionVerdict::NotOurs => outcome.retractions_not_ours += 1,
                    RetractionVerdict::Nothing | RetractionVerdict::Stale => {
                        outcome.retractions_ignored += 1
                    }
                }
            }
            None => outcome.rejected += 1,
        }
    }

    // Reconcile: a held comment whose actor published a blob this pass and did not include
    // it has been taken down at source.
    let found_keys: BTreeSet<String> = found.keys().cloned().collect();
    for rkey in &held {
        let Some(subject) = withdrawal(rkey, &found_keys, &reached) else {
            continue;
        };
        if crate::delete_record(
            &ctx.doc,
            ctx.author_id,
            pin_derive::COMMENT_LOG_COLLECTION,
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
        let Ok(bytes) = serde_json::to_vec(record) else {
            outcome.rejected += 1;
            continue;
        };
        // Compared before writing, like the gesture log: every write here is announced to
        // every instance syncing this doc, and a pass that found what it already held must
        // not wake them all.
        let unchanged = matches!(
            read_record(
                &ctx.doc,
                &ctx.blobs,
                ctx.author_id,
                pin_derive::COMMENT_LOG_COLLECTION,
                rkey,
            )
            .await,
            Ok(Some(held)) if held == bytes
        );
        if unchanged {
            continue;
        }
        // Touched where the write happens rather than where the record was accepted: a pass
        // that found what it already held has moved no conversation, and re-folding it would
        // rewrite a published entry for nothing.
        touched.insert(record.subject.clone());
        let _ = crate::write_record(
            &ctx.doc,
            ctx.author_id,
            pin_derive::COMMENT_LOG_COLLECTION,
            rkey,
            bytes,
        )
        .await;
    }

    (outcome, touched, reached)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; 32] = [5u8; 32];
    const SUBJECT: &str = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
    const WHEN: &str = "2026-08-22T12:00:00.000Z";

    fn comment(when: &str, body: &str) -> Endorsement {
        Endorsement::sign_comment(&SEED, SUBJECT, "bafkreiabc", when, None, body).unwrap()
    }

    fn keys(of: &[&Endorsement]) -> BTreeSet<String> {
        of.iter().map(|r| log_key(r)).collect()
    }

    fn actors(of: &[&str]) -> BTreeSet<String> {
        of.iter().map(|a| a.to_string()).collect()
    }

    fn posts_table(pairs: &[(&str, &str)]) -> SubjectTable {
        pairs
            .iter()
            .map(|(s, c)| (s.to_string(), c.to_string()))
            .collect()
    }

    #[test]
    fn a_held_comment_becomes_a_subject_in_its_posts_channel() {
        // What makes a comment engageable: liking one has to pass the same "is this ours"
        // gate liking a post does, and the channel comes from the POST — which is also what
        // makes a reply work, since it names a comment that names a post.
        let c = comment(WHEN, "said so");
        let posts = posts_table(&[(SUBJECT, "chan-one")]);
        assert_eq!(
            subject_of(&log_key(&c), &posts),
            Some((c.comment_id(), "chan-one".to_string()))
        );
    }

    #[test]
    fn a_comment_on_somebody_elses_post_is_not_our_subject() {
        // Held by mistake, or left behind by a post that went. Either way engagement on it
        // is not ours to fold, and folding it would publish a count into a channel doc for
        // something this identity does not publish.
        let c = comment(WHEN, "elsewhere");
        assert_eq!(subject_of(&log_key(&c), &posts_table(&[])), None);
        assert_eq!(
            subject_of(&log_key(&c), &posts_table(&[("another", "chan-one")])),
            None
        );
    }

    #[test]
    fn a_key_that_does_not_parse_is_no_subject() {
        assert_eq!(
            subject_of("nonsense", &posts_table(&[(SUBJECT, "chan-one")])),
            None
        );
    }

    #[test]
    fn a_held_key_folds_into_its_own_subject_only() {
        // By parsing, not by prefix: a subject that is a prefix of another would otherwise
        // pull that one's comments into its conversation and its count.
        let c = comment(WHEN, "words");
        let rkey = log_key(&c);
        assert!(folds_into(&rkey, SUBJECT));
        assert!(!folds_into(&rkey, &SUBJECT[..20]));
        assert!(!folds_into(&rkey, "another"));
        assert!(!folds_into("nonsense", SUBJECT));
    }

    #[test]
    fn a_comment_missing_from_a_blob_that_was_read_is_withdrawn() {
        let c = comment(WHEN, "taken down");
        let rkey = log_key(&c);
        assert_eq!(
            withdrawal(&rkey, &BTreeSet::new(), &actors(&[&c.actor])),
            Some(SUBJECT.to_string())
        );
    }

    #[test]
    fn a_comment_still_in_the_blob_stays() {
        let c = comment(WHEN, "still there");
        let rkey = log_key(&c);
        assert_eq!(withdrawal(&rkey, &keys(&[&c]), &actors(&[&c.actor])), None);
    }

    #[test]
    fn a_comment_whose_author_was_not_read_stays() {
        // The one that matters. An actor nobody could reach has said nothing, and turning
        // that into a delete is the mistake this codebase has made three times — so absence
        // only counts against a blob that was actually read.
        let c = comment(WHEN, "unconfirmed");
        let rkey = log_key(&c);
        assert_eq!(withdrawal(&rkey, &BTreeSet::new(), &BTreeSet::new()), None);
        assert_eq!(
            withdrawal(&rkey, &BTreeSet::new(), &actors(&["did:dht:somebody-else"])),
            None
        );
    }

    #[test]
    fn a_key_that_does_not_parse_withdraws_nothing() {
        // What reads this decides what to delete, so a key it cannot read has to be left
        // alone rather than guessed at.
        assert_eq!(
            withdrawal("nonsense", &BTreeSet::new(), &actors(&["did:x"])),
            None
        );
    }

    #[test]
    fn a_directory_naming_no_blob_says_there_are_none() {
        // Read, and the answer is none — which withdraws everything held from them. The
        // alternative reading, that nothing is known, would leave a deleted comment standing
        // forever; and confusing it the other way would delete on a read that never happened.
        assert_eq!(
            comments_at(&serde_json::json!({"version": 4})),
            CommentsAt::Absent
        );
        assert_eq!(
            comments_at(&serde_json::json!({"commentsURL": "sia://blob#encryption_key=k"})),
            CommentsAt::Url("sia://blob#encryption_key=k".into())
        );
        // A pointer of the wrong shape is not a pointer.
        assert_eq!(
            comments_at(&serde_json::json!({"commentsURL": 7})),
            CommentsAt::Absent
        );
    }

    #[test]
    fn an_unmoved_pointer_answers_without_a_download() {
        // The steady state, and the whole reason the mark holds a URL: Sia is content
        // addressed, so an unchanged pointer proves the bytes are identical.
        let mark = CommentMark {
            url: "sia://blob#encryption_key=k".into(),
            epoch: COMMENT_EPOCH,
        };
        assert!(may_skip(Some(&mark), &mark));
    }

    #[test]
    fn a_pointer_that_moved_or_a_parse_that_changed_forces_a_download() {
        let held = CommentMark {
            url: "sia://old#encryption_key=k".into(),
            epoch: COMMENT_EPOCH,
        };
        let moved = CommentMark {
            url: "sia://new#encryption_key=k".into(),
            epoch: COMMENT_EPOCH,
        };
        assert!(!may_skip(Some(&held), &moved));

        // An unchanged pointer proves the bytes are identical; it says nothing about whether
        // this reading of them is current, so an epoch bump has to re-read everybody.
        let newer_parse = CommentMark {
            epoch: COMMENT_EPOCH + 1,
            ..held.clone()
        };
        assert!(!may_skip(Some(&held), &newer_parse));
        assert!(!may_skip(None, &newer_parse));
    }

    #[test]
    fn an_unmoved_directory_counts_as_a_read_only_once_there_has_been_one() {
        // A directory that has not moved means the blob it points at has not either, so a
        // completed read plus an unmoved directory is as good as a fresh one.
        assert!(unchanged_counts_as_read(Some(&CommentMark {
            url: "sia://blob".into(),
            epoch: COMMENT_EPOCH,
        })));

        // With nothing ever read there is nothing to stand on, and calling this reached
        // would withdraw on the strength of a download that never happened.
        assert!(!unchanged_counts_as_read(None));
        assert!(!unchanged_counts_as_read(Some(&CommentMark {
            url: "sia://blob".into(),
            epoch: COMMENT_EPOCH + 1,
        })));
    }

    #[test]
    fn only_a_comment_with_words_and_no_object_needs_one() {
        let plain = comment(WHEN, "said so");
        assert!(needs_minting(&plain));

        // Already minted. Minting again would mean a second object for the same bytes and a
        // pin pointed at whichever the last pass happened to write.
        let mut minted = plain.clone();
        minted.body_url = Some("sia://body#encryption_key=k".into());
        assert!(!needs_minting(&minted));

        // Nothing to mint. A gesture has no payload, which is the whole reason custody is
        // for content and not for signals.
        let like =
            Endorsement::sign(&SEED, pin_engagement::KIND_LIKE, SUBJECT, "v", WHEN, None).unwrap();
        assert!(!needs_minting(&like));
    }

    #[test]
    fn a_knocked_comment_sorts_into_this_lane() {
        let record = serde_json::to_value(comment(WHEN, "hello")).unwrap();
        assert!(is_comment(&record));

        // And so does the withdrawal of one, or the retraction would be handed to the lane
        // that cannot find what it names.
        let withdrawal = serde_json::to_value(
            Retraction::sign_comment_withdrawal(&SEED, SUBJECT, WHEN, "an-id").unwrap(),
        )
        .unwrap();
        assert!(is_comment(&withdrawal));
    }

    #[test]
    fn a_gesture_does_not() {
        let like =
            Endorsement::sign(&SEED, pin_engagement::KIND_LIKE, SUBJECT, "v", WHEN, None).unwrap();
        assert!(!is_comment(&serde_json::to_value(like).unwrap()));
        let taken_back = Retraction::sign(&SEED, pin_engagement::KIND_LIKE, SUBJECT, WHEN).unwrap();
        assert!(!is_comment(&serde_json::to_value(taken_back).unwrap()));
    }

    #[test]
    fn two_comments_from_one_actor_hold_two_addresses() {
        // The singleton the gesture log relies on, which this lane exists because a comment
        // breaks. Sharing that log would make the second of these replace the first.
        let first = comment(WHEN, "first");
        let second = comment("2026-08-22T13:00:00.000Z", "second");
        assert_ne!(log_key(&first), log_key(&second));
        assert!(log_key(&first).starts_with(SUBJECT));
    }

    #[test]
    fn the_same_comment_holds_one_address_however_it_arrives() {
        // What makes a redelivered knock idempotent: the id is derived from the record, so a
        // duplicate lands on the address it already occupies and the recency check stops it.
        let once = comment(WHEN, "words");
        let again = comment(WHEN, "words");
        assert_eq!(log_key(&once), log_key(&again));
    }

    #[test]
    fn a_comment_accepted_this_pass_can_still_be_withdrawn_in_it() {
        // Both arriving in one delivery is ordinary: a sender that knocked a comment and then
        // took it back before the next pass has both queued. Comparing only against what is
        // WRITTEN would find nothing, ignore the withdrawal, and then write the comment.
        let c = comment(WHEN, "regretted");
        let key = log_key(&c);
        let mut found = BTreeMap::new();
        found.insert(key.clone(), c.clone());
        assert_eq!(
            pending_or_held(&found, &key, None),
            Some(c.created_at.clone())
        );

        // And what is written still counts when this pass accepted nothing.
        assert_eq!(
            pending_or_held(&BTreeMap::new(), &key, Some("earlier".into())),
            Some("earlier".into())
        );
        assert_eq!(pending_or_held(&BTreeMap::new(), &key, None), None);
    }

    #[test]
    fn a_withdrawal_naming_nothing_is_refused() {
        // A subject alone cannot say which comment is meant, and guessing would delete
        // somebody's other one.
        let untargeted =
            Retraction::sign(&SEED, pin_engagement::KIND_COMMENT, SUBJECT, WHEN).unwrap();
        assert_eq!(retraction_key(&untargeted), None);

        let named = Retraction::sign_comment_withdrawal(&SEED, SUBJECT, WHEN, "an-id").unwrap();
        assert_eq!(
            retraction_key(&named),
            Some(pin_derive::comment_log_rkey(SUBJECT, "an-id", &named.actor))
        );
    }

    #[test]
    fn a_withdrawal_addresses_the_comment_it_names() {
        // The round trip that has to hold for a withdrawal to reach anything: the address the
        // author filed the comment under, rebuilt from a message that carries only the
        // subject and the id.
        let c = comment(WHEN, "regretted");
        let r = Retraction::sign_comment_withdrawal(
            &SEED,
            SUBJECT,
            "2026-08-22T14:00:00.000Z",
            &c.comment_id(),
        )
        .unwrap();
        assert_eq!(retraction_key(&r), Some(log_key(&c)));
    }
}
