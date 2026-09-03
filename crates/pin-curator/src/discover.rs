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

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};

use crate::{InstanceAddr, SettingsView};

/// How many identities one pass will go and read.
///
/// A cap on work per wake rather than a loop that runs until the frontier is empty, which
/// is the shape `repack` settled on for the same reason: a pass moves real bytes over the
/// network, and the frontier is unbounded by construction while an evening is not. The
/// crawl is never finished, so what matters is that it advances every pass and stops.
///
/// Each one costs a DHT resolve and a Sia download — the slow, QUIC-flaky half — so this
/// is small on purpose. The measured question it answers is "how many passes to cover a
/// graph", and `discovery.test.ts` is where that gets answered rather than guessed.
pub const MAX_RESOLVES_PER_PASS: usize = 8;

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

/// Where an identity's directory currently is, and where they can be dialed.
///
/// Hands back the whole packet alongside the pointer it came for. One resolve answers two
/// questions — `_dir` and `_iroh` — and the second used to be thrown away by the crawl
/// while `deliver` resolved the same key again to ask it.
pub(crate) struct Resolved {
    pub url: String,
    pub txt: Vec<pin_pkarr::TxtRecord>,
}

/// Resolve one identity's published packet, or fail meaning we couldn't find out.
///
/// Here rather than beside either caller, because both loops that read somebody's
/// directory start with this exact step and a second copy would be a second answer to
/// "what counts as no directory".
pub(crate) async fn resolve_directory(did: &str) -> Result<Resolved, String> {
    let txt = pin_pkarr::resolve(did).await?;
    let url = pin_pkarr::rejoin_txt(&txt, crate::identity::DIR_PREFIX);
    if url.is_empty() {
        return Err(format!("{did}: no directory published"));
    }
    Ok(Resolved { url, txt })
}

/// Download and parse one identity's directory blob.
///
/// Shared for the same reason `resolve_directory` is: engagement reads it for endorsements
/// and discovery for everything else, and it is one object either way.
pub(crate) async fn download_directory_blob(
    sia: &pin_sia::Session,
    did: &str,
    url: &str,
) -> Result<serde_json::Value, String> {
    let bytes = sia.download_item(url).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{did}: directory: {e}"))
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

/// The identities a held record points at: channel-follows and wholesale follows alike.
///
/// One set, because for discovery they are the same edge — a pointer at another server.
/// Which KIND of pointer it is matters to a feed and not to a crawl.
pub fn edges_of(record: &DirectoryRecord) -> Vec<String> {
    let mut out = Vec::new();
    for f in &record.follows {
        if let Some(did) = f.get("didDht").and_then(|v| v.as_str()) {
            out.push(did.to_string());
        }
    }
    out.extend(record.handle_follows.iter().cloned());
    out
}

/// An identity known to exist and never read.
///
/// Not stored anywhere. The frontier is recomputed from held records each pass, because
/// materializing it would multiply doc entries by the graph's fan-out to hold nothing a
/// held record does not already carry — and `list_rkeys` scans the whole doc, so entry
/// count is the cost that matters.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Candidate {
    pub did: String,
    /// Hops from this identity's own graph. 0 means somebody it follows directly points
    /// at them.
    pub distance: u32,
    /// How many held directories point at them. Corroboration, and the tiebreak among
    /// equals — somebody four of your follows point at is a better guess than somebody
    /// one does.
    pub references: usize,
    /// Whether a screen asked for them and had to fall back to the network to answer.
    pub nominated: bool,
}

/// Unreachable from the seeds. Held records reached some other way — a portal, a knock —
/// have no distance from the graph, and sorting them ahead of it would let an arbitrary
/// stranger's follows outrank the people you actually follow.
const UNREACHED: u32 = u32::MAX;

