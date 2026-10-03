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

/// How much of that budget is reserved for re-reading identities already held.
///
/// A reservation rather than a ranking, because widening the circle and keeping it true are
/// not comparable jobs: scored against each other, whichever scored higher would starve the
/// other outright — and both failures are silent. Discovery stalling looks like a settled
/// network; refresh stalling looks like one where nobody ever changes their name.
///
/// Neither side loses what it does not use: what discovery leaves unspent goes to refresh
/// on the same pass, and the reservation only binds when both have work.
pub const REFRESH_PER_PASS: usize = 3;

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
    /// Whether this channel's posts belong on its author's profile feed.
    ///
    /// Absent means YES, which is the opposite of how `visibility` reads an absent value
    /// and is right for the opposite reason: the safe direction there is refusing to
    /// enumerate an obscure channel, and here it is a channel the author already
    /// advertises showing the posts it already publishes. So every channel written before
    /// this existed keeps appearing, which is what those authors have been seeing.
    ///
    /// Carried only when FALSE, so an ordinary channel adds nothing to a blob the whole
    /// graph downloads to read a display name.
    #[serde(
        default,
        rename = "showOnProfile",
        skip_serializing_if = "Option::is_none"
    )]
    pub show_on_profile: Option<bool>,
    /// `"private"` for a channel whose page anyone may see and whose posts only its members
    /// may read. Absent means public: every entry published before private channels existed
    /// is one, and an entry for a secret channel is never published at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
}

/// How much of an identity is still kept.
///
/// Nothing is ever deleted: the far network fades rather than disappearing, so what is
/// always left is the DID this is filed under and where it was last reachable. That is the
/// floor, and it is deliberate — losing a record entirely would lose the way back to
/// somebody, where losing their profile only loses what they looked like.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum DirectoryTier {
    /// Everything one read yields.
    #[default]
    Full,
    /// The edges and the endpoints. Enough to keep walking the graph through them and to
    /// reach them, without their profile or their channel keys — so distance still
    /// propagates and the horizon fades rather than cutting.
    Reduced,
    /// They exist, and here is where. The floor.
    Minimal,
}

