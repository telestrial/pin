//! What this identity knows about other identities — the crawl's record of the network.
//!
//! A profile is a server: a `did:dht` with published endpoints, a directory blob naming
//! the channels it advertises, and follows pointing at further servers. So what is
//! recorded here is servers pointing at servers, and walking it is how anything reaches
//! this identity that it did not already ask for.
//!
//! **Nothing here fetches.** Every field comes out of a read some other loop was already
//! making: the engagement crawl resolves an actor's key to find `_dir` and downloads the
//! blob behind it, and at that moment the whole TXT record set (including `_iroh`) and the
//! whole blob are in hand. Before this module they were parsed for endorsements and
//! dropped. The loop that goes and reads someone NEW is a separate thing, and it is the
//! only part of discovery that spends anything.
//!
//! The frontier — identities known to exist because a held directory follows them, but
//! never read — is derived from these records, never stored. `list_rkeys` scans the whole
//! doc and filters by prefix, so entry count is the cost that matters, and materializing
//! the frontier would multiply it by the graph's fan-out while holding nothing a held
//! record does not already carry.

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};

use crate::InstanceAddr;

/// Bumped when what we EXTRACT from a directory changes — a new field, a schema move, a
/// fix to the parse.
///
/// The same discriminator `CRAWL_EPOCH` carries, for the same reason: a held record says
/// what an older reading of those bytes produced, and nothing about the bytes reveals that
/// our reading of them has moved on. Without it, widening the parse would leave every
/// already-crawled identity holding the narrower record forever.
pub(crate) const DISCOVER_EPOCH: u32 = 1;

/// One channel an identity advertises, as its directory publishes it.
///
/// Carries `key` — a public channel advertises its K, which is what makes the channel
/// readable to whoever holds this record. An unlisted channel is absent from the directory
/// by construction, so nothing here can enumerate one.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DirectoryChannel {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub key: String,
    #[serde(default)]
    pub name: String,
}

/// Everything one read of another identity's directory yields.
///
/// `profile` and `follows` are opaque `Value`s for the reason the identity publisher keeps
/// them opaque on the way out: the Curator carries a profile, it does not own its shape.
/// A field this crate has never heard of survives a round trip instead of being dropped on
/// the floor by a stricter type.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DirectoryRecord {
    /// Their self-asserted profile: username, display name, bio, avatar and cover URLs.
    /// `None` is a real answer — a directory with no profile in it — not a failed read.
    #[serde(default)]
    pub profile: Option<serde_json::Value>,
    /// The public channels they advertise, each with its K.
    #[serde(default)]
    pub channels: Vec<DirectoryChannel>,
    /// Where they can be dialed, from `_iroh` in the same packet that named their
    /// directory. The volatile half of this record: a relay moves or a device appears and
    /// this changes while nothing else does.
    #[serde(default)]
    pub reach: Vec<InstanceAddr>,
    /// Their public channel-follows. Opaque, and the edges the frontier is derived from.
    #[serde(default)]
    pub follows: Vec<serde_json::Value>,
    /// The `did:dht`s they follow wholesale.
    #[serde(default, rename = "handleFollows")]
    pub handle_follows: Vec<String>,
    /// The directory pointer this was read from. Sia is content-addressed, so an unchanged
    /// URL proves the bytes are identical — which is what lets a later pass confirm this
    /// record without downloading anything.
    #[serde(default)]
    pub url: String,
    /// The parse this record was produced by. See `DISCOVER_EPOCH`.
    #[serde(default)]
    pub epoch: u32,
    /// When the substance below last MOVED — not when it was last looked at.
    ///
    /// Deliberately not a heartbeat. A field that advanced every pass would change the
    /// doc every pass, and the snapshot loop mirrors the whole doc whenever its
    /// fingerprint moves: that is exactly the instance-registration bug of 2026-08-29,
    /// which re-uploaded an idle account's entire doc every ~17 seconds. Because this only
    /// moves with the rest of the record, no fingerprint cut is needed for it at all.
    ///
    /// The cost accepted: an identity that is alive but has published nothing looks as old
    /// as one that has gone away. That is the honest reading — it says how old what we
    /// HOLD is — and it is the right input for eviction, which asks whether a record is
    /// still worth keeping rather than whether someone answered the phone.
    #[serde(default, rename = "seenAt")]
    pub seen_at: String,
}

