//! Which channels this identity reads.
//!
//! Two relations put a channel in front of somebody, and each is one to one with the thing
//! it names. A WATCH is one channel, by K, however it was obtained — a link, or a follow of
//! that channel. A FOLLOW OF A PERSON is their profile feed: the channels they advertise and
//! have not taken off their profile, which is the author deciding what the people following
//! them receive. Nothing is copied into the subscription list for the second, so a channel
//! the author adds reaches their followers on the crawl's next reading of them, and
//! unfollowing leaves nothing behind to sweep.
//!
//! One function, compiled for both targets and exported to the frontend, because the pull
//! loop, the channel-doc sync and the feed all have to agree on this set, and a second
//! spelling of it is how they would come to disagree.
//!
//! A followed person this device cannot answer for — never read, or faded past their
//! channels — is UNSETTLED rather than empty. They contribute nothing, and a caller that
//! deletes by absence must not act on a set that has them in it: their channels are missing
//! because nobody has looked, not because they are gone.

use std::collections::{BTreeMap, HashSet};

use crate::discover::{DirectoryRecord, DirectoryTier};
use crate::SettingsView;

/// One channel this identity reads.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ReadChannel {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "channelKey")]
    pub channel_key: String,
    /// Whose it is. Absent on a watch made from a legacy link that named nobody.
    #[serde(rename = "didDht", skip_serializing_if = "Option::is_none")]
    pub did_dht: Option<String>,
    /// Set when the channel is here because its author is followed, rather than watched.
    /// Carries the name their directory gives it, for a row to show before the manifest
    /// is read.
    #[serde(rename = "followedName", skip_serializing_if = "Option::is_none")]
    pub followed_name: Option<String>,
}

/// The channels this identity reads, and whose feeds it could not work out.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Reading {
    pub channels: Vec<ReadChannel>,
    /// Followed people with no full record held. Their channels are absent from `channels`
    /// for want of a reading, so nothing may be deleted on the strength of that absence.
    pub unsettled: Vec<String>,
}

impl Reading {
    /// Whether the set is complete enough to delete by. See the module doc.
    pub fn settled(&self) -> bool {
        self.unsettled.is_empty()
    }
}

/// Watches first, then each followed person's profile feed, one entry per channel.
///
/// A channel both watched and shown by a followed author appears once, as the watch: the
/// watch holds the key this identity was actually given, and a later unfollow should not
/// take away a channel somebody chose on its own.
///
/// `held` is the crawl's record for each followed person, where one is held.
pub(crate) fn reading(
    settings: &SettingsView,
    held: &BTreeMap<String, DirectoryRecord>,
) -> Reading {
    let mut out = Reading::default();
    let mut seen: HashSet<String> = HashSet::new();

    for sub in &settings.subscriptions {
        if seen.insert(sub.channel_id.clone()) {
            out.channels.push(ReadChannel {
                channel_id: sub.channel_id.clone(),
                channel_key: sub.channel_key.clone(),
                did_dht: sub.did_dht.clone(),
                followed_name: None,
            });
        }
    }

    for did in &settings.handle_follows {
        // Only a full record carries channels. A reduced or minimal one has faded them, and
        // absence there is the fade rather than the author's choice.
        let record = match held.get(did) {
            Some(r) if r.tier == DirectoryTier::Full => r,
            _ => {
                out.unsettled.push(did.clone());
                continue;
            }
        };
        for c in &record.channels {
            if c.show_on_profile == Some(false) || !seen.insert(c.channel_id.clone()) {
                continue;
            }
            out.channels.push(ReadChannel {
                channel_id: c.channel_id.clone(),
                channel_key: c.key.clone(),
                did_dht: Some(did.clone()),
                followed_name: Some(c.name.clone()),
            });
        }
    }
    out
}

/// [`reading`] over the crawl's held records, read out of the doc.
///
/// A record that will not read counts as not held, which lands its person in `unsettled`
/// — the direction that deletes nothing.
pub(crate) async fn read_now(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author_id: iroh_docs::AuthorId,
    settings: &SettingsView,
) -> Reading {
    let mut held = BTreeMap::new();
    for did in &settings.handle_follows {
        if let Some(r) = crate::discover::read_directory(doc, blobs, author_id, did).await {
            held.insert(did.clone(), r);
        }
    }
    reading(settings, &held)
}

