//! Find the identity's other instances and sync with them — the loop that keeps two
//! replicas of ONE identity in parity, with no ticket copied by hand.
//!
//! SYMMETRIC. Every open instance is a full peer: it advertises its own coordinates AND
//! syncs to whatever it finds. The only differences are physics — a desktop is always-on
//! and durable, a tab isn't — and those show up as a flag on a directory entry, not as a
//! role. There is deliberately no host and no client here.
//!
//! Two layers, because one pkarr packet (~1000 B) cannot hold several DocTickets:
//!
//!   - a DIRECTORY under the identity's rendezvous key: one small entry per live
//!     instance, no ticket, so it fits.
//!   - each instance's full TICKET under a key of its own, salted by its node id.
//!
//! Advertising is ADDITIVE: an instance publishes its own ticket, then reads the
//! directory and upserts only its own entry. So a thin tab never erases the durable
//! desktop's coordinates — the same shape as the identity record, and for the same
//! reason.
//!
//! THE KEY IS PRIVATE. The rendezvous seed is AppKey-derived, so only your own instances
//! can compute where to meet. That is what makes it safe to publish a WRITE ticket here:
//! every instance of one identity already holds that capability, so the ticket carries
//! nothing but where to reach this one.
//!
//! WHY PKARR AT ALL, given the doc already records instances (see `instance`): because
//! the registry cannot bootstrap itself. Reading it needs the doc, and getting the doc
//! needs a peer — so first contact has to come from somewhere outside, and this is it.
//! What the registry gives is the durable path AFTER first contact.
//!
//! A STALE READ IS USUALLY GOOD ENOUGH. A browser resolves through relays that lag the
//! DHT, so the ticket it finds may be a session old. But a ticket names a node id and a
//! home relay, and on a device with a persisted node key both are stable across
//! restarts — only the direct addresses rot, and those are the part iroh re-learns once
//! a connection exists. Dialing a slightly stale ticket usually still opens the door,
//! and once it does the doc carries the truth.

use std::collections::HashSet;
use std::str::FromStr as _;
use std::time::Duration;

use iroh_docs::{
    api::{
        protocol::{AddrInfoOptions, ShareMode},
        Doc,
    },
    DocTicket,
};

/// TXT name prefixes: the directory (under the rendezvous key) and one instance's
/// ticket (under its own key). A contract with anything else that reads this record.
const DIR_PREFIX: &str = "_rzd";
const TICKET_PREFIX: &str = "_rzt";

/// How long a directory entry counts as live. A closed tab stops refreshing and ages
/// out; the refresh cadence has to be comfortably under this.
pub const ENTRY_TTL_SECS: u64 = 15 * 60;

/// Everything a pass needs, gathered by whichever engine is running it.
pub struct RendezvousContext {
    /// This identity's doc: shared to make a ticket, and synced when a peer is found.
    pub doc: Doc,
    /// The Sia AppKey — the rendezvous key derives from it, which is what makes the
    /// meeting point private to your own instances.
    pub app_key: [u8; 32],
    /// This instance's iroh node id: the public salt for its own ticket key, and the id
    /// its directory entry is keyed by.
    ///
    /// The node id rather than a fresh random id per launch, so this instance has ONE
    /// name across the doc's registry and the rendezvous. It also makes a stale read
    /// more useful: a device with a persisted node key republishes essentially the same
    /// ticket every session, so last session's copy still names the right node.
    pub instance_id: String,
    /// Whether this instance is always-on. Recorded so a peer choosing among endpoints
    /// can prefer the one that will still be there.
    pub durable: bool,
}

/// What one pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RendezvousOutcome {
    /// Whether this instance's coordinates were published this pass.
    pub advertised: bool,
    /// Live peers in the directory, excluding this instance.
    pub peers: usize,
    /// Peers whose ticket resolved and whose sync was started this pass.
    pub reached: usize,
    /// Peers being synced with, including any reached earlier.
    pub syncing: usize,
    /// Live peers whose ticket didn't resolve. Ordinary: a directory entry outlives a
    /// ticket's propagation, and the next pass retries.
    pub unreachable: usize,
}