/// Build a record from a directory blob and the packet that pointed at it.
///
/// Both halves come from one resolve and one download the crawl was already making — the
/// TXT set carries `_iroh` beside the `_dir` the crawl came for, and the blob carries the
/// profile, channels and follows beside the endorsements. Neither is fetched here.
///
/// Tolerant field by field, and deliberately: this reads somebody ELSE's published
/// document, so one malformed channel entry must not cost us their profile. A directory
/// that parses to an empty record is a real answer — a new identity that has published
/// nothing — and it is the answer that lets us stop asking.
pub(crate) fn parse_directory(
    blob: &serde_json::Value,
    txt: &[pin_pkarr::TxtRecord],
    url: &str,
    now_iso: &str,
) -> DirectoryRecord {
    DirectoryRecord {
        // `null` and absent both mean "they publish no profile" — the identity publisher
        // writes an explicit null, so treating one as a value would hold a profile whose
        // every field is missing rather than none at all.
        profile: match blob.get("profile") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => Some(v.clone()),
        },
        channels: blob
            .get("channels")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|v| serde_json::from_value::<DirectoryChannel>(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default(),
        reach: crate::parse_endpoints(&pin_pkarr::rejoin_txt(txt, crate::identity::IROH_PREFIX)),
        follows: blob
            .get("follows")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        handle_follows: blob
            .get("handleFollows")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        url: url.to_string(),
        epoch: DISCOVER_EPOCH,
        seen_at: now_iso.to_string(),
    }
}

/// The held record with its endpoints replaced by what the packet says now.
///
/// The one field that can move while the directory blob stands still: the blob is behind a
/// content-addressed pointer, so an unchanged pointer proves the profile, channels and
/// follows are identical — but `_iroh` rides in the packet, and a relay moving or a new
/// device appearing rewrites it with nothing else changing. Since the packet is resolved
/// on every crawling pass whether or not the blob is downloaded, keeping reach current on
/// that path is free, and it is the half that decides whether a knock can be delivered.
pub(crate) fn with_reach(
    held: &DirectoryRecord,
    txt: &[pin_pkarr::TxtRecord],
    now_iso: &str,
) -> DirectoryRecord {
    let mut fresh = held.clone();
    fresh.reach = crate::parse_endpoints(&pin_pkarr::rejoin_txt(txt, crate::identity::IROH_PREFIX));
    fresh.seen_at = now_iso.to_string();
    fresh
}

/// Whether two readings of an identity differ in anything but when they were taken.
///
/// Normalizes the excluded field and compares the WHOLE record, rather than listing the
/// fields that count. Field-by-field would silently stop covering anything the type gains
/// later — the destructure-and-rebuild bug this codebase has already shipped twice in two
/// days — whereas normalizing means a new field joins the comparison by existing. It is
/// the shape `covered_value` uses to keep an instance's heartbeat out of the snapshot
/// fingerprint, for the same reason and with the same hazard if it drifts.
pub(crate) fn same_substance(a: &DirectoryRecord, b: &DirectoryRecord) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    a.seen_at.clear();
    b.seen_at.clear();
    a == b
}

/// What this identity holds about `did`, or `None` if it has never read them.
pub(crate) async fn read_directory(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    did: &str,
) -> Option<DirectoryRecord> {
    let raw = crate::read_record(doc, blobs, author_id, pin_derive::DIRECTORY_COLLECTION, did)
        .await
        .ok()??;
    serde_json::from_slice(&raw).ok()
}