/// [`reading`] across a JSON boundary: the frontend's settings shape in, the set out.
///
/// `held_json` is `{did: DirectoryRecord}` for whichever followed people the caller holds a
/// record for; anyone missing from it is unsettled.
pub fn reading_json(settings_json: &str, held_json: &str) -> Result<String, String> {
    let settings: SettingsView =
        serde_json::from_str(settings_json).map_err(|e| format!("settings: {e}"))?;
    let held: BTreeMap<String, DirectoryRecord> =
        serde_json::from_str(held_json).map_err(|e| format!("held: {e}"))?;
    serde_json::to_string(&reading(&settings, &held)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(json: &str) -> SettingsView {
        serde_json::from_str(json).expect("settings")
    }

    fn record(tier: &str, channels: &str) -> DirectoryRecord {
        serde_json::from_str(&format!(r#"{{"tier":"{tier}","channels":{channels}}}"#))
            .expect("record")
    }

    fn ids(r: &Reading) -> Vec<&str> {
        r.channels.iter().map(|c| c.channel_id.as_str()).collect()
    }

    const ALICE: &str = "did:dht:alice";

    #[test]
    fn a_followed_person_contributes_what_their_profile_shows() {
        let s = settings(&format!(
            r#"{{"subscriptions":[{{"channelID":"w","channelKey":"kw"}}],"handleFollows":["{ALICE}"]}}"#
        ));
        let held = BTreeMap::from([(
            ALICE.to_string(),
            record(
                "full",
                r#"[{"channelID":"a1","key":"k1","name":"One"},
                    {"channelID":"a2","key":"k2","name":"Off","showOnProfile":false},
                    {"channelID":"a3","key":"k3","name":"Three","showOnProfile":true}]"#,
            ),
        )]);
        let r = reading(&s, &held);
        assert_eq!(ids(&r), vec!["w", "a1", "a3"]);
        assert!(r.settled());
        assert_eq!(r.channels[1].did_dht.as_deref(), Some(ALICE));
        assert_eq!(r.channels[1].followed_name.as_deref(), Some("One"));
        assert_eq!(r.channels[0].followed_name, None);
    }

    #[test]
    fn a_watched_channel_stays_a_watch_when_its_author_is_followed_too() {
        // One entry, and the watch's: an unfollow must not take away a channel somebody
        // chose on its own, and the watch holds the key they were actually given.
        let s = settings(&format!(
            r#"{{"subscriptions":[{{"channelID":"a1","channelKey":"mine"}}],"handleFollows":["{ALICE}"]}}"#
        ));
        let held = BTreeMap::from([(
            ALICE.to_string(),
            record(
                "full",
                r#"[{"channelID":"a1","key":"theirs","name":"One"}]"#,
            ),
        )]);
        let r = reading(&s, &held);
        assert_eq!(ids(&r), vec!["a1"]);
        assert_eq!(r.channels[0].channel_key, "mine");
        assert_eq!(r.channels[0].followed_name, None);
    }

    #[test]
    fn a_followed_person_never_read_is_unsettled_rather_than_empty() {
        let s = settings(&format!(r#"{{"handleFollows":["{ALICE}"]}}"#));
        let r = reading(&s, &BTreeMap::new());
        assert!(r.channels.is_empty());
        assert_eq!(r.unsettled, vec![ALICE.to_string()]);
        assert!(!r.settled());
    }

    #[test]
    fn a_faded_record_is_unsettled_rather_than_empty() {
        // A reduced record has lost its channels to the fade. Reading that as the author
        // publishing nothing would drop their whole feed from the cache.
        let s = settings(&format!(r#"{{"handleFollows":["{ALICE}"]}}"#));
        for tier in ["reduced", "minimal"] {
            let held = BTreeMap::from([(ALICE.to_string(), record(tier, "[]"))]);
            assert_eq!(
                reading(&s, &held).unsettled,
                vec![ALICE.to_string()],
                "{tier}"
            );
        }
    }

    #[test]
    fn a_full_record_with_no_channels_is_settled() {
        // Somebody who publishes nothing is an answer, and it is the one a person who
        // unadvertised every channel produces.
        let s = settings(&format!(r#"{{"handleFollows":["{ALICE}"]}}"#));
        let held = BTreeMap::from([(ALICE.to_string(), record("full", "[]"))]);
        let r = reading(&s, &held);
        assert!(r.channels.is_empty());
        assert!(r.settled());
    }

    #[test]
    fn the_json_form_carries_the_field_names_the_frontend_reads() {
        let out = reading_json(
            &format!(
                r#"{{"subscriptions":[{{"channelID":"w","channelKey":"kw","didDht":"did:dht:w"}}],"handleFollows":["{ALICE}","did:dht:bob"]}}"#
            ),
            &format!(
                r#"{{"{ALICE}":{{"tier":"full","channels":[{{"channelID":"a1","key":"k1","name":"One"}}]}}}}"#
            ),
        )
        .expect("reading");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let keys = |i: usize| {
            let mut k: Vec<String> = v["channels"][i]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            k.sort();
            k
        };
        assert_eq!(keys(0), vec!["channelID", "channelKey", "didDht"]);
        assert_eq!(
            keys(1),
            vec!["channelID", "channelKey", "didDht", "followedName"]
        );
        assert_eq!(v["unsettled"], serde_json::json!(["did:dht:bob"]));
    }
}
