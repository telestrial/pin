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
}

/// Record that this instance is here and reachable, and forget the ones that aren't.
///
/// `now_secs` is passed in rather than read: `SystemTime::now()` panics on
/// wasm32-unknown-unknown, so the clock belongs to the caller — the same rule the
/// manifest transforms follow.
pub async fn register_instance(
    ctx: &InstanceContext,
    now_secs: u64,
) -> Result<InstanceOutcome, String> {
    let mine = Registration {
        at: now_secs,
        durable: ctx.durable,
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

/// The node ids of every instance whose registration is still current, newest first.
///
/// Durable instances sort ahead of the rest at equal freshness, so a caller that has to
/// truncate keeps the always-on endpoints — the ones a peer is most likely to reach.
pub async fn live_instances(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    now_secs: u64,
) -> Vec<String> {
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
    live.into_iter().map(|(id, _)| id).collect()
}

/// Every registration in the doc, keyed by node id. Unreadable entries are skipped
/// rather than failing the read — one malformed record must not hide the rest.
async fn read_registrations(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
) -> Vec<(String, Registration)> {
    use n0_future::StreamExt as _;

    let prefix = pin_derive::collection_prefix(INSTANCE_COLLECTION);
    let Ok(stream) = doc.get_many(iroh_docs::store::Query::all().build()).await else {
        return Vec::new();
    };
    let mut stream = Box::pin(stream);
    let mut ids = Vec::new();
    while let Some(Ok(entry)) = stream.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();
        if let Some(rkey) = key.strip_prefix(&prefix) {
            ids.push(rkey.to_string());
        }
    }

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

/// Register, wait, repeat — forever. The clock comes from the caller for the same
/// reason `register_instance`'s does.
pub async fn run_instance_loop(
    ctx: InstanceContext,
    cadence: Duration,
    now_secs: impl Fn() -> u64,
    on_pass: impl Fn(Result<InstanceOutcome, String>),
) -> ! {
    loop {
        on_pass(register_instance(&ctx, now_secs()).await);
        n0_future::time::sleep(cadence).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg(at: u64, durable: bool) -> Registration {
        Registration { at, durable }
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