/// How far each held identity sits from this identity's own graph.
///
/// A breadth-first walk over held records only: no network, no fetching, and it terminates
/// on what is in hand. Anything held but not reachable from the seeds keeps `UNREACHED`,
/// which is a real answer rather than a missing one.
fn distances(r0: &BTreeSet<String>, held: &BTreeMap<String, Vec<String>>) -> BTreeMap<String, u32> {
    let mut dist: BTreeMap<String, u32> = BTreeMap::new();
    let mut queue: VecDeque<String> = VecDeque::new();

    for did in r0 {
        if held.contains_key(did) {
            dist.insert(did.clone(), 0);
            queue.push_back(did.clone());
        }
    }
    while let Some(cur) = queue.pop_front() {
        let step = dist[&cur].saturating_add(1);
        for next in held.get(&cur).map(Vec::as_slice).unwrap_or_default() {
            if held.contains_key(next) && !dist.contains_key(next) {
                dist.insert(next.clone(), step);
                queue.push_back(next.clone());
            }
        }
    }
    for did in held.keys() {
        dist.entry(did.clone()).or_insert(UNREACHED);
    }
    dist
}

/// Everyone known to exist and not yet read, in the order they should be read.
///
/// `r0` is this identity's own graph — the people it follows and subscribes to. They are
/// EXCLUDED from the result even when unread, because the engagement crawl reads exactly
/// that set on its own cadence: two loops resolving one key on different schedules would
/// race to write the same record and spend the DHT lookup twice.
///
/// The ordering is provenance, not a score. Nominations first — somebody asked for them
/// out loud — then nearest, then best-corroborated, then by did so two instances of one
/// identity agree. Nothing here ranks people by anything they did; it decides which of the
/// unread to read next, and everything unread is eventually read.
pub fn frontier(
    r0: &BTreeSet<String>,
    held: &BTreeMap<String, Vec<String>>,
    nominations: &BTreeSet<String>,
) -> Vec<Candidate> {
    let dist = distances(r0, held);
    let mut found: BTreeMap<String, (u32, usize)> = BTreeMap::new();

    for (holder, edges) in held {
        let from = dist.get(holder).copied().unwrap_or(UNREACHED);
        let step = if from == UNREACHED {
            UNREACHED
        } else {
            from.saturating_add(1)
        };
        for target in edges {
            if held.contains_key(target) || r0.contains(target) {
                continue;
            }
            let entry = found.entry(target.clone()).or_insert((step, 0));
            entry.0 = entry.0.min(step);
            entry.1 += 1;
        }
    }

    // A nomination for somebody nothing points at is still a candidate: a screen reached
    // for them, which is the strongest signal there is that they are worth reading, and it
    // is the one signal that does not come from the graph.
    for did in nominations {
        if held.contains_key(did) || r0.contains(did) {
            continue;
        }
        found.entry(did.clone()).or_insert((UNREACHED, 0));
    }

    let mut out: Vec<Candidate> = found
        .into_iter()
        .map(|(did, (distance, references))| Candidate {
            nominated: nominations.contains(&did),
            did,
            distance,
            references,
        })
        .collect();

    out.sort_by(|a, b| {
        b.nominated
            .cmp(&a.nominated)
            .then(a.distance.cmp(&b.distance))
            .then(b.references.cmp(&a.references))
            .then(a.did.cmp(&b.did))
    });
    out
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

/// Everything a discovery pass needs.
pub struct DiscoverContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// A connected Sia session: a directory's contents live in a blob, and reading
    /// somebody new means downloading it.
    pub sia: std::sync::Arc<pin_sia::Session>,
    pub app_key: [u8; 32],
}

/// What one pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DiscoverOutcome {
    /// Identities held after this pass.
    pub held: usize,
    /// Identities known to exist and not yet read, before this pass spent its budget. The
    /// number that says whether the crawl is keeping up: it shrinks toward zero on a
    /// settled graph and grows on one that is opening up.
    pub frontier: usize,
    /// Read for the first time this pass.
    pub resolved: usize,
    /// Tried and couldn't be read. They stay on the frontier and come round again — an
    /// unreachable identity is somebody asleep, not somebody gone.
    pub unreachable: usize,
}

/// The identities the engagement crawl already covers, and which discovery therefore
/// leaves alone.
///
/// This identity's own did is in the set, which is the whole reason this is a function
/// rather than a call to `graph_actors`: anyone in your graph who follows one of your
/// channels names YOU as an edge, so leaving yourself out sends the crawl to read your own
/// directory over the network — a lookup and a download to be told, staler, what local
/// state already holds. `engagement_once` inserts `own_did` into its own graph for the
/// same reason.
fn covered_elsewhere(settings: &SettingsView, own_did: &str) -> BTreeSet<String> {
    let mut covered = crate::engagement::graph_actors(settings);
    covered.insert(own_did.to_string());
    covered
}

