//! Who follows a private channel, as its members are shown it — and the checks a member's
//! own machine makes before believing it.
//!
//! On a private channel following is membership, and the author publishes the whole set of
//! signed follow records in the channel's tallies, under the content key, for its members to
//! see each other. The same object carries the count a non-member sees, in its head. So a
//! member holding one object can check three things with no further reads:
//!
//! - every name on the list is backed by that person's own signature, so nobody was
//!   invented;
//! - the list rebuilds the root and the count the author committed to, and the count in the
//!   head agrees with it, so outsiders are not told a different number — and since head and
//!   body sit in one object the author signed, a disagreement is the author's own;
//! - the member is on it, when they follow it, so nobody is dropped without noticing.
//!
//! A check that fails is reported rather than acted on: the page flags the count, and what a
//! member does about an author who lied to them is theirs to decide.

use pin_engagement::{Aggregate, KIND_FOLLOW};
use serde::Serialize;

/// What a member is shown of who follows a private channel, and what did not check out.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
pub struct FollowerAudit {
    /// The count the author published for the channel.
    pub count: usize,
    /// Who follows it, by did, as the published set names them.
    pub followers: Vec<String>,
    /// What failed, as short codes: `unsigned` (a record whose signature does not hold, or
    /// that is not a follow of this channel), `set` (the records do not rebuild the
    /// published root and count), `head` (the count non-members are shown is not this one),
    /// `you` (the viewer follows the channel and is not on the list), `no-list` (a count
    /// with no set beside it).
    pub problems: Vec<&'static str>,
}

/// Check a private channel's published follower set against what it claims.
///
/// `tallies_json` is the opened tallies object, subject to tally; `head` is the count in
/// that same object's head; `viewer` is this identity's did when it follows the channel, so
/// it expects to be listed.
pub fn check_followers(
    channel_id: &str,
    head: Option<u64>,
    tallies_json: &str,
    viewer: Option<&str>,
) -> Result<FollowerAudit, String> {
    let map: std::collections::BTreeMap<String, Aggregate> =
        serde_json::from_str(tallies_json).map_err(|e| format!("tallies: {e}"))?;
    let tally = map.get(channel_id).and_then(|a| a.kinds.get(KIND_FOLLOW));
    let count = tally.map_or(0, |t| t.count);
    let mut audit = FollowerAudit {
        count,
        ..Default::default()
    };

    if head.is_some_and(|h| h != count as u64) {
        audit.problems.push("head");
    }
    let Some(tally) = tally else {
        return Ok(audit);
    };
    let Some(records) = &tally.records else {
        if count > 0 {
            audit.problems.push("no-list");
        }
        return Ok(audit);
    };

    let genuine = records
        .iter()
        .all(|r| r.kind == KIND_FOLLOW && r.subject == channel_id && r.verify().is_ok());
    if !genuine {
        audit.problems.push("unsigned");
    }
    // In the order published, which is the order the root was built over: a list reordered
    // after the fact is a list the author did not commit to.
    let leaves: Result<Vec<[u8; 32]>, String> = records.iter().map(|r| r.leaf()).collect();
    let rebuilt = leaves.map(|l| pin_engagement::hex(&pin_engagement::merkle_root(&l)));
    if records.len() != count || rebuilt.as_deref() != Ok(tally.set_root.as_str()) {
        audit.problems.push("set");
    }

    let mut followers: Vec<String> = records.iter().map(|r| r.actor.clone()).collect();
    followers.sort();
    followers.dedup();
    if viewer.is_some_and(|v| !followers.iter().any(|f| f == v)) {
        audit.problems.push("you");
    }
    audit.followers = followers;
    Ok(audit)
}

