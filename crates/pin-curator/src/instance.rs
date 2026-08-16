//! Register this instance's dial coordinates in the doc, and read back the live set.
//!
//! An identity is one DID reachable at as many endpoints as it has devices: the node
//! key is minted per device and never travels (06-22's recovery taxonomy — the DID is
//! the identity, each device is a different endpoint advertised under it). So the
//! answer to "where can I be dialed" is a SET, and it is the one genuinely per-instance
//! thing in an identity's public record.
//!
//! That set is why the identity record used to get clobbered. Two writers each knew
//! only their own coordinates and each published a whole packet, so whichever went
//! last erased the other. Keeping the set in the doc — which every instance of one
//! identity already syncs — means any instance can publish ALL of them, and the
//! conflict stops existing rather than being arbitrated.
//!
//! Records are PLAINTEXT, deliberately, and it's the one place in this doc that is.
//! The rkey is the node id, and record keys aren't encrypted, so the ids are in the
//! doc's key space either way; the value is a heartbeat and a durability flag whose
//! whole purpose is to be published on the DHT. Encrypting what you are about to
//! broadcast protects nothing and would only suggest it were secret.
//!
//! A registration carries an ADDRESS, not just an id, and that is what keeps dialing off
//! iroh's own discovery service. A node id names an endpoint without locating one, so
//! dialing a bare id falls through to `presets::N0`'s lookup — n0's `dns.iroh.link`, a
//! deliberately central store (their docs: "it does not interact with the Mainline DHT").
//! Publishing the relay URL ourselves means a peer dials from a record it already
//! resolved, which is what every other path here does: channelsync and rendezvous both
//! hand `start_sync` the addresses out of a DocTicket, and iroh-docs stashes those in its
//! own `MemoryLookup` before dialing by id.
//!
//! The RELAY URL only, not the whole address. Direct addresses rot between sessions while
//! a home relay is stable, and the relay is enough to open a connection — iroh upgrades to
//! a direct path itself once one exists. It is also exactly what n0's own publisher
//! publishes (`AddrFilter::relay_only()`), so it is the half known to be sufficient.

use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_derive::{record_key, INSTANCE_COLLECTION};

use crate::read_record;

/// How long an instance's registration counts as current.
///
/// A closed tab stops refreshing and ages out; an always-on desktop keeps its entry
/// alive. Generous relative to the refresh cadence so a missed pass — or a clock a
/// little out of step between two of your own devices — doesn't drop a live instance
/// from your published coordinates.
pub const INSTANCE_TTL_SECS: u64 = 60 * 60;

/// Everything registering an instance needs.
pub struct InstanceContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// This instance's iroh node id — the rkey it registers under, and what peers
    /// eventually dial.
    pub node_id: String,
    /// Whether this instance is always-on (a desktop) rather than tab-lifetime.
    /// Recorded rather than acted on here; it's for whoever chooses among endpoints.
    pub durable: bool,
}

/// One instance's dial coordinates: who to dial, and where they can be reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceAddr {
    pub node_id: String,
    /// The home relay this instance is reachable through, when it has one.
    ///
    /// Absent means the endpoint had none to report when it last registered — it names
    /// itself without saying where it is, so reaching it needs a lookup from somewhere
    /// else. Ordinary right after a bind and expected to fill in on the next pass.
    pub relay: Option<String>,
}

/// Separators for the published endpoint list.
///
/// Neither can appear in what they join: a node id is base32, and `|` is not a legal
/// character in a URL host and is percent-encoded anywhere else in one.
const FIELD_SEP: char = '|';
const ENTRY_SEP: char = ',';

/// The endpoint set as one value, for the `_iroh` record.
///
/// One value rather than a record each, so the existing chunking carries it and the
/// prefix keeps a single meaning.
pub fn encode_endpoints(addrs: &[InstanceAddr]) -> String {
    addrs
        .iter()
        .map(|a| match &a.relay {
            Some(relay) => format!("{}{FIELD_SEP}{relay}", a.node_id),
            None => a.node_id.clone(),
        })
        .collect::<Vec<_>>()
        .join(&ENTRY_SEP.to_string())
}