/// One instance's directory entry.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    /// Epoch seconds of the last refresh.
    pub at: u64,
    #[serde(default)]
    pub durable: bool,
}

/// The directory record's stored shape. Versioned because it is published where a
/// differently-aged instance of this app will read it.
#[derive(serde::Serialize, serde::Deserialize)]
struct Directory {
    v: u8,
    instances: Vec<Entry>,
}

// ── Pure directory logic ────────────────────────────────────────────────────

/// Upsert `mine` into the directory, dropping entries that have aged out.
///
/// Mine replaces my own prior entry rather than joining it, and everyone else's is
/// carried through untouched — which is the whole point: a pass rewrites one entry, not
/// the record.
pub fn merge_directory(
    existing: Vec<Entry>,
    mine: Entry,
    now_secs: u64,
    ttl_secs: u64,
) -> Vec<Entry> {
    let mut kept: Vec<Entry> = existing
        .into_iter()
        .filter(|e| e.id != mine.id && is_live(e, now_secs, ttl_secs))
        .collect();
    kept.push(mine);
    kept
}

/// Peers worth trying, best first: live, not me, always-on ahead of the rest and newer
/// ahead of older.
pub fn pick_peers(dir: &[Entry], my_id: &str, now_secs: u64, ttl_secs: u64) -> Vec<Entry> {
    let mut peers: Vec<Entry> = dir
        .iter()
        .filter(|e| e.id != my_id && is_live(e, now_secs, ttl_secs))
        .cloned()
        .collect();
    peers.sort_by(|a, b| {
        b.durable
            .cmp(&a.durable)
            .then(b.at.cmp(&a.at))
            .then(a.id.cmp(&b.id))
    });
    peers
}

/// Saturating, because two of your own devices need not agree on the clock: an entry
/// stamped slightly in our future must not underflow into "ancient".
fn is_live(entry: &Entry, now_secs: u64, ttl_secs: u64) -> bool {
    now_secs.saturating_sub(entry.at) < ttl_secs
}

/// Read a directory record, tolerating anything malformed as empty.
///
/// A directory we can't parse means we advertise into a fresh one, which loses other
/// instances' entries — they re-add themselves within a cadence. Refusing to advertise
/// would cost more: this instance would stay invisible until someone else fixed the
/// record.
pub fn parse_directory(json: &str) -> Vec<Entry> {
    if json.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Directory>(json)
        .map(|d| d.instances)
        .unwrap_or_default()
}

// ── I/O ─────────────────────────────────────────────────────────────────────

/// Publish this instance's ticket, then upsert its entry into the directory.
async fn advertise(
    ctx: &RendezvousContext,
    rv_seed: &[u8; 32],
    now_secs: u64,
) -> Result<Vec<Entry>, String> {
    // The ticket first: an entry pointing at a ticket that isn't published yet is an
    // invitation to dial nothing.
    let ticket = ctx
        .doc
        .share(ShareMode::Write, AddrInfoOptions::RelayAndAddresses)
        .await
        .map_err(|e| format!("share: {e}"))?;
    let inst_seed = pin_derive::rendezvous_instance_seed(rv_seed, &ctx.instance_id);
    pin_pkarr::publish(
        &inst_seed,
        &pin_pkarr::chunk_txt(TICKET_PREFIX, &ticket.to_string()),
    )
    .await?;

    let existing = read_directory(rv_seed).await;
    let merged = merge_directory(
        existing,
        Entry {
            id: ctx.instance_id.clone(),
            at: now_secs,
            durable: ctx.durable,
        },
        now_secs,
        ENTRY_TTL_SECS,
    );
    let json = serde_json::to_string(&Directory {
        v: 1,
        instances: merged.clone(),
    })
    .map_err(|e| format!("encode directory: {e}"))?;
    pin_pkarr::publish(rv_seed, &pin_pkarr::chunk_txt(DIR_PREFIX, &json)).await?;

    Ok(merged)
}

/// The directory as currently published, or empty when it can't be read.
async fn read_directory(rv_seed: &[u8; 32]) -> Vec<Entry> {
    let Ok(public_key) = pin_pkarr::public_key_from_seed(rv_seed) else {
        return Vec::new();
    };
    let Ok(records) = pin_pkarr::resolve(&public_key).await else {
        return Vec::new();
    };
    parse_directory(&pin_pkarr::rejoin_txt(&records, DIR_PREFIX))
}