/// Read a private channel's follower set from its published tallies and check it, opening
/// the body with what this identity holds. `None` when no tallies are published.
pub async fn audit_followers(
    sia: &pin_sia::Session,
    holdings: &crate::Holdings<'_>,
    channel_key: &[u8; 32],
    author: &str,
    viewer: Option<&str>,
) -> Result<Option<FollowerAudit>, String> {
    let Some(item_url) = pin_channel::resolve_tallies_url(channel_key).await? else {
        return Ok(None);
    };
    let (json, blob, _) = crate::fetch_channel_object(
        sia,
        holdings,
        channel_key,
        &item_url,
        pin_channel::Kind::Tallies,
        author,
    )
    .await?;
    let head =
        pin_channel::open_follower_count(channel_key, &blob, pin_channel::Signer::Author(author))?;
    check_followers(&pin_crypto::channel_id(channel_key), head, &json, viewer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pin_engagement::Endorsement;

    const CHANNEL: &str = "chan";
    const AUTHOR: &str = "did:dht:author";

    fn follow(seed: u8) -> Endorsement {
        Endorsement::sign_channel_follow(&[seed; 32], AUTHOR, CHANNEL, "2026-10-05T00:00:00Z")
            .unwrap()
    }

    /// The tallies a private channel's author publishes: the follows folded, and the set
    /// beside them.
    fn published(records: &[Endorsement]) -> serde_json::Value {
        let mut aggregate = pin_engagement::fold(records, None, "now".into()).unwrap();
        pin_engagement::publish_set(&mut aggregate, KIND_FOLLOW, records);
        serde_json::json!({ CHANNEL: aggregate })
    }

    fn check(
        tallies: &serde_json::Value,
        head: Option<u64>,
        viewer: Option<&str>,
    ) -> FollowerAudit {
        check_followers(CHANNEL, head, &tallies.to_string(), viewer).unwrap()
    }

    #[test]
    fn an_honest_set_lists_its_followers_and_raises_nothing() {
        let records = [follow(1), follow(2)];
        let me = records[0].actor.clone();
        let audit = check(&published(&records), Some(2), Some(&me));
        assert_eq!(audit.count, 2);
        assert_eq!(audit.followers.len(), 2);
        assert!(audit.followers.contains(&me));
        assert!(audit.problems.is_empty(), "{:?}", audit.problems);
    }

    #[test]
    fn a_head_that_tells_outsiders_another_number_is_flagged() {
        let audit = check(&published(&[follow(1)]), Some(40), None);
        assert_eq!(audit.problems, ["head"]);
    }

    #[test]
    fn an_invented_follower_is_flagged() {
        let mut tallies = published(&[follow(1), follow(2)]);
        // A name swapped in after signing: the record no longer verifies.
        tallies[CHANNEL]["kinds"]["follow"]["records"][1]["actor"] =
            serde_json::json!("did:dht:nobody");
        let audit = check(&tallies, None, None);
        assert!(audit.problems.contains(&"unsigned"), "{:?}", audit.problems);
    }

    #[test]
    fn a_list_that_does_not_rebuild_the_committed_set_is_flagged() {
        // A genuine record dropped from the list while the count and root still claim it.
        let mut tallies = published(&[follow(1), follow(2)]);
        tallies[CHANNEL]["kinds"]["follow"]["records"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert!(check(&tallies, None, None).problems.contains(&"set"));
    }

    #[test]
    fn a_follower_left_off_the_list_notices() {
        let me = follow(3).actor;
        let audit = check(&published(&[follow(1), follow(2)]), Some(2), Some(&me));
        assert_eq!(audit.problems, ["you"]);
    }

    #[test]
    fn a_count_with_no_set_beside_it_is_flagged() {
        let mut tallies = published(&[follow(1)]);
        tallies[CHANNEL]["kinds"]["follow"]
            .as_object_mut()
            .unwrap()
            .remove("records");
        assert_eq!(check(&tallies, Some(1), None).problems, ["no-list"]);
    }

    #[test]
    fn nobody_following_is_a_zero_and_nothing_to_flag() {
        let audit = check(&serde_json::json!({}), Some(0), None);
        assert_eq!(audit, FollowerAudit::default());
    }
}