/// Record what a read of `did`'s directory produced.
///
/// Silent when the substance is unchanged, and that is load-bearing rather than an
/// optimization: every write to this doc is a change announced to every instance syncing
/// it AND a reason for the snapshot loop to mirror the whole doc to Sia. A pass that
/// learned nothing new must cost nothing.
///
/// `seen_at` is carried forward from the held record when nothing moved, so it keeps
/// meaning "when this last changed" rather than drifting into "when we last looked".
///
/// Errors are swallowed by design. This is called from loops whose actual job is something
/// else, and a second consumer of their read must never be able to fail it.
pub(crate) async fn record_directory(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    did: &str,
    fresh: DirectoryRecord,
) {
    if let Some(held) = read_directory(doc, blobs, author_id, did).await {
        if same_substance(&held, &fresh) {
            return;
        }
    }
    let Ok(bytes) = serde_json::to_vec(&fresh) else {
        return;
    };
    let _ = crate::write_record(doc, author_id, pin_derive::DIRECTORY_COLLECTION, did, bytes).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> DirectoryRecord {
        DirectoryRecord {
            profile: Some(serde_json::json!({"username": "alice"})),
            channels: vec![DirectoryChannel {
                channel_id: "chan-one".into(),
                key: "AAAA".into(),
                name: "First".into(),
            }],
            reach: vec![InstanceAddr {
                node_id: "n1".into(),
                relay: Some("https://relay.example/".into()),
            }],
            follows: vec![serde_json::json!({"didDht": "did:dht:bob", "channelID": "c1"})],
            handle_follows: vec!["did:dht:carol".into()],
            url: "sia://one".into(),
            epoch: DISCOVER_EPOCH,
            seen_at: "2026-09-01T00:00:00.000Z".into(),
        }
    }

    /// A directory as the identity publisher actually writes one.
    ///
    /// A JSON literal rather than a constructed value, the way `graph_actors`' test builds
    /// its settings: this pins the blob's FIELD NAMES as well as the parse, which is the
    /// mistake no compiler on either side of this can see. `handleFollows` and `channelID`
    /// are exactly the two a `rename_all` would spell differently.
    const BLOB: &str = r#"{
        "version": 3,
        "profile": {
            "$type": "dev.sia.pin.profile",
            "username": "alice",
            "displayName": "Alice",
            "avatarURL": "sia://avatar#encryption_key=a"
        },
        "channels": [
            {"channelID": "chan-one", "key": "AAAA", "name": "First"},
            {"channelID": "chan-two", "key": "BBBB", "name": "Second"}
        ],
        "follows": [
            {"didDht": "did:dht:bob", "channelID": "c1", "name": "Theirs"},
            {"didDht": "did:dht:carol", "channelID": "c2"}
        ],
        "handleFollows": ["did:dht:dan", "did:dht:eve"],
        "endorsements": [],
        "updatedAt": "2026-09-01T00:00:00.000Z"
    }"#;

    const NOW: &str = "2026-09-01T12:00:00.000Z";

    fn packet(addrs: &[InstanceAddr]) -> Vec<pin_pkarr::TxtRecord> {
        // Built through the real chunker and the real encoder, so the test reads the
        // packet the identity loop writes rather than one shaped to be easy to parse.
        let mut txt = pin_pkarr::chunk_txt("_dir", "sia://their-directory");
        if !addrs.is_empty() {
            txt.extend(pin_pkarr::chunk_txt(
                "_iroh",
                &crate::encode_endpoints(addrs),
            ));
        }
        txt
    }

    #[test]
    fn a_directory_becomes_everything_one_read_yields() {
        let blob: serde_json::Value = serde_json::from_str(BLOB).unwrap();
        let addrs = vec![
            InstanceAddr {
                node_id: "aaa".into(),
                relay: Some("https://use1-1.relay.n0.iroh.link./".into()),
            },
            InstanceAddr {
                node_id: "bbb".into(),
                relay: None,
            },
        ];

        let r = parse_directory(&blob, &packet(&addrs), "sia://their-directory", NOW);

        assert_eq!(r.profile.unwrap()["username"], "alice");
        assert_eq!(
            r.channels,
            vec![
                DirectoryChannel {
                    channel_id: "chan-one".into(),
                    key: "AAAA".into(),
                    name: "First".into(),
                },
                DirectoryChannel {
                    channel_id: "chan-two".into(),
                    key: "BBBB".into(),
                    name: "Second".into(),
                },
            ]
        );
        // Where to reach them, out of the same packet that named their directory — the
        // half this crawl used to drop while `deliver` resolved the key again to get it.
        assert_eq!(r.reach, addrs);
        // The follows are the edges the frontier is derived from, so the DIDs have to
        // survive: a follow whose `didDht` was dropped is a person we can never discover.
        assert_eq!(r.follows.len(), 2);
        assert_eq!(r.follows[0]["didDht"], "did:dht:bob");
        assert_eq!(r.follows[1]["didDht"], "did:dht:carol");
        assert_eq!(r.handle_follows, ["did:dht:dan", "did:dht:eve"]);
        assert_eq!(r.url, "sia://their-directory");
        assert_eq!(r.epoch, DISCOVER_EPOCH);
        assert_eq!(r.seen_at, NOW);
    }

    #[test]
    fn a_published_null_profile_is_no_profile_rather_than_an_empty_one() {
        // The identity publisher writes an explicit `null` when there is no profile
        // instead of omitting the key. Reading that as a value would hold a profile whose
        // every field is missing, which renders as a person with a blank name rather than
        // as somebody we know nothing about.
        let blob: serde_json::Value =
            serde_json::from_str(r#"{"version":3,"profile":null,"channels":[]}"#).unwrap();
        assert_eq!(parse_directory(&blob, &[], "sia://x", NOW).profile, None);

        let absent: serde_json::Value = serde_json::from_str("{}").unwrap();
        assert_eq!(parse_directory(&absent, &[], "sia://x", NOW).profile, None);
    }

    #[test]
    fn one_malformed_channel_does_not_cost_us_the_rest_of_them() {
        // Somebody else's document, so it is not ours to trust the shape of. Failing the
        // whole identity over one bad entry would lose their profile and every edge they
        // publish, which is a much larger loss than the entry itself.
        let blob: serde_json::Value = serde_json::from_str(
            r#"{"channels":[
                {"channelID":"good","key":"AAAA","name":"Fine"},
                {"nonsense":true},
                {"channelID":"also-good","key":"BBBB","name":"Also fine"}
            ]}"#,
        )
        .unwrap();

        let r = parse_directory(&blob, &[], "sia://x", NOW);
        assert_eq!(r.channels.len(), 2);
        assert_eq!(r.channels[0].channel_id, "good");
        assert_eq!(r.channels[1].channel_id, "also-good");
    }

    #[test]
    fn a_packet_with_no_endpoints_reads_as_no_endpoints() {
        // An identity whose instances are all asleep publishes a directory pointer and no
        // `_iroh`. That is a real answer meaning "nowhere to dial right now", and it must
        // not fail the parse — their channels are still readable from Sia without them.
        let blob: serde_json::Value = serde_json::from_str(BLOB).unwrap();
        let r = parse_directory(&blob, &packet(&[]), "sia://their-directory", NOW);
        assert!(r.reach.is_empty());
        assert_eq!(r.channels.len(), 2);
    }

    #[test]
    fn refreshing_reach_moves_the_endpoints_and_nothing_else() {
        // The skip path: their directory pointer has not moved, so the blob is
        // byte-identical and only the packet can have changed.
        let held = record();
        let moved = vec![InstanceAddr {
            node_id: "aaa".into(),
            relay: Some("https://elsewhere.example/".into()),
        }];

        let fresh = with_reach(&held, &packet(&moved), NOW);

        assert_eq!(fresh.reach, moved);
        assert!(!same_substance(&held, &fresh));
        // Everything the blob carries is untouched, because nothing here read a blob.
        assert_eq!(fresh.profile, held.profile);
        assert_eq!(fresh.channels, held.channels);
        assert_eq!(fresh.follows, held.follows);
        assert_eq!(fresh.handle_follows, held.handle_follows);
        assert_eq!(fresh.url, held.url);
    }

    #[test]
    fn an_unchanged_packet_refreshes_nothing() {
        // What keeps the skip path silent. `record_directory` compares substance before
        // writing, and every write is a change announced to every syncing instance and a
        // reason to mirror the whole doc to Sia — so a pass where nobody moved has to
        // produce a record that compares equal, not one that merely looks similar.
        let held = record();
        let same = with_reach(&held, &packet(&held.reach.clone()), NOW);
        assert!(same_substance(&held, &same));
    }

    #[test]
    fn a_reading_taken_twice_is_the_same_substance() {
        let mut later = record();
        later.seen_at = "2026-12-25T00:00:00.000Z".into();
        assert!(same_substance(&record(), &later));
    }

    #[test]
    fn every_field_but_the_timestamp_is_substance() {
        // One case per field, because the comparison's whole job is to be exhaustive: a
        // change this misses is a record that never updates, and the field most likely to
        // move on its own — an endpoint's relay — is the one a hand-listed comparison
        // would be likeliest to leave out.
        let cases: Vec<(&str, Box<dyn Fn(&mut DirectoryRecord)>)> = vec![
            (
                "profile",
                Box::new(|r: &mut DirectoryRecord| {
                    r.profile = Some(serde_json::json!({"username": "alicia"}))
                }),
            ),
            (
                "profile removed",
                Box::new(|r: &mut DirectoryRecord| r.profile = None),
            ),
            (
                "channel name",
                Box::new(|r: &mut DirectoryRecord| r.channels[0].name = "Renamed".into()),
            ),
            (
                "channel key",
                Box::new(|r: &mut DirectoryRecord| r.channels[0].key = "BBBB".into()),
            ),
            (
                "channel added",
                Box::new(|r: &mut DirectoryRecord| {
                    r.channels.push(DirectoryChannel {
                        channel_id: "chan-two".into(),
                        key: "CCCC".into(),
                        name: "Second".into(),
                    })
                }),
            ),
            (
                "relay moved",
                Box::new(|r: &mut DirectoryRecord| {
                    r.reach[0].relay = Some("https://elsewhere.example/".into())
                }),
            ),
            (
                "endpoint added",
                Box::new(|r: &mut DirectoryRecord| {
                    r.reach.push(InstanceAddr {
                        node_id: "n2".into(),
                        relay: None,
                    })
                }),
            ),
            (
                "follow added",
                Box::new(|r: &mut DirectoryRecord| {
                    r.follows
                        .push(serde_json::json!({"didDht": "did:dht:dan", "channelID": "c9"}))
                }),
            ),
            (
                "handle follow removed",
                Box::new(|r: &mut DirectoryRecord| r.handle_follows.clear()),
            ),
            (
                "pointer moved",
                Box::new(|r: &mut DirectoryRecord| r.url = "sia://two".into()),
            ),
            (
                "epoch",
                Box::new(|r: &mut DirectoryRecord| r.epoch = DISCOVER_EPOCH + 1),
            ),
        ];

        for (name, mutate) in cases {
            let mut changed = record();
            mutate(&mut changed);
            assert!(
                !same_substance(&record(), &changed),
                "{name} must count as a change"
            );
        }
    }

    #[test]
    fn the_serialized_shape_is_the_one_the_frontend_reads() {
        // Asserted as an exact key set rather than by round-tripping our own output: a
        // round trip agrees with itself while disagreeing with every other reader about
        // field names, which is how an `itemUrl` once shipped where everything read
        // `itemURL`. `nodeID` and `handleFollows` are the two `rename_all` would get
        // wrong, and `channelID` matches what the directory blob itself publishes.
        let json = serde_json::to_value(record()).unwrap();
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "channels",
                "epoch",
                "follows",
                "handleFollows",
                "profile",
                "reach",
                "seenAt",
                "url",
            ]
        );

        let channel = obj["channels"][0].as_object().unwrap();
        let mut channel_keys: Vec<&str> = channel.keys().map(String::as_str).collect();
        channel_keys.sort_unstable();
        assert_eq!(channel_keys, ["channelID", "key", "name"]);

        let endpoint = obj["reach"][0].as_object().unwrap();
        let mut endpoint_keys: Vec<&str> = endpoint.keys().map(String::as_str).collect();
        endpoint_keys.sort_unstable();
        assert_eq!(endpoint_keys, ["nodeID", "relay"]);
    }

    #[test]
    fn a_record_survives_a_round_trip_including_fields_we_do_not_interpret() {
        // The profile and the follows are opaque on purpose, so a field this crate has
        // never heard of has to come back out intact rather than be dropped by a stricter
        // type on the way through.
        let mut original = record();
        original.profile = Some(serde_json::json!({
            "username": "alice",
            "somethingWeHaveNeverSeen": {"nested": [1, 2, 3]}
        }));

        let bytes = serde_json::to_vec(&original).unwrap();
        let back: DirectoryRecord = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn a_directory_that_published_nothing_still_parses() {
        // An identity with a profile and no channels, follows or endpoints is an ordinary
        // state — a new account — and must read as an empty record rather than a failure,
        // because a failed parse is what makes a held record never update.
        let back: DirectoryRecord = serde_json::from_str("{}").unwrap();
        assert_eq!(back.profile, None);
        assert!(back.channels.is_empty());
        assert!(back.reach.is_empty());
        assert!(back.follows.is_empty());
        assert!(back.handle_follows.is_empty());
    }
}