/// Resolve one peer's ticket, or `None` when it isn't there yet.
async fn peer_ticket(rv_seed: &[u8; 32], peer_id: &str) -> Option<DocTicket> {
    let inst_seed = pin_derive::rendezvous_instance_seed(rv_seed, peer_id);
    let public_key = pin_pkarr::public_key_from_seed(&inst_seed).ok()?;
    let records = pin_pkarr::resolve(&public_key).await.ok()?;
    let raw = pin_pkarr::rejoin_txt(&records, TICKET_PREFIX);
    if raw.is_empty() {
        return None;
    }
    DocTicket::from_str(&raw).ok()
}

/// One pass: advertise, then start syncing with any live peer not already reached.
///
/// `reached` is the loop's memory of who it has already dialed, so a peer is only
/// started once. It keeps looking, though, rather than stopping at the first success —
/// a second device coming online an hour later should be picked up, and adding it to an
/// existing sync costs nothing.
pub async fn rendezvous_once(
    ctx: &RendezvousContext,
    reached: &mut HashSet<String>,
    now_secs: u64,
) -> Result<RendezvousOutcome, String> {
    let mut outcome = RendezvousOutcome::default();
    let rv_seed = pin_derive::rendezvous_seed(&ctx.app_key);

    // A failure to advertise must not stop us connecting: being findable and finding
    // are independent, and the pass is worth more with one of them than neither.
    let dir = match advertise(ctx, &rv_seed, now_secs).await {
        Ok(dir) => {
            outcome.advertised = true;
            dir
        }
        Err(_) => read_directory(&rv_seed).await,
    };

    let peers = pick_peers(&dir, &ctx.instance_id, now_secs, ENTRY_TTL_SECS);
    outcome.peers = peers.len();

    for peer in peers {
        if reached.contains(&peer.id) {
            continue;
        }
        let Some(ticket) = peer_ticket(&rv_seed, &peer.id).await else {
            outcome.unreachable += 1;
            continue;
        };
        match ctx.doc.start_sync(ticket.nodes).await {
            Ok(_) => {
                reached.insert(peer.id);
                outcome.reached += 1;
            }
            // Worth retrying next pass rather than remembering: the peer is live and
            // advertising, so the failure is about right now.
            Err(_) => outcome.unreachable += 1,
        }
    }

    outcome.syncing = reached.len();
    Ok(outcome)
}