/// Read a published endpoint set back.
///
/// An entry with no address is kept rather than dropped — it still names an endpoint,
/// and whether that is dialable is the caller's question, not this one's. Empty entries
/// are skipped so a trailing separator or an empty record doesn't produce an endpoint
/// with no id at all.
pub fn parse_endpoints(value: &str) -> Vec<InstanceAddr> {
    value
        .split(ENTRY_SEP)
        .filter_map(|entry| {
            let (node_id, relay) = match entry.split_once(FIELD_SEP) {
                Some((id, relay)) if !relay.is_empty() => (id, Some(relay.to_string())),
                Some((id, _)) => (id, None),
                None => (entry, None),
            };
            (!node_id.is_empty()).then(|| InstanceAddr {
                node_id: node_id.to_string(),
                relay,
            })
        })
        .collect()
}

/// Which relay URL to register this pass.
///
/// A freshly-seen one always wins. When this pass can't see one, the address already
/// registered is KEPT rather than overwritten with nothing: an endpoint takes a moment to
/// reach its home relay after binding, so the first pass after a start routinely has
/// nothing to report, and the cadence is long enough that publishing an endpoint with no
/// address on the strength of that would leave it unreachable for the whole interval.
fn relay_to_register(fresh: Option<String>, held: Option<String>) -> Option<String> {
    fresh.or(held)
}

/// What one registration pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct InstanceOutcome {
    /// Instances currently registered and live, including this one.
    pub live: usize,
    /// Registrations dropped for having aged out.
    pub pruned: usize,
}

/// One instance's registration, as stored.
#[derive(serde::Serialize, serde::Deserialize)]
struct Registration {
    /// Epoch seconds of the last refresh.
    at: u64,
    #[serde(default)]
    durable: bool,
    /// The home relay this instance is reachable through. Absent on a registration
    /// written before addresses were recorded, and on one written before the endpoint
    /// reached a relay — both read as "named but not located".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relay: Option<String>,
}

/// Record that this instance is here and reachable, and forget the ones that aren't.
///
/// `now_secs` and `relay` are both passed in rather than read: `SystemTime::now()` panics
/// on wasm32-unknown-unknown so the clock belongs to the caller, and the relay is read per
/// pass rather than captured at construction because an endpoint reaches its home relay
/// some time after it binds.
pub async fn register_instance(
    ctx: &InstanceContext,
    now_secs: u64,
    relay: Option<String>,
) -> Result<InstanceOutcome, String> {
    let held = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        INSTANCE_COLLECTION,
        &ctx.node_id,
    )
    .await
    .ok()
    .flatten()
    .and_then(|raw| serde_json::from_slice::<Registration>(&raw).ok());

    let mine = Registration {
        at: now_secs,
        durable: ctx.durable,
        relay: relay_to_register(relay, held.and_then(|h| h.relay)),
    };
    let value = serde_json::to_vec(&mine).map_err(|e| format!("encode registration: {e}"))?;
    ctx.doc
        .set_bytes(
            ctx.author_id,
            record_key(INSTANCE_COLLECTION, &ctx.node_id),
            value,
        )
        .await
        .map_err(|e| format!("register instance: {e}"))?;

    let all = read_registrations(&ctx.doc, &ctx.blobs, ctx.author_id).await;
    let mut outcome = InstanceOutcome::default();
    for (node_id, reg) in all {
        // Saturating, because a clock that runs behind another device's would
        // otherwise wrap and prune a live instance.
        if now_secs.saturating_sub(reg.at) < INSTANCE_TTL_SECS {
            outcome.live += 1;
            continue;
        }
        // A pruned instance re-registers within a cadence if it's still running, so
        // dropping one costs nothing and keeps the published packet from growing with
        // every device the identity has ever been signed in on.
        if ctx
            .doc
            .del(ctx.author_id, record_key(INSTANCE_COLLECTION, &node_id))
            .await
            .is_ok()
        {
            outcome.pruned += 1;
        }
    }
    Ok(outcome)
}