/// Every identity held, with the identities it points at.
///
/// The edges alone, because that is all the frontier depends on — carrying whole records
/// would hold a profile and a channel list per identity for a computation that reads
/// neither.
async fn held_edges(ctx: &DiscoverContext) -> BTreeMap<String, Vec<String>> {
    let mut held = BTreeMap::new();
    let Ok(dids) =
        crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::DIRECTORY_COLLECTION).await
    else {
        return held;
    };
    for did in dids {
        if let Some(record) = read_directory(&ctx.doc, &ctx.blobs, ctx.author_id, &did).await {
            held.insert(did, edges_of(&record));
        }
    }
    held
}

/// Go and read some of the identities this one knows about and has never looked at.
///
/// The only part of discovery that spends anything. Everything else — hop one, and every
/// edge the frontier is derived from — falls out of reads the engagement crawl was making
/// anyway; this is the loop that widens the circle, and it is budgeted because the frontier
/// is unbounded by construction.
pub async fn discover_once(
    ctx: &DiscoverContext,
    own_did: &str,
    now_iso: String,
    nominations: &BTreeSet<String>,
) -> Result<DiscoverOutcome, String> {
    let mut outcome = DiscoverOutcome::default();
    let settings = crate::read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;

    let covered = covered_elsewhere(&settings, own_did);
    let held = held_edges(ctx).await;
    outcome.held = held.len();

    let candidates = frontier(&covered, &held, nominations);
    outcome.frontier = candidates.len();

    for candidate in candidates.iter().take(MAX_RESOLVES_PER_PASS) {
        let Ok(resolved) = resolve_directory(&candidate.did).await else {
            // Asleep, or a relay that didn't answer. They stay on the frontier, and an
            // inability to read is never turned into a record saying they have nothing.
            outcome.unreachable += 1;
            continue;
        };
        let Ok(blob) = download_directory_blob(&ctx.sia, &candidate.did, &resolved.url).await
        else {
            outcome.unreachable += 1;
            continue;
        };
        record_directory(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            &candidate.did,
            parse_directory(&blob, &resolved.txt, &resolved.url, &now_iso),
        )
        .await;
        outcome.resolved += 1;
    }
    Ok(outcome)
}

