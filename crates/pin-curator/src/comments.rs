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
//! One drain, two lanes. `pin-rpc` never parses a record, so the inbox carries both and
//! `engagement` splits them by the one field that says which — anything else would need two
//! drains over one inbox, and whichever ran second would find the other's knocks gone.

use std::collections::{BTreeMap, BTreeSet};

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
}

/// Whether a knocked payload belongs to this lane.
///
/// By the `kind` field, which both an endorsement and a withdrawal carry — so a comment and
/// the withdrawal of a comment sort together, which is what a lane has to mean for the
/// retraction to find the record it names.
pub(crate) fn is_comment(record: &serde_json::Value) -> bool {
    record.get("kind").and_then(|v| v.as_str()) == Some(pin_engagement::KIND_COMMENT)
}

/// Where one comment belongs in the log: the subject it is about, then its own id.
///
/// Derived from the record, so everything that has to agree on the address — the write, the
/// lookup a knock is compared against, the withdrawal that names it — asks the same question
/// of the same thing. The gesture lane learned that the hard way.
pub(crate) fn log_key(record: &Endorsement) -> String {
    pin_derive::comment_rkey(&record.subject, &record.comment_id())
}

/// The address a withdrawal names, or `None` when it names nothing.
///
/// A comment withdrawal has to carry a target: the subject alone cannot say which of an
/// actor's comments is meant. One without it is refused rather than guessed at, since the
/// guess would delete somebody's other comment.
fn retraction_key(record: &Retraction) -> Option<String> {
    Some(pin_derive::comment_rkey(
        &record.subject,
        record.target.as_deref()?,
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

/// Take the comments knocked at this identity into the log.
///
/// Knocks only. The crawl is the other route and the floor under this one — for anybody in
/// the graph, a comment lost here turns up on the next pass over their published blob. For
/// anybody outside it there is no second route, which is what the knock exists for.
pub async fn take_knocks(
    ctx: &EngagementContext,
    subjects: &SubjectTable,
    knocks: Vec<serde_json::Value>,
) -> (CommentsOutcome, BTreeSet<String>) {
    let mut outcome = CommentsOutcome::default();
    let mut touched = BTreeSet::new();
    // Keyed the way the log is, so two knocks about one address resolve to one write.
    let mut found: BTreeMap<String, Endorsement> = BTreeMap::new();

    for value in knocks {
        match classify_knock(value) {
            Some(Knocked::Endorse(record)) => {
                let key = log_key(&record);
                let held = held_created_at(ctx, &key).await;
                match knock_verdict(&record, subjects, found.contains_key(&key), held.as_deref()) {
                    KnockVerdict::Accept => {
                        touched.insert(record.subject.clone());
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
        let _ = crate::write_record(
            &ctx.doc,
            ctx.author_id,
            pin_derive::COMMENT_LOG_COLLECTION,
            rkey,
            bytes,
        )
        .await;
    }

    (outcome, touched)
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
            Some(pin_derive::comment_rkey(SUBJECT, "an-id"))
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