/// The dial coordinates of every instance whose registration is still current, newest
/// first.
///
/// Durable instances sort ahead of the rest at equal freshness, so a caller that has to
/// truncate keeps the always-on endpoints — the ones a peer is most likely to reach.
pub async fn live_instances(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    now_secs: u64,
) -> Vec<InstanceAddr> {
    let mut live: Vec<(String, Registration)> = read_registrations(doc, blobs, author_id)
        .await
        .into_iter()
        .filter(|(_, r)| now_secs.saturating_sub(r.at) < INSTANCE_TTL_SECS)
        .collect();
    live.sort_by(|a, b| {
        b.1.durable
            .cmp(&a.1.durable)
            .then(b.1.at.cmp(&a.1.at))
            .then(a.0.cmp(&b.0))
    });
    live.into_iter()
        .map(|(node_id, reg)| InstanceAddr {
            node_id,
            relay: reg.relay,
        })
        .collect()
}

/// Every registration in the doc, keyed by node id. Unreadable entries are skipped
/// rather than failing the read — one malformed record must not hide the rest.
async fn read_registrations(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
) -> Vec<(String, Registration)> {
    let Ok(ids) = crate::list_rkeys(doc, author_id, INSTANCE_COLLECTION).await else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for node_id in ids {
        let Ok(Some(raw)) = read_record(doc, blobs, author_id, INSTANCE_COLLECTION, &node_id).await
        else {
            continue;
        };
        if let Ok(reg) = serde_json::from_slice::<Registration>(&raw) {
            out.push((node_id, reg));
        }
    }
    out
}