/// Pass, wait, repeat — forever.
///
/// Two cadences: `cadence` once this instance is advertised and has a peer, `retry`
/// while it has neither. Advertising has to repeat regardless (a directory entry ages
/// out, and a ticket minted before this node reached a relay is undialable), so the slow
/// cadence is set by the TTL; the fast one exists so a device that comes online seconds
/// after us isn't waited out.
///
/// Returned rather than spawned, for the same reason the other loops are: the caller
/// owns the executor, and that placement is the one genuine difference between running
/// this natively and running it in a tab.
///
/// The clock comes from the caller because `SystemTime::now()` panics on
/// wasm32-unknown-unknown.
pub async fn run_rendezvous_loop(
    ctx: RendezvousContext,
    cadence: Duration,
    retry: Duration,
    now_secs: impl Fn() -> u64,
    on_pass: impl Fn(Result<RendezvousOutcome, String>),
) -> ! {
    let mut reached: HashSet<String> = HashSet::new();
    loop {
        let result = rendezvous_once(&ctx, &mut reached, now_secs()).await;
        // Come back sooner while there is nobody to sync with — either because no other
        // instance is up yet, or because one is and we haven't reached it.
        let wait = match &result {
            Ok(o) if o.advertised && o.syncing > 0 => cadence,
            _ => retry,
        };
        on_pass(result);
        n0_future::time::sleep(wait).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, at: u64, durable: bool) -> Entry {
        Entry {
            id: id.into(),
            at,
            durable,
        }
    }

    const NOW: u64 = 1_000_000;

    #[test]
    fn advertising_replaces_my_entry_and_leaves_everyone_elses() {
        // The bug this shape exists to prevent: a whole-record write from one instance
        // erasing another's coordinates. A pass touches exactly one entry.
        let dir = vec![
            entry("desktop", NOW - 60, true),
            entry("tab", NOW - 10, false),
        ];
        let merged = merge_directory(dir, entry("tab", NOW, false), NOW, ENTRY_TTL_SECS);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|e| e.id == "desktop" && e.at == NOW - 60));
        assert_eq!(merged.iter().filter(|e| e.id == "tab").count(), 1);
        assert!(merged.iter().any(|e| e.id == "tab" && e.at == NOW));
    }

    #[test]
    fn an_instance_that_stopped_refreshing_ages_out() {
        // A closed tab can't remove its own entry, so the only way it leaves is by
        // going stale — otherwise the directory grows with every device ever opened.
        let dir = vec![
            entry("gone", NOW - ENTRY_TTL_SECS - 1, false),
            entry("here", NOW - 30, false),
        ];
        let merged = merge_directory(dir, entry("me", NOW, false), NOW, ENTRY_TTL_SECS);
        let ids: Vec<&str> = merged.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["here", "me"]);
    }

    #[test]
    fn a_clock_a_little_ahead_of_ours_is_still_live() {
        // Two of your own devices need not agree on the time, and an entry stamped in
        // our future must not underflow into "ancient" and get pruned.
        let dir = vec![entry("ahead", NOW + 500, false)];
        assert_eq!(pick_peers(&dir, "me", NOW, ENTRY_TTL_SECS).len(), 1);
    }

    #[test]
    fn always_on_peers_are_tried_first() {
        // A tab should reach for the desktop before another tab: it's the instance most
        // likely to be there, and the one holding the durable replica.
        let dir = vec![
            entry("tab", NOW - 1, false),
            entry("desktop", NOW - 600, true),
        ];
        let ids: Vec<String> = pick_peers(&dir, "me", NOW, ENTRY_TTL_SECS)
            .into_iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(ids, vec!["desktop", "tab"]);
    }

    #[test]
    fn i_am_never_my_own_peer() {
        let dir = vec![entry("me", NOW, true), entry("other", NOW, false)];
        let ids: Vec<String> = pick_peers(&dir, "me", NOW, ENTRY_TTL_SECS)
            .into_iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(ids, vec!["other"]);
    }

    #[test]
    fn the_stored_shape_is_the_one_already_published() {
        // This record is read by instances of a different age than the one writing it,
        // so its field names and version are a contract — `{v, instances:[{id,at,
        // durable}]}`, exactly what lib/rendezvous.ts published.
        let json = serde_json::to_string(&Directory {
            v: 1,
            instances: vec![entry("abc", 42, true)],
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"v":1,"instances":[{"id":"abc","at":42,"durable":true}]}"#
        );
        assert_eq!(parse_directory(&json), vec![entry("abc", 42, true)]);
    }

    #[test]
    fn an_unreadable_directory_reads_as_empty_rather_than_failing() {
        // Advertising into a fresh directory costs the other entries, and they come
        // back within a cadence. Refusing to advertise would keep this instance
        // invisible until something else repaired the record.
        assert!(parse_directory("").is_empty());
        assert!(parse_directory("not json").is_empty());
        assert!(parse_directory(r#"{"v":1}"#).is_empty());
    }

    #[test]
    fn a_chunked_directory_survives_the_round_trip() {
        // Enough instances to exceed one TXT string, which is the reason the record is
        // chunked at all.
        let instances: Vec<Entry> = (0..20)
            .map(|i| entry(&format!("node-{i:032}"), NOW, i % 2 == 0))
            .collect();
        let json = serde_json::to_string(&Directory {
            v: 1,
            instances: instances.clone(),
        })
        .unwrap();
        assert!(json.len() > 255);
        let records = pin_pkarr::chunk_txt(DIR_PREFIX, &json);
        assert!(records.len() > 1);
        assert_eq!(
            parse_directory(&pin_pkarr::rejoin_txt(&records, DIR_PREFIX)),
            instances
        );
    }
}