/// Pass, wait, repeat — forever.
///
/// Timer-driven, with no wake source, and that is deliberate: every input this reads is a
/// record in this doc, so waking on doc changes would have the loop's own writes wake it —
/// the shape `deliver` calls "a loop feeding itself". Nothing here is latency-sensitive
/// either. Discovery is how the network becomes visible over days, not how a count arrives.
pub async fn run_discover_loop(
    ctx: DiscoverContext,
    own_did: String,
    cadence: Duration,
    now_iso: impl Fn() -> String,
    on_pass: impl Fn(Result<DiscoverOutcome, String>),
) -> ! {
    loop {
        on_pass(discover_once(&ctx, &own_did, now_iso(), &BTreeSet::new()).await);
        n0_future::time::sleep(cadence).await;
    }
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

    fn set(dids: &[&str]) -> BTreeSet<String> {
        dids.iter().map(|d| d.to_string()).collect()
    }

    fn graph(edges: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
        edges
            .iter()
            .map(|(from, to)| {
                (
                    from.to_string(),
                    to.iter().map(|t| t.to_string()).collect::<Vec<_>>(),
                )
            })
            .collect()
    }

    fn dids(candidates: &[Candidate]) -> Vec<&str> {
        candidates.iter().map(|c| c.did.as_str()).collect()
    }

    #[test]
    fn the_frontier_is_who_is_pointed_at_and_not_held() {
        // alice is followed and read; she points at bob and carol, neither read. They are
        // the frontier — known to exist, never looked at.
        let f = frontier(
            &set(&["alice"]),
            &graph(&[("alice", &["bob", "carol"])]),
            &BTreeSet::new(),
        );
        assert_eq!(dids(&f), ["bob", "carol"]);
    }

    #[test]
    fn somebody_already_held_is_not_on_the_frontier() {
        // The frontier is the UNREAD. Re-reading a held identity is the crawl mark's
        // decision on its own cadence, not this one's.
        let f = frontier(
            &set(&["alice"]),
            &graph(&[("alice", &["bob"]), ("bob", &[])]),
            &BTreeSet::new(),
        );
        assert!(f.is_empty());
    }

    #[test]
    fn this_identitys_own_graph_is_left_to_the_engagement_crawl() {
        // carol is followed directly, so the engagement crawl reads her every crawling
        // pass. Listing her here would have two loops resolving one key on two cadences,
        // racing to write the same record and paying the DHT lookup twice.
        let f = frontier(
            &set(&["alice", "carol"]),
            &graph(&[("alice", &["bob", "carol"])]),
            &BTreeSet::new(),
        );
        assert_eq!(dids(&f), ["bob"]);
    }

    #[test]
    fn the_frontier_advances_one_ring_at_a_time() {
        // What somebody points at only becomes visible once they have been read. So the
        // crawl cannot leap: it learns of dave by reading bob, and it learns of bob by
        // reading alice. That is what keeps the far graph from arriving before the near
        // one, without anything having to enforce an order.
        let before = frontier(
            &set(&["alice"]),
            &graph(&[("alice", &["bob"])]),
            &BTreeSet::new(),
        );
        assert_eq!(dids(&before), ["bob"]);
        assert_eq!(before[0].distance, 1);

        // Now bob has been read, and what HE points at appears for the first time.
        let after = frontier(
            &set(&["alice"]),
            &graph(&[("alice", &["bob"]), ("bob", &["dave"])]),
            &BTreeSet::new(),
        );
        assert_eq!(dids(&after), ["dave"]);
        assert_eq!(after[0].distance, 2);
    }

    #[test]
    fn a_ring_further_out_sorts_after_a_nearer_one() {
        // Both unread and both on the frontier at once: `near` is pointed at by somebody
        // this identity follows, `far` by somebody one hop past that.
        let f = frontier(
            &set(&["alice"]),
            &graph(&[("alice", &["bob", "near"]), ("bob", &["far"])]),
            &BTreeSet::new(),
        );
        assert_eq!(dids(&f), ["near", "far"]);
        assert_eq!(f[0].distance, 1);
        assert_eq!(f[1].distance, 2);
    }

    #[test]
    fn corroboration_breaks_a_tie_between_equals() {
        // Two candidates the same distance out: the one more of your graph points at is
        // the better guess. A tiebreak among equals, never a ranking across distances.
        let f = frontier(
            &set(&["alice", "bob"]),
            &graph(&[("alice", &["popular", "obscure"]), ("bob", &["popular"])]),
            &BTreeSet::new(),
        );
        assert_eq!(dids(&f), ["popular", "obscure"]);
        assert_eq!(f[0].references, 2);
        assert_eq!(f[1].references, 1);
    }

    #[test]
    fn somebody_asked_for_is_read_first() {
        // The one signal that does not come from the graph: a screen reached for them and
        // had to go to the network to answer. That outranks every graph-derived reason.
        let f = frontier(
            &set(&["alice"]),
            &graph(&[("alice", &["popular", "wanted"]), ("other", &["popular"])]),
            &set(&["wanted"]),
        );
        assert_eq!(dids(&f)[0], "wanted");
        assert!(f[0].nominated);
    }

    #[test]
    fn somebody_asked_for_that_nobody_points_at_is_still_a_candidate() {
        // A pasted link, or a knock from outside the graph. Nothing in the graph names
        // them, and the request is the whole reason they are worth reading.
        let f = frontier(&set(&["alice"]), &graph(&[]), &set(&["stranger"]));
        assert_eq!(dids(&f), ["stranger"]);
        assert!(f[0].nominated);
        assert_eq!(f[0].references, 0);
    }

    #[test]
    fn the_order_is_the_same_every_time_it_is_computed() {
        // Two instances of one identity compute this independently and must agree, or
        // they resolve different people and each writes what the other did not.
        let r0 = set(&["alice", "bob"]);
        let g = graph(&[
            ("alice", &["one", "two", "three"]),
            ("bob", &["two", "three"]),
        ]);
        let first = frontier(&r0, &g, &BTreeSet::new());
        let again = frontier(&r0, &g, &BTreeSet::new());
        assert_eq!(first, again);
        // And the tiebreak past references is the did itself, so equals never shuffle.
        assert_eq!(dids(&first), ["three", "two", "one"]);
    }

    #[test]
    fn nobody_reachable_is_left_off_the_frontier_forever() {
        // The starvation property, checked at the unit level and again over real graphs
        // in `discovery.test.ts`. Everything a held record points at appears, however
        // lightly referenced — an ordering that dropped the tail would leave somebody
        // permanently unread rather than merely last.
        let g = graph(&[("alice", &["a", "b", "c", "d", "e"])]);
        let f = frontier(&set(&["alice"]), &g, &BTreeSet::new());
        assert_eq!(dids(&f), ["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn a_stranger_we_hold_never_outranks_the_graph() {
        // A record reached some other way — a portal, a knock — has no distance from this
        // identity's graph. Its follows are still candidates, but behind everything the
        // graph points at: otherwise reposting one stranger would redirect the crawl.
        let f = frontier(
            &set(&["alice"]),
            &graph(&[
                ("alice", &["from-my-graph"]),
                ("stranger", &["from-a-stranger"]),
            ]),
            &BTreeSet::new(),
        );
        assert_eq!(dids(&f), ["from-my-graph", "from-a-stranger"]);
        assert_eq!(f[0].distance, 1);
        assert_eq!(f[1].distance, UNREACHED);
    }

    #[test]
    fn what_the_other_loop_covers_includes_this_identity() {
        // The self-exclusion made structural rather than remembered. Building this set by
        // hand at the call site is exactly how you forget yourself — and forgetting sends
        // the crawl to read your own directory over the network, which is a lookup and a
        // download to be told, staler, what local state already holds.
        //
        // Parsed from a JSON literal rather than constructed, the way `graph_actors`' own
        // test is: it pins the settings field names too, which is the class of mistake no
        // compiler on either side of this can see.
        let settings: SettingsView = serde_json::from_str(
            r#"{
                "follows":[{"didDht":"did:dht:alice","channelID":"c1"}],
                "handleFollows":["did:dht:bob"],
                "subscriptions":[
                  {"channelID":"c2","channelKey":"KK","didDht":"did:dht:carol"}
                ]
            }"#,
        )
        .unwrap();

        let covered = covered_elsewhere(&settings, "did:dht:me");
        assert!(covered.contains("did:dht:me"));
        assert!(covered.contains("did:dht:alice"));
        assert!(covered.contains("did:dht:bob"));
        assert!(covered.contains("did:dht:carol"));
    }

    #[test]
    fn this_identity_is_never_its_own_candidate() {
        // Anyone in your graph who follows one of YOUR channels names you as an edge
        // target, so without this the crawl goes and reads your own directory over the
        // network — a DHT resolve and a download to be told what local state already
        // holds, and told it as of the last publish rather than as of now.
        //
        // `r0` is what the engagement crawl covers, and that set includes this identity
        // itself: `engagement_once` inserts `own_did` into its graph for the same reason.
        // Found by simulating the crawl over whole graphs, where the held set came back
        // exactly one larger than the oracle's every single time.
        let f = frontier(
            &set(&["alice", "me"]),
            &graph(&[("alice", &["me", "bob"])]),
            &BTreeSet::new(),
        );
        assert_eq!(dids(&f), ["bob"]);

        // Not even when something asks for you by name.
        let asked = frontier(
            &set(&["alice", "me"]),
            &graph(&[("alice", &["me"])]),
            &set(&["me"]),
        );
        assert!(asked.is_empty());
    }

    #[test]
    fn a_cycle_terminates() {
        // Follows are mutual all the time, so the walk has to survive one. A visited-set
        // that missed this would hang the pass rather than fail it.
        let f = frontier(
            &set(&["alice"]),
            &graph(&[
                ("alice", &["bob"]),
                ("bob", &["alice", "carol"]),
                ("carol", &["bob", "dave"]),
            ]),
            &BTreeSet::new(),
        );
        assert_eq!(dids(&f), ["dave"]);
    }

    #[test]
    fn the_edges_of_a_record_are_both_kinds_of_follow() {
        // A channel-follow and a wholesale follow are one edge for a crawl: both point at
        // another server. Dropping either would make half the graph undiscoverable.
        let mut r = record();
        r.follows = vec![serde_json::json!({"didDht": "did:dht:bob", "channelID": "c1"})];
        r.handle_follows = vec!["did:dht:carol".into()];
        assert_eq!(edges_of(&r), ["did:dht:bob", "did:dht:carol"]);
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