/// Register, wait, repeat — forever. The clock and the relay both come from the caller
/// for the same reasons `register_instance`'s do.
pub async fn run_instance_loop(
    ctx: InstanceContext,
    cadence: Duration,
    now_secs: impl Fn() -> u64,
    relay: impl Fn() -> Option<String>,
    on_pass: impl Fn(Result<InstanceOutcome, String>),
) -> ! {
    loop {
        on_pass(register_instance(&ctx, now_secs(), relay()).await);
        n0_future::time::sleep(cadence).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg(at: u64, durable: bool) -> Registration {
        Registration {
            at,
            durable,
            relay: None,
        }
    }

    fn addr(node_id: &str, relay: Option<&str>) -> InstanceAddr {
        InstanceAddr {
            node_id: node_id.to_string(),
            relay: relay.map(str::to_string),
        }
    }

    #[test]
    fn an_endpoint_set_round_trips_through_its_published_form() {
        // The format is written by the identity loop and read by whatever dials, so a
        // disagreement between the two halves would publish coordinates nobody can use.
        let set = vec![
            addr("aaa", Some("https://use1-1.relay.n0.iroh.link./")),
            addr("bbb", Some("https://euw1-1.relay.n0.iroh.link./")),
        ];
        let encoded = encode_endpoints(&set);
        assert_eq!(
            encoded,
            "aaa|https://use1-1.relay.n0.iroh.link./,bbb|https://euw1-1.relay.n0.iroh.link./"
        );
        assert_eq!(parse_endpoints(&encoded), set);
    }

    #[test]
    fn an_endpoint_with_no_address_survives_the_round_trip() {
        // It still names an endpoint. Dropping it here would hide the fact that an
        // instance is live from a caller who might reach it another way; whether it is
        // dialable is that caller's question.
        let set = vec![addr("aaa", None), addr("bbb", Some("https://relay/"))];
        assert_eq!(encode_endpoints(&set), "aaa,bbb|https://relay/");
        assert_eq!(parse_endpoints("aaa,bbb|https://relay/"), set);
    }

    #[test]
    fn a_malformed_endpoint_list_yields_no_nameless_endpoints() {
        // A trailing separator, an empty record, or a stray field separator must not
        // produce an entry with no id — that is an endpoint nothing could ever dial, and
        // it would be counted as advertised.
        assert!(parse_endpoints("").is_empty());
        assert_eq!(parse_endpoints("aaa,"), vec![addr("aaa", None)]);
        assert_eq!(parse_endpoints("|https://relay/"), Vec::new());
        // An empty address is the same as none, rather than an address of "".
        assert_eq!(parse_endpoints("aaa|"), vec![addr("aaa", None)]);
    }

    #[test]
    fn a_pass_that_cannot_see_a_relay_keeps_the_one_already_registered() {
        // The endpoint reaches its home relay some time after binding, so the first pass
        // after a start routinely has nothing to report. Overwriting a good address with
        // nothing would leave this instance unreachable for a whole cadence.
        let held = Some("https://relay/".to_string());
        assert_eq!(relay_to_register(None, held.clone()), held);
        // A freshly-seen address wins, including one that moved.
        assert_eq!(
            relay_to_register(Some("https://other/".into()), held),
            Some("https://other/".to_string())
        );
        assert_eq!(relay_to_register(None, None), None);
    }

    #[test]
    fn a_registration_carries_its_address_and_tolerates_one_without() {
        let stored = Registration {
            at: 1,
            durable: true,
            relay: Some("https://relay/".into()),
        };
        let bytes = serde_json::to_vec(&stored).unwrap();
        let back: Registration = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.relay.as_deref(), Some("https://relay/"));

        // Written before addresses were recorded. It reads as located-nowhere rather
        // than failing to decode, which would hide a live instance entirely.
        let old: Registration = serde_json::from_str(r#"{"at":1,"durable":true}"#).unwrap();
        assert!(old.relay.is_none());
        // And an absent address is omitted rather than written as null.
        assert_eq!(
            serde_json::to_string(&reg(1, false)).unwrap(),
            r#"{"at":1,"durable":false}"#
        );
    }

    fn ids(mut live: Vec<(String, Registration)>, now: u64) -> Vec<String> {
        live.retain(|(_, r)| now.saturating_sub(r.at) < INSTANCE_TTL_SECS);
        live.sort_by(|a, b| {
            b.1.durable
                .cmp(&a.1.durable)
                .then(b.1.at.cmp(&a.1.at))
                .then(a.0.cmp(&b.0))
        });
        live.into_iter().map(|(id, _)| id).collect()
    }

    #[test]
    fn a_registration_round_trips_through_its_stored_form() {
        let bytes = serde_json::to_vec(&reg(1_700_000_000, true)).unwrap();
        let back: Registration = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.at, 1_700_000_000);
        assert!(back.durable);
        // `durable` defaults, so a registration written before the flag existed still
        // reads — as not-durable, which is the safe assumption about an unknown device.
        let old: Registration = serde_json::from_str(r#"{"at":1}"#).unwrap();
        assert!(!old.durable);
    }

    #[test]
    fn an_aged_out_instance_is_not_advertised() {
        let now = 100_000;
        let live = vec![
            ("fresh".into(), reg(now - 10, false)),
            ("stale".into(), reg(now - INSTANCE_TTL_SECS - 1, false)),
        ];
        assert_eq!(ids(live, now), vec!["fresh".to_string()]);
    }

    #[test]
    fn a_clock_behind_a_peers_does_not_prune_a_live_instance() {
        // Two of your own devices need not agree on the time. A peer's registration
        // stamped slightly in OUR future must not underflow into "ancient".
        let now = 100_000;
        let live = vec![("ahead".into(), reg(now + 500, false))];
        assert_eq!(ids(live, now), vec!["ahead".to_string()]);
    }

    #[test]
    fn always_on_instances_are_offered_first() {
        // A caller that has to truncate should keep the endpoints a peer can actually
        // reach, so durability outranks freshness.
        let now = 100_000;
        let live = vec![
            ("tab".into(), reg(now - 1, false)),
            ("desktop".into(), reg(now - 600, true)),
        ];
        assert_eq!(ids(live, now), vec!["desktop", "tab"]);
    }
}