/// Everything one read of another identity's directory yields.
///
/// `profile` and `follows` are opaque `Value`s for the reason the identity publisher keeps
/// them opaque on the way out: the Curator carries a profile, it does not own its shape.
/// A field this crate has never heard of survives a round trip instead of being dropped on
/// the floor by a stricter type.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DirectoryRecord {
    /// How much of them is still held.
    ///
    /// Recorded rather than inferred from which fields are empty, because an identity that
    /// publishes no profile and no channels is indistinguishable from one whose profile
    /// and channels were dropped — and only the second should be read again in full when
    /// they come back within the horizon.
    #[serde(default)]
    pub tier: DirectoryTier,
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
    /// Their person-follow tally as they publish it — how many follow them as a person, with
    /// its receipts. Opaque, and faded with the profile: it describes them rather than
    /// being an edge anybody walks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub followers: Option<serde_json::Value>,
    /// Their X25519 encryption key, base64, as their directory publishes it — what an
    /// invitation to them is sealed to, held so sealing one costs no resolve. Never faded:
    /// like `reach` it is how to get back to them, not what they looked like.
    #[serde(rename = "encKey", default, skip_serializing_if = "Option::is_none")]
    pub enc_key: Option<String>,
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
pub(crate) async fn resolve_directory(
    net: &impl crate::net::Network,
    did: &str,
) -> Result<Resolved, String> {
    let txt = net.resolve(did).await?;
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
    net: &impl crate::net::Network,
    did: &str,
    url: &str,
) -> Result<serde_json::Value, String> {
    let bytes = net.download(url).await?;
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
        // A read always produces the whole thing. Fading is something that happens to a
        // record later, so reading somebody again is also how a faded one comes back.
        tier: DirectoryTier::Full,
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
        followers: match blob.get("followers") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => Some(v.clone()),
        },
        // Kept only when it is a key at all: 32 bytes of base64. A malformed one held here
        // would fail later, at the seal, further from the thing that was wrong.
        enc_key: blob
            .get("encKey")
            .and_then(|v| v.as_str())
            .filter(|k| pin_crypto::b64_decode(k).is_some_and(|b| b.len() == 32))
            .map(str::to_string),
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
    pub requested: bool,
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
/// The ordering is provenance, not a score. Requests first — somebody asked for them
/// out loud — then nearest, then best-corroborated, then by did so two instances of one
/// identity agree. Nothing here ranks people by anything they did; it decides which of the
/// unread to read next, and everything unread is eventually read.
pub fn frontier(
    r0: &BTreeSet<String>,
    held: &BTreeMap<String, Vec<String>>,
    requests: &BTreeSet<String>,
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

    // A request for somebody nothing points at is still a candidate: a screen reached
    // for them, which is the strongest signal there is that they are worth reading, and it
    // is the one signal that does not come from the graph.
    for did in requests {
        if held.contains_key(did) || r0.contains(did) {
            continue;
        }
        found.entry(did.clone()).or_insert((UNREACHED, 0));
    }

    let mut out: Vec<Candidate> = found
        .into_iter()
        .map(|(did, (distance, references))| Candidate {
            requested: requests.contains(&did),
            did,
            distance,
            references,
        })
        .collect();

    out.sort_by(|a, b| {
        b.requested
            .cmp(&a.requested)
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
pub struct DiscoverContext<N: crate::net::Network> {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// How this pass reads the network: resolve a key, download the blob it names. A
    /// directory's contents live in a blob, so reading somebody new is exactly those two.
    pub net: N,
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
    /// Outstanding requests from a screen: people looked at whose name could not be
    /// answered from what is held. They sort ahead of everything the graph suggests, so a
    /// number that stays high means the crawl is not keeping up with what is being asked
    /// of it.
    pub requested: usize,
    /// Held identities re-read whose pointer had moved, so the blob was downloaded again.
    pub refreshed: usize,
    /// Held identities re-read whose pointer had NOT moved. The number this loop most wants
    /// to be large: a settled graph confirmed for one DHT resolve each and no downloads.
    pub unchanged: usize,
    /// Records faded a tier, because they now rank beyond what is kept in full.
    pub faded: usize,
    /// Records listed and not readable this pass. Nonzero switches decay off entirely,
    /// because an edge we could not read is not an edge that is gone.
    pub unread: usize,
    /// Identities a re-read turned up that the frontier at the top of this pass could not
    /// have offered. Reported because the ordering it stands for is otherwise legible only
    /// by comparing two consecutive passes: before this was read within the pass, every one
    /// of these waited out another full cadence.
    pub revealed: usize,
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
async fn held_edges<N: crate::net::Network>(ctx: &DiscoverContext<N>) -> Held {
    let mut held = Held::default();
    let Ok(dids) =
        crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::DIRECTORY_COLLECTION).await
    else {
        // A listing we couldn't take is not an empty index. Reporting one unread switches
        // off every read-dependent decision below for this pass.
        held.unread = 1;
        return held;
    };
    for did in dids {
        match read_directory(&ctx.doc, &ctx.blobs, ctx.author_id, &did).await {
            Some(record) => {
                held.seen_at.insert(did.clone(), record.seen_at.clone());
                held.tier.insert(did.clone(), record.tier);
                held.edges.insert(did, edges_of(&record));
            }
            None => held.unread += 1,
        }
    }
    held
}

/// What this identity holds, as one pass read it.
#[derive(Default)]
struct Held {
    /// Who each held identity points at.
    edges: BTreeMap<String, Vec<String>>,
    /// When each held record last changed.
    seen_at: BTreeMap<String, String>,
    /// How much of each is still kept.
    tier: BTreeMap<String, DirectoryTier>,
    /// Records listed and not readable this pass.
    ///
    /// Counted rather than shrugged off, because it is the whole difference between "they
    /// are far away" and "we could not see how far away they are". One unreadable record
    /// hides every edge it carried, so everything it pointed at looks unreachable — and
    /// unreachable is what decay acts on. That is deny-by-absence, the shape of the sweep
    /// that once near-wiped an account.
    unread: usize,
}

/// How many identities stay FULL — profile, channels and all.
///
/// A count rather than a hop count, because a hop count does not bound anything: at a
/// fan-out of fifty, two hops is 2,500 identities and at two hundred it is 40,000. Sorting
/// by distance and keeping the nearest N bounds the set for real while still meaning
/// "the people closest to you".
///
/// **It is a freshness cap, not a storage cap**, and the distinction is the whole of what
/// picks the number. A full record is about 1.5 KB, so even ten thousand of them is 15 MB
/// and bytes never bind. What binds is that the full tier IS the refresh set:
///
/// ```text
/// MAX_FULL = staleness you accept × passes per day × REFRESH_PER_PASS
/// ```
///
/// At three a pass on a ten-minute cadence, this buys about a day and a bit. What would
/// object before the disk does, in order: the snapshot mirrors the WHOLE doc on every
/// substance change and refresh causes those, so around five thousand full records each
/// pass starts pushing ten megabytes at Sia; past ten thousand HELD, ranking the frontier
/// measures 600 ms a pass.
///
/// **OPEN (2026-09-05, John): the value is provisional.** 500 is a round number, not a
/// decision — the decision is how out of date somebody's name and avatar may be, and that
/// has not been made. Set this from that answer when it exists, and say so here.
pub const MAX_FULL: usize = 500;

/// How many keep their edges as well as their endpoints.
///
/// Beyond this only the endpoints survive, which stops distance propagating through them —
/// so this is the real edge of the map. Generous relative to `MAX_FULL`, because an edge is
/// tens of bytes and it is what lets the graph be walked at all.
///
/// Nothing here is refreshed, so unlike `MAX_FULL` this one really is only about bytes:
/// five thousand reduced records is about 2.5 MB. Provisional for the same reason and
/// probably low — the cost it guards against barely exists.
const MAX_REDUCED: usize = 5_000;

/// How long a record is left alone before it can fade.
///
/// So a burst of new reads is not immediately undone, and so an identity that keeps
/// publishing keeps its place: `seen_at` moves when their substance moves, so staying
/// active resets this.
const DECAY_AFTER_SECS: i64 = 7 * 24 * 60 * 60;

/// How much of each held identity is worth keeping, ranked nearest first.
///
/// One ranking, two consumers: what should fade, and what should be re-read. Computing it
/// twice would let the two disagree about where the boundary is, and then a record could
/// fade out of the full tier on one pass and be re-read into it on the next, forever.
///
/// Ranked by distance and then by did, so the boundary is stable — the same held set
/// decides the same way twice, and two instances of one identity agree without
/// coordinating.
fn wanted_tiers(held: &Held, covered: &BTreeSet<String>) -> BTreeMap<String, DirectoryTier> {
    let dist = distances(covered, &held.edges);
    let mut ranked: Vec<&String> = held.edges.keys().collect();
    ranked.sort_by_key(|did| (dist.get(*did).copied().unwrap_or(UNREACHED), *did));

    ranked
        .into_iter()
        .enumerate()
        .map(|(rank, did)| {
            // Somebody this identity follows is the engagement crawl's to keep current, and
            // never fades however far the graph happens to place them.
            let tier = if covered.contains(did) || rank < MAX_FULL {
                DirectoryTier::Full
            } else if rank < MAX_REDUCED {
                DirectoryTier::Reduced
            } else {
                DirectoryTier::Minimal
            };
            (did.clone(), tier)
        })
        .collect()
}

/// Which held records should fade a step, and to what.
///
/// Nothing is deleted here or anywhere: the floor is `Minimal`, which keeps the DID this is
/// filed under and where they were last reachable. Losing a record entirely would lose the
/// way back to somebody; losing their profile only loses what they looked like.
///
/// Only downward. Coming back within the horizon is handled by reading them again in full,
/// not by inventing fields we no longer hold.
///
/// Runs only over a COMPLETE reading. Decay acts on how far away somebody is, and a record
/// we could not open hides every edge it carried — so one unreadable entry makes whole
/// branches look unreachable and fades them. Doing nothing on a partial read costs a pass;
/// the alternative is the shape of the sweep that once near-wiped an account.
///
/// And never over a reading this pass has already superseded. `reread` is who was gone back
/// to since `held` was taken, so for them it describes a record that no longer exists —
/// which would have a requested identity read back in full and faded again before the pass
/// ended, spending the read to leave nothing behind. Deciding from a superseded reading is
/// the same mistake as deciding from an unreadable one, one pass narrower.
fn decay_plan(
    held: &Held,
    wanted: &BTreeMap<String, DirectoryTier>,
    reread: &BTreeSet<String>,
    now_secs: i64,
) -> Vec<(String, DirectoryTier)> {
    if held.unread > 0 {
        return Vec::new();
    }
    let mut plan = Vec::new();
    for (did, want) in wanted {
        if reread.contains(did) {
            continue;
        }
        let have = held.tier.get(did).copied().unwrap_or_default();
        if *want <= have {
            continue;
        }
        let Some(seen_at) = held.seen_at.get(did) else {
            continue;
        };
        // Never on an inability to read. A timestamp that will not parse means we cannot
        // tell how old this is, and unknown must not become a decision to discard.
        let Some(t) = crate::iso_secs(seen_at) else {
            continue;
        };
        if now_secs.saturating_sub(t) < DECAY_AFTER_SECS {
            continue;
        }
        plan.push((did.clone(), *want));
    }
    plan
}

/// The record as it survives at `tier`.
///
/// `reach` and `url` are kept at every tier: the first is how to get to them without a
/// lookup, and the second is what lets a later pass tell, from the pointer alone, whether
/// anything has changed.
fn faded(record: &DirectoryRecord, tier: DirectoryTier) -> DirectoryRecord {
    let mut out = record.clone();
    out.tier = tier;
    if tier >= DirectoryTier::Reduced {
        out.profile = None;
        out.channels = Vec::new();
        out.followers = None;
    }
    if tier >= DirectoryTier::Minimal {
        out.follows = Vec::new();
        out.handle_follows = Vec::new();
    }
    out
}

/// Whether a held record is confirmed current by its pointer alone, no download.
///
/// Sia is content-addressed, so an unchanged share URL is proof the bytes are identical
/// rather than a hint — which is what makes the common case one DHT resolve and nothing
/// else.
///
/// The tier is the other half, and without it the shortcut is a trap. It claims our copy
/// already holds what a download would produce, and a faded copy does not: it dropped the
/// profile and channels deliberately. So a faded record whose author has published nothing
/// since would be confirmed on every pass and restored on none — and reading a faded
/// identity back when it comes close again is the one thing the rotation goes out of its
/// way to do.
fn confirmed_by_pointer(record: &DirectoryRecord, url: &str) -> bool {
    record.url == url && record.tier == DirectoryTier::Full
}

/// Which held records this pass re-reads, and in what order.
///
/// Round-robin in did order from wherever the last pass stopped, rather than by a
/// last-checked timestamp. A timestamp would have to advance on every check whether or not
/// anything moved, and a field that moves on a timer re-mirrors the whole doc to Sia on the
/// snapshot's next wake — the instance-heartbeat bug of 2026-08-29. The cursor lives in the
/// loop instead, so a restart resumes from the top and costs nothing.
///
/// Everyone the ranking wants FULL, whatever they currently are. Two things at once, and
/// deliberately the same thing: keeping the near set current, and reading a faded record
/// back in full when it comes close again. A re-read produces the whole record either way.
///
/// Nobody beyond the full tier. Out there a record is kept because losing somebody is worse
/// than holding a stale address, not because it is being maintained — refreshing it would
/// spend the budget that keeps the near set true.
fn refresh_rotation(
    wanted: &BTreeMap<String, DirectoryTier>,
    already: &BTreeSet<String>,
    after: &str,
    budget: usize,
) -> Vec<String> {
    let full: Vec<&String> = wanted
        .iter()
        .filter(|(did, tier)| **tier == DirectoryTier::Full && !already.contains(*did))
        .map(|(did, _)| did)
        .collect();
    full.iter()
        .filter(|did| did.as_str() > after)
        .chain(full.iter())
        .take(budget.min(full.len()))
        .map(|did| (*did).clone())
        .collect()
}

/// Which held records this pass re-reads, and where the rotation stopped.
///
/// Two sources, and the order between them is the whole point. The rotation is a guess
/// about who has probably gone stale; a request is a screen that actually needed somebody
/// and could not answer from what is held. So requests go first — the same precedence the
/// frontier gives them among the unread, for the same reason.
///
/// It is also the ONLY thing that reads a faded record again. The rotation covers the full
/// tier, and a faded record is by definition outside it: out there a record is kept because
/// losing somebody is worse than holding a stale address, not because it is being
/// maintained. Somebody asking by name is the one signal that changes that answer, and it
/// is answered once — the request is cleared, and the horizon takes the record back on a
/// later pass unless somebody asks again.
///
/// The cursor comes from the rotation alone. Requests arrive in did order like everything
/// else here, so letting one advance the cursor would step the rotation past whoever sat
/// between, and a record skipped that way is not read again until the cursor comes round.
fn refresh_order(
    wanted: &BTreeMap<String, DirectoryTier>,
    requests: &BTreeSet<String>,
    after: &str,
    budget: usize,
) -> (Vec<String>, String) {
    let asked: BTreeSet<String> = requests
        .iter()
        .filter(|did| wanted.contains_key(*did))
        .take(budget)
        .cloned()
        .collect();
    let rotation = refresh_rotation(wanted, &asked, after, budget - asked.len());
    let cursor = rotation
        .last()
        .cloned()
        .unwrap_or_else(|| after.to_string());
    (asked.into_iter().chain(rotation).collect(), cursor)
}

/// Identities a screen asked for and could not answer from what is held.
///
/// A failed read yields none rather than failing the pass: a request is a hint about
/// ORDER, so losing one costs a few passes of priority and nothing else.
async fn read_requests<N: crate::net::Network>(ctx: &DiscoverContext<N>) -> BTreeSet<String> {
    crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::REQUEST_COLLECTION)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// Drop a request that has been answered.
///
/// Only ever after the record it asked for is written, so a failure between the two leaves
/// the request standing and the next pass tries again. The other way round loses the
/// request on any failure, which is the one outcome that matters here — the person who
/// asked is still looking at a name we could not resolve.
async fn clear_request<N: crate::net::Network>(ctx: &DiscoverContext<N>, did: &str) {
    let _ =
        crate::delete_record(&ctx.doc, ctx.author_id, pin_derive::REQUEST_COLLECTION, did).await;
}

/// Clear a request if there was one, after the record it asked for was written.
///
/// Guarded rather than unconditional: a delete of a key that was never there is still a
/// write, and every write to this doc is announced to every syncing instance and a reason
/// to mirror the whole doc to Sia. The rotation re-reads a few identities every pass and
/// almost none of them were asked for.
async fn answer_request<N: crate::net::Network>(
    ctx: &DiscoverContext<N>,
    requests: &BTreeSet<String>,
    did: &str,
) {
    if requests.contains(did) {
        clear_request(ctx, did).await;
    }
}

/// Read one identity nobody here has looked at yet, and record what came back.
///
/// `None` when it could not be read — asleep, or a relay that didn't answer. They stay on
/// the frontier and come round again, and an inability to read is never turned into a
/// record saying they have nothing.
///
/// Returns what it recorded so the caller can see the edges it revealed, which is what
/// keeps somebody read this pass off the frontier it recomputes later in the same pass.
///
/// Shared by both read phases rather than written twice: the phase that reads what a
/// re-read revealed does the same job, and the order below — record first, clear the
/// request after — is exactly the kind of detail two copies drift on.
async fn read_new<N: crate::net::Network>(
    ctx: &DiscoverContext<N>,
    candidate: &Candidate,
    now_iso: &str,
) -> Option<DirectoryRecord> {
    let resolved = resolve_directory(&ctx.net, &candidate.did).await.ok()?;
    let blob = download_directory_blob(&ctx.net, &candidate.did, &resolved.url)
        .await
        .ok()?;
    let fresh = parse_directory(&blob, &resolved.txt, &resolved.url, now_iso);
    // An invitation to us among this identity's boxes is recorded as we pass: a stranger
    // who invited us is read here or not at all, unless their knock landed.
    crate::membership::take_invitations(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        &ctx.app_key,
        &crate::membership::boxes_in(&blob),
    )
    .await;
    record_directory(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        &candidate.did,
        fresh.clone(),
    )
    .await;
    // After the record, never before: a request cleared on a pass that then failed to
    // write is a person left unresolved with nothing left saying they were asked for.
    if candidate.requested {
        clear_request(ctx, &candidate.did).await;
    }
    Some(fresh)
}

/// Go and read some of the identities this one knows about and has never looked at.
///
/// The only part of discovery that spends anything. Everything else — hop one, and every
/// edge the frontier is derived from — falls out of reads the engagement crawl was making
/// anyway; this is the loop that widens the circle, and it is budgeted because the frontier
/// is unbounded by construction.
pub async fn discover_once<N: crate::net::Network>(
    ctx: &DiscoverContext<N>,
    own_did: &str,
    now_iso: String,
    now_secs: i64,
    resume_after: &str,
) -> Result<(DiscoverOutcome, String), String> {
    let mut outcome = DiscoverOutcome::default();
    let settings = crate::read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;

    let covered = covered_elsewhere(&settings, own_did);
    // `held.edges` is updated as this pass reads, because it stops describing the edge set
    // the moment anything is read and the recompute at the end needs the current one.
    //
    // ONLY that field, and the other two consumers of `held` are why: `wanted_tiers` is taken
    // below before any read, so the tier a record fades by is the one it was ranked at
    // rather than one a mid-pass edge shifted, and `decay_plan` reads tiers and timestamps
    // and never edges at all. Moving either to after the reads would quietly put this
    // pass's own discoveries into what it decides to throw away.
    let mut held = held_edges(ctx).await;
    outcome.held = held.edges.len();
    outcome.unread = held.unread;

    let requests = read_requests(ctx).await;
    outcome.requested = requests.len();

    let candidates = frontier(&covered, &held.edges, &requests);
    outcome.frontier = candidates.len();

    // Two jobs out of one budget, with a reservation rather than a ranking. Reading
    // somebody new and re-reading somebody held are not comparable — one widens the circle
    // and the other keeps it true — so scoring them against each other would let whichever
    // scored higher starve the other outright. A reservation cannot, and what neither uses
    // the other takes.
    let refresh_share = REFRESH_PER_PASS.min(MAX_RESOLVES_PER_PASS);
    let read_now: Vec<&Candidate> = candidates
        .iter()
        .take(MAX_RESOLVES_PER_PASS - refresh_share)
        .collect();
    let wanted = wanted_tiers(&held, &covered);
    let (refresh_now, cursor) = refresh_order(
        &wanted,
        &requests,
        resume_after,
        MAX_RESOLVES_PER_PASS - read_now.len(),
    );

    // What the budget has actually gone on, counted rather than assumed: a resolve is spent
    // whether or not it answered, and both phases below draw from the same allowance.
    let mut spent = 0usize;
    for candidate in read_now {
        spent += 1;
        match read_new(ctx, candidate, &now_iso).await {
            // Held now, so the recompute at the end of this pass does not offer them
            // again — and their own edges widen it, exactly as a re-read's do.
            Some(fresh) => {
                held.edges.insert(candidate.did.clone(), edges_of(&fresh));
                outcome.resolved += 1;
            }
            None => outcome.unreachable += 1,
        }
    }

    // Re-read what is already held, stopping at the pointer wherever nothing has moved.
    // Sia is content-addressed, so an unchanged share URL is proof the bytes are identical
    // rather than a hint — which makes the common case one DHT resolve and no download.
    //
    // Who was actually gone back to, which is what `held` no longer describes. Only the
    // ones read: an identity that could not be reached left its record exactly as the
    // reading above found it.
    let mut reread: BTreeSet<String> = BTreeSet::new();
    // Whether a re-read turned up somebody the frontier above could not have offered. See
    // the recompute below for why that is worth tracking rather than assuming.
    let mut widened = false;
    for did in &refresh_now {
        let Some(record) = read_directory(&ctx.doc, &ctx.blobs, ctx.author_id, did).await else {
            continue;
        };
        spent += 1;
        let Ok(resolved) = resolve_directory(&ctx.net, did).await else {
            outcome.unreachable += 1;
            continue;
        };
        if confirmed_by_pointer(&record, &resolved.url) {
            // Only the packet can have changed, and it is already in hand.
            // `record_directory` compares substance, so an endpoint that has not moved
            // writes nothing at all.
            record_directory(
                &ctx.doc,
                &ctx.blobs,
                ctx.author_id,
                did,
                with_reach(&record, &resolved.txt, &now_iso),
            )
            .await;
            reread.insert(did.clone());
            answer_request(ctx, &requests, did).await;
            outcome.unchanged += 1;
            continue;
        }
        let Ok(blob) = download_directory_blob(&ctx.net, did, &resolved.url).await else {
            outcome.unreachable += 1;
            continue;
        };
        let fresh = parse_directory(&blob, &resolved.txt, &resolved.url, &now_iso);
        crate::membership::take_invitations(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            &ctx.app_key,
            &crate::membership::boxes_in(&blob),
        )
        .await;
        // A new edge only WIDENS anything if it points at somebody neither held nor covered
        // elsewhere, which is the same pair `frontier` itself skips. Asking here is what
        // keeps an unfollow — or a follow of somebody already known — from paying for a
        // re-rank that could only ever find nothing.
        let edges = edges_of(&fresh);
        widened |= edges
            .iter()
            .any(|t| !held.edges.contains_key(t) && !covered.contains(t));
        held.edges.insert(did.clone(), edges);
        record_directory(&ctx.doc, &ctx.blobs, ctx.author_id, did, fresh).await;
        reread.insert(did.clone());
        answer_request(ctx, &requests, did).await;
        outcome.refreshed += 1;
    }

    // Read what the re-reads just revealed, instead of leaving it to the next pass.
    //
    // The frontier above is computed from `held` as it stood at the TOP of this pass, and
    // the re-reads run after it — so an edge learned from one of them cannot appear in it.
    // That made revealing somebody by re-read cost a guaranteed extra full cadence before
    // anything went and read them, every time rather than occasionally, and it is only
    // visible in a log by reading two consecutive passes.
    //
    // Recomputed ONLY when a re-read actually turned somebody up, because ranking the
    // frontier is the expensive part of a pass at scale — ~600ms at 10,000 held — and
    // paying it twice on every pass to catch a widening that usually did not happen is the
    // wrong trade.
    //
    // Ordered, not prepended: the recomputed frontier is read from the top under the same
    // rule as the first phase, so somebody just revealed does not outrank a nearer
    // candidate that was already waiting. Resolve order is scheduling, and recency is not
    // one of its terms.
    if widened {
        let already: BTreeSet<&str> = candidates.iter().map(|c| c.did.as_str()).collect();
        let widened_frontier = frontier(&covered, &held.edges, &requests);
        outcome.revealed = widened_frontier
            .iter()
            .filter(|c| !already.contains(c.did.as_str()))
            .count();
        for candidate in widened_frontier
            .iter()
            .take(MAX_RESOLVES_PER_PASS.saturating_sub(spent))
        {
            match read_new(ctx, candidate, &now_iso).await {
                Some(fresh) => {
                    held.edges.insert(candidate.did.clone(), edges_of(&fresh));
                    outcome.resolved += 1;
                }
                None => outcome.unreachable += 1,
            }
        }
    }

    for (did, tier) in decay_plan(&held, &wanted, &reread, now_secs) {
        let Some(record) = read_directory(&ctx.doc, &ctx.blobs, ctx.author_id, &did).await else {
            continue;
        };
        record_directory(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            &did,
            faded(&record, tier),
        )
        .await;
        outcome.faded += 1;
    }
    Ok((outcome, cursor))
}

/// Pass, wait, repeat — forever.
///
/// Timer-driven, with no wake source, and that is deliberate: every input this reads is a
/// record in this doc, so waking on doc changes would have the loop's own writes wake it —
/// the shape `deliver` calls "a loop feeding itself". Nothing here is latency-sensitive
/// either. Discovery is how the network becomes visible over days, not how a count arrives.
pub async fn run_discover_loop<N: crate::net::Network>(
    ctx: DiscoverContext<N>,
    own_did: String,
    cadence: Duration,
    now_iso: impl Fn() -> String,
    now_secs: impl Fn() -> i64,
    on_pass: impl Fn(Result<DiscoverOutcome, String>),
) -> ! {
    // Where the refresh rotation resumes, kept here rather than in the doc. A last-checked
    // timestamp per record would advance whether or not anything moved, and a field that
    // moves on a timer re-mirrors the whole doc to Sia every time the snapshot loop wakes —
    // which is the instance-heartbeat bug of 2026-08-29. A restart resumes from the top and
    // costs one extra look at whoever sorts first.
    let mut cursor = String::new();
    loop {
        match discover_once(&ctx, &own_did, now_iso(), now_secs(), &cursor).await {
            Ok((outcome, next)) => {
                cursor = next;
                on_pass(Ok(outcome));
            }
            Err(e) => on_pass(Err(e)),
        }
        n0_future::time::sleep(cadence).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> DirectoryRecord {
        DirectoryRecord {
            tier: DirectoryTier::Full,
            profile: Some(serde_json::json!({"username": "alice"})),
            channels: vec![DirectoryChannel {
                channel_id: "chan-one".into(),
                key: "AAAA".into(),
                name: "First".into(),
                show_on_profile: None,
                visibility: None,
            }],
            reach: vec![InstanceAddr {
                node_id: "n1".into(),
                relay: Some("https://relay.example/".into()),
            }],
            follows: vec![serde_json::json!({"didDht": "did:dht:bob", "channelID": "c1"})],
            handle_follows: vec!["did:dht:carol".into()],
            followers: None,
            enc_key: None,
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
                    show_on_profile: None,
                    visibility: None,
                },
                DirectoryChannel {
                    channel_id: "chan-two".into(),
                    key: "BBBB".into(),
                    name: "Second".into(),
                    show_on_profile: None,
                    visibility: None,
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
    fn a_directory_s_encryption_key_is_held_only_when_it_is_one() {
        // Held only when it is a key at all: 32 bytes of base64.
        let none = serde_json::json!({});
        assert_eq!(parse_directory(&none, &[], "sia://x", NOW).enc_key, None);
        let key = pin_crypto::b64_encode(&[7u8; 32]);
        let keyed = serde_json::json!({ "encKey": key });
        assert_eq!(
            parse_directory(&keyed, &[], "sia://x", NOW).enc_key,
            Some(key)
        );
        for bad in [
            serde_json::json!({ "encKey": pin_crypto::b64_encode(&[7u8; 31]) }),
            serde_json::json!({ "encKey": "not base64!" }),
            serde_json::json!({ "encKey": 7 }),
        ] {
            assert_eq!(parse_directory(&bad, &[], "sia://x", NOW).enc_key, None);
        }
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
        assert_eq!(parse_directory(&blob, &[], "sia://x", NOW).followers, None);
        let followed = serde_json::json!({"followers": {"kinds": {"follow": {"count": 2}}}});
        assert_eq!(
            parse_directory(&followed, &[], "sia://x", NOW).followers,
            Some(serde_json::json!({"kinds": {"follow": {"count": 2}}}))
        );

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
    fn an_unmoved_pointer_confirms_a_full_record_without_a_download() {
        let held = record();
        assert!(confirmed_by_pointer(&held, &held.url));
        assert!(!confirmed_by_pointer(&held, "sia://somewhere-else"));
    }

    #[test]
    fn an_unmoved_pointer_confirms_nothing_about_a_faded_record() {
        // The shortcut claims our copy already holds what a download would produce, and a
        // faded copy does not — it dropped the profile and channels on purpose. Confirming
        // one would leave the rotation unable to do the thing it re-reads faded records
        // FOR: read somebody back in full when they come close again.
        for tier in [DirectoryTier::Reduced, DirectoryTier::Minimal] {
            let stripped = faded(&record(), tier);
            assert!(!confirmed_by_pointer(&stripped, &stripped.url));
        }
    }

    fn set(dids: &[&str]) -> BTreeSet<String> {
        dids.iter().map(|d| d.to_string()).collect()
    }

    /// Nobody asked for anything, and nothing was re-read.
    fn none() -> BTreeSet<String> {
        BTreeSet::new()
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
        assert!(f[0].requested);
    }

    #[test]
    fn somebody_asked_for_that_nobody_points_at_is_still_a_candidate() {
        // A pasted link, or a knock from outside the graph. Nothing in the graph names
        // them, and the request is the whole reason they are worth reading.
        let f = frontier(&set(&["alice"]), &graph(&[]), &set(&["stranger"]));
        assert_eq!(dids(&f), ["stranger"]);
        assert!(f[0].requested);
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

    /// Epoch seconds, and an ISO stamp for a record last changed `days` ago.
    fn aged(days: i64) -> (String, i64) {
        let now = 1_800_000_000_i64;
        let then = now - days * 24 * 60 * 60;
        (
            chrono::DateTime::from_timestamp(then, 0)
                .unwrap()
                .to_rfc3339(),
            now,
        )
    }

    /// A held set as one pass read it: who points at whom, how much of each is kept, when
    /// each last changed, and how many were listed and unreadable.
    fn holding(
        edges: &[(&str, &[&str])],
        tier: DirectoryTier,
        days_old: i64,
        unread: usize,
    ) -> (Held, i64) {
        let (seen, now) = aged(days_old);
        let e = graph(edges);
        (
            Held {
                seen_at: e.keys().map(|d| (d.clone(), seen.clone())).collect(),
                tier: e.keys().map(|d| (d.clone(), tier)).collect(),
                edges: e,
                unread,
            },
            now,
        )
    }

    fn want(pairs: &[(&str, DirectoryTier)]) -> BTreeMap<String, DirectoryTier> {
        pairs.iter().map(|(d, t)| (d.to_string(), *t)).collect()
    }

    fn plan_of(plan: &[(String, DirectoryTier)]) -> Vec<(&str, DirectoryTier)> {
        plan.iter().map(|(d, t)| (d.as_str(), *t)).collect()
    }

    #[test]
    fn a_partial_reading_fades_nothing_at_all() {
        // THE guard. Decay acts on how far away somebody is, and one record that would not
        // open hides every edge it carried — so whole branches look unreachable. A pass
        // that could not read everything does not get to decide who is far away.
        let (held, now) = holding(&[("alice", &[])], DirectoryTier::Full, 400, 1);
        let wanted = want(&[("alice", DirectoryTier::Minimal)]);
        assert!(decay_plan(&held, &wanted, &none(), now).is_empty());

        // The same reading, complete: now it is a fact about the graph and the record fades.
        let (whole, now) = holding(&[("alice", &[])], DirectoryTier::Full, 400, 0);
        assert_eq!(
            plan_of(&decay_plan(&whole, &wanted, &none(), now)),
            [("alice", DirectoryTier::Minimal)]
        );
    }

    #[test]
    fn nothing_fades_before_it_has_had_time_to() {
        // So a burst of new reads is not immediately undone, and so an identity that keeps
        // publishing keeps its place: `seen_at` moves when their substance moves.
        let (held, now) = holding(&[("alice", &[])], DirectoryTier::Full, 1, 0);
        let wanted = want(&[("alice", DirectoryTier::Reduced)]);
        assert!(decay_plan(&held, &wanted, &none(), now).is_empty());
    }

    #[test]
    fn fading_only_ever_goes_downward() {
        // Coming back within the horizon is handled by READING them again, not by a plan
        // that promotes a record to a tier whose fields we no longer hold — which would
        // mint a full record with an empty profile and call it current.
        let (held, now) = holding(&[("alice", &[])], DirectoryTier::Minimal, 400, 0);
        let wanted = want(&[("alice", DirectoryTier::Full)]);
        assert!(decay_plan(&held, &wanted, &none(), now).is_empty());
    }

    #[test]
    fn a_timestamp_we_cannot_read_is_never_a_reason_to_discard() {
        // Unknown must not become a decision to throw something away. `repack` reads an
        // unparseable timestamp as very old and that is right THERE, where being wrong
        // costs one redundant repack; here it would drop what is known about somebody on
        // the strength of a field we could not parse.
        let (_, now) = aged(400);
        let held = Held {
            seen_at: [("alice".to_string(), "not a timestamp".to_string())]
                .into_iter()
                .collect(),
            tier: [("alice".to_string(), DirectoryTier::Full)]
                .into_iter()
                .collect(),
            edges: graph(&[("alice", &[])]),
            unread: 0,
        };
        let wanted = want(&[("alice", DirectoryTier::Minimal)]);
        assert!(decay_plan(&held, &wanted, &none(), now).is_empty());
    }

    #[test]
    fn somebody_this_identity_follows_never_fades() {
        // Followed directly, so the engagement crawl keeps them current and their record is
        // not this loop's to thin out — however far the graph happens to place them.
        let (held, _) = holding(&[("mine", &[]), ("far", &[])], DirectoryTier::Full, 400, 0);
        let wanted = wanted_tiers(&held, &set(&["mine"]));
        assert_eq!(wanted["mine"], DirectoryTier::Full);
    }

    #[test]
    fn what_fades_is_what_gets_re_read_when_it_comes_back() {
        // The two consumers of one ranking. A record the ranking wants FULL is in the
        // rotation whatever it currently is, so a faded identity that comes close again is
        // read back whole — and computing the boundary twice would let it fade on one pass
        // and be re-read on the next, forever.
        let wanted = want(&[
            ("near", DirectoryTier::Full),
            ("far", DirectoryTier::Minimal),
        ]);
        assert_eq!(refresh_rotation(&wanted, &none(), "", 8), ["near"]);
    }

    #[test]
    fn the_rotation_resumes_where_the_last_pass_stopped() {
        // Round-robin rather than a last-checked timestamp, because a timestamp advancing
        // on every check is a field moving on a timer — which re-mirrors the whole doc to
        // Sia on the snapshot's next wake.
        let wanted = want(&[
            ("a", DirectoryTier::Full),
            ("b", DirectoryTier::Full),
            ("c", DirectoryTier::Full),
            ("d", DirectoryTier::Full),
        ]);

        assert_eq!(refresh_rotation(&wanted, &none(), "", 2), ["a", "b"]);
        assert_eq!(refresh_rotation(&wanted, &none(), "b", 2), ["c", "d"]);
        // And wraps, so the last of them is followed by the first rather than by nothing.
        assert_eq!(refresh_rotation(&wanted, &none(), "d", 2), ["a", "b"]);
    }

    #[test]
    fn the_rotation_never_offers_the_same_identity_twice_in_one_pass() {
        // Wrapping is what makes that possible: with fewer held than budget, chaining the
        // list to itself hands the pass the same did more than once and spends the budget
        // re-reading one person.
        let wanted = want(&[("a", DirectoryTier::Full), ("b", DirectoryTier::Full)]);
        let rotation = refresh_rotation(&wanted, &none(), "", 8);
        assert_eq!(rotation.len(), 2);
        assert_eq!(rotation.iter().collect::<BTreeSet<_>>().len(), 2);
    }

    #[test]
    fn somebody_asked_for_is_re_read_before_the_rotation() {
        // The same precedence the frontier gives a request among the unread, for the same
        // reason: the rotation is a guess about who has gone stale, and a request is a
        // screen that actually needed somebody and could not answer.
        let wanted = want(&[
            ("a", DirectoryTier::Full),
            ("b", DirectoryTier::Full),
            ("c", DirectoryTier::Full),
        ]);
        let (order, _) = refresh_order(&wanted, &set(&["c"]), "", 2);
        assert_eq!(order, ["c", "a"]);
    }

    #[test]
    fn somebody_asked_for_is_re_read_however_far_they_have_faded() {
        // The only thing that reads a faded record again. The rotation covers the full
        // tier and a faded record is outside it by definition — out there a record is kept
        // because losing somebody is worse than holding a stale address, not because it is
        // being maintained. Somebody asking by name is what changes that answer.
        let wanted = want(&[
            ("near", DirectoryTier::Full),
            ("gone", DirectoryTier::Minimal),
        ]);
        let (order, _) = refresh_order(&wanted, &set(&["gone"]), "", 8);
        assert_eq!(order, ["gone", "near"]);
    }

    #[test]
    fn a_request_for_somebody_unheld_is_left_to_the_frontier() {
        // Requests are read by both halves of the pass. This one names nobody held, so it
        // is the frontier's to answer by going and reading them — spending a refresh on a
        // did with no record would resolve somebody and then take the branch that reads
        // what is held, which is nothing.
        let wanted = want(&[("a", DirectoryTier::Full)]);
        let (order, _) = refresh_order(&wanted, &set(&["stranger"]), "", 8);
        assert_eq!(order, ["a"]);
    }

    #[test]
    fn a_request_does_not_step_the_rotation_past_anybody() {
        // The cursor comes from the rotation alone. Requests arrive in did order like
        // everything else, so letting one advance it would skip whoever sat between — and
        // a record skipped that way is not read again until the cursor comes round.
        let wanted = want(&[
            ("a", DirectoryTier::Full),
            ("b", DirectoryTier::Full),
            ("c", DirectoryTier::Full),
        ]);
        // A pass whose whole share went to requests moves the cursor nowhere, which is
        // where the two spellings of "last" part company: with a rotation behind them the
        // requests are in front and invisible to it either way.
        let (order, cursor) = refresh_order(&wanted, &set(&["c"]), "", 1);
        assert_eq!(order, ["c"]);
        assert_eq!(cursor, "");

        // So the rotation resumes at "a" rather than at "c", which would have jumped both
        // of the two identities nobody asked about.
        let (next, _) = refresh_order(&wanted, &none(), &cursor, 1);
        assert_eq!(next, ["a"]);
    }

    #[test]
    fn somebody_asked_for_is_offered_once_however_the_rotation_falls() {
        // A requested identity in the full tier is in both pools. Handing the pass the
        // same did twice spends two of its eight resolves on one person.
        let wanted = want(&[("a", DirectoryTier::Full), ("b", DirectoryTier::Full)]);
        let (order, _) = refresh_order(&wanted, &set(&["a"]), "", 8);
        assert_eq!(order, ["a", "b"]);
    }

    #[test]
    fn a_record_re_read_this_pass_does_not_fade_on_it() {
        // `held` was taken before the pass spent its budget, so for anybody gone back to
        // since it describes a record that no longer exists. Without this a requested
        // identity is read back in full and faded again before the pass ends — the read
        // spent to leave nothing behind, and the request cleared saying it was answered.
        let (held, now) = holding(&[("far", &[])], DirectoryTier::Full, 30, 0);
        let wanted = want(&[("far", DirectoryTier::Reduced)]);

        assert_eq!(
            plan_of(&decay_plan(&held, &wanted, &none(), now)),
            [("far", DirectoryTier::Reduced)]
        );
        assert!(decay_plan(&held, &wanted, &set(&["far"]), now).is_empty());
    }

    #[test]
    fn a_faded_record_keeps_the_way_back_to_whoever_it_names() {
        // The floor, and the reason nothing is deleted. What survives every tier is where
        // they were last reachable and the pointer that says whether anything has moved —
        // so a faded identity can always be read again, and the graph never loses a person
        // outright, only what they looked like.
        let full = record();

        let mut full = full;
        full.followers = Some(serde_json::json!({"kinds": {"follow": {"count": 3}}}));
        full.enc_key = Some(pin_crypto::b64_encode(&[7u8; 32]));
        let reduced = faded(&full, DirectoryTier::Reduced);
        assert_eq!(reduced.tier, DirectoryTier::Reduced);
        assert_eq!(reduced.profile, None);
        assert!(reduced.channels.is_empty());
        // A count describes them, like the profile does, and goes with it.
        assert_eq!(reduced.followers, None);
        // Edges survive a step, so distance still propagates and the horizon fades rather
        // than cutting.
        assert_eq!(reduced.follows, full.follows);
        assert_eq!(reduced.reach, full.reach);
        assert_eq!(reduced.url, full.url);

        let minimal = faded(&full, DirectoryTier::Minimal);
        assert!(minimal.follows.is_empty());
        assert!(minimal.handle_follows.is_empty());
        assert_eq!(minimal.reach, full.reach);
        // The key to seal to them is kept with the way to reach them: what is lost by fading
        // is what they looked like, never how to get back to them.
        assert_eq!(minimal.enc_key, full.enc_key);
        assert_eq!(minimal.url, full.url);
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
                        show_on_profile: None,
                        visibility: None,
                    })
                }),
            ),
            (
                "encryption key",
                Box::new(|r: &mut DirectoryRecord| {
                    r.enc_key = Some(pin_crypto::b64_encode(&[8u8; 32]))
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
                "tier",
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
