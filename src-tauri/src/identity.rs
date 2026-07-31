//! Pin's did:dht identity — the resolvable, decentralized identity layer (rung 6a).
//!
//! We chose did:dht (DID document in Mainline DHT via pkarr) over did:plc to keep
//! identity off any company's registry — de-risked 2026-06-25 by the pkarr-probe
//! (publish + resolve directly on Mainline DHT, no relays, no n0). The DID
//! identifier is an ed25519 key; the P-256 repo signing key (`repo.rs`) is carried
//! in the DID document as a verification method. Both derive from the one recovery
//! phrase (via the Sia AppKey + HKDF), so the identity is recoverable and stored
//! nowhere.
//!
//! Slice A (here): derive the ed25519 identity key + compute the did:dht DID.
//! Publishing the document to the DHT and resolving others' DIDs come next.

use std::time::Duration;

use pkarr::dns::rdata::RData;
use pkarr::{Client, Keypair, PublicKey, SignedPacket};

/// Derive the ed25519 did:dht identity keypair from the Sia AppKey via HKDF — the
/// same one-root-secret move as the repo signing key, different `info`. ed25519
/// accepts any 32 bytes as a seed (no scalar-range rejection, unlike P-256), so
/// this never needs a retry.
///
/// The derivation itself lives in `pin_derive` because the browser performs the
/// identical one: a user's did:dht must be the same whether their instance is this
/// Curator or a tab. It used to be written out here AND in TypeScript, kept in step
/// by a comment — which is not an enforcement mechanism.
pub fn derive_identity(app_key: &[u8]) -> Result<Keypair, String> {
    Ok(Keypair::from_secret_key(&pin_derive::did_dht_seed(app_key)))
}

/// The `did:dht:<zbase32(pubkey)>` identifier for this keypair.
pub fn did_dht(keypair: &Keypair) -> String {
    format!("did:dht:{}", keypair.public_key())
}

/// Publish the Curator's DID document to the Mainline DHT and self-resolve it to
/// verify. `records` are `(name, value)` TXT pairs — a pragmatic Pin convention
/// (we resolve our own docs, so strict did:dht-spec DNS encoding can come later):
/// `_iroh` = the Curator's iroh node id (where to dial), `_ns` = the Curator's
/// iroh-docs namespace id (which doc to import + sync).
///
/// DHT-only (`no_relays()`), so this proves the decentralized leg — no n0, no
/// pkarr relay. Publish stores to the closest nodes (~seconds); a SEPARATE fresh
/// client then resolves it back, so a hit proves the doc is genuinely on the DHT,
/// not local cache. Best-effort from the caller's side — a failure leaves the node
/// serving over iroh (peers handed the NodeAddr can still reach it).
pub async fn publish_doc(
    keypair: &Keypair,
    records: &[(String, String)],
) -> Result<String, String> {
    let mut builder = SignedPacket::builder();
    for (name, value) in records {
        let n = name
            .as_str()
            .try_into()
            .map_err(|_| format!("bad record name: {name}"))?;
        let v = value
            .as_str()
            .try_into()
            .map_err(|_| format!("bad record value: {value}"))?;
        builder = builder.txt(n, v, 3600);
    }
    let packet = builder
        .sign(keypair)
        .map_err(|e| format!("sign doc: {e}"))?;
    // What we're about to publish, independent of any DHT round-trip — separates a
    // build problem (record dropped locally) from a read problem (stale DHT copy).
    log::info!(
        "did:dht doc: built {} records to publish",
        packet.all_resource_records().count()
    );

    let mut pb = Client::builder();
    pb.no_relays();
    let publisher = pb.build().map_err(|e| format!("dht client: {e}"))?;

    // Publishing is best-effort UDP to the Mainline DHT and fails transiently —
    // especially from a freshly-bound node that hasn't warmed enough DHT contacts
    // yet (e.g. a rapid Curator re-enable, observed 2026-07-08: first publish OK,
    // immediate re-enable ~3s later failed). Retry a few times, the same posture the
    // resolve side already takes — DHT ops are best-effort, always retry.
    let mut published = false;
    let mut last_err = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        match publisher.publish(&packet, None).await {
            Ok(()) => {
                published = true;
                break;
            }
            Err(e) => last_err = format!("publish: {e}"),
        }
    }
    if !published {
        return Err(last_err);
    }

    // Verify from a SEPARATE fresh DHT-only client (empty cache → a hit came from
    // the DHT). pkarr verifies the signature on resolve, so a returned packet is
    // provably ours.
    let mut rb = Client::builder();
    rb.no_relays();
    let resolver = rb.build().map_err(|e| format!("dht client: {e}"))?;
    // resolve_most_recent (not resolve): the DHT can return a stale earlier packet
    // for the same key from the first node hit (pkarr's documented "lost update"
    // read hazard, which bites when we republish across runs). most_recent gathers
    // the highest-timestamp packet across nodes.
    let pubkey = keypair.public_key();
    for _ in 0..6 {
        if let Some(sp) = resolver.resolve_most_recent(&pubkey).await {
            let n = sp.all_resource_records().count();
            return Ok(format!(
                "ok (published + self-resolved {n} records via Mainline DHT)"
            ));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Err("published but could not self-resolve from the DHT".to_string())
}

/// The coordinates a peer needs after resolving someone's did:dht: where to reach
/// them (iroh node) + which doc to sync (iroh-docs namespace). Fields are `Option`
/// because a document may omit records (and clients ignore ones they don't grok).
#[derive(Debug, Clone)]
pub struct ResolvedIdentity {
    /// The iroh node id to dial (from the document's `_iroh` record).
    pub iroh_node: Option<String>,
    /// The Curator's iroh-docs namespace id (from `_ns`) — the doc to import + sync.
    pub namespace: Option<String>,
}

/// Resolve a peer's `did:dht` from the Mainline DHT into the coordinates to reach +
/// verify them. DHT-only (no relays, no n0). pkarr verifies the packet signature on
/// resolve, so the records are provably the DID owner's. This is the read side the
/// pull/reconcile loops use to turn a follow's DID into a dial-able Curator.
pub async fn resolve_did(did: &str) -> Result<ResolvedIdentity, String> {
    let z = did
        .strip_prefix("did:dht:")
        .ok_or_else(|| format!("not a did:dht: {did}"))?;
    let pubkey: PublicKey = z
        .try_into()
        .map_err(|_| format!("bad did:dht key: {did}"))?;

    let mut rb = Client::builder();
    rb.no_relays();
    let resolver = rb.build().map_err(|e| format!("dht client: {e}"))?;

    // DHT lookups from a cold client are timing-sensitive — a single attempt can
    // miss a record that's actually present (a publish lands on the closest nodes;
    // a fresh resolver's first lookup may not reach them yet). Retry a few times,
    // same as the publish-side self-resolve.
    // resolve_most_recent (not resolve): avoid a stale earlier packet from the first
    // node hit (pkarr's documented "lost update" read hazard) — gather the
    // highest-timestamp packet across nodes.
    let mut packet = None;
    for _ in 0..6 {
        if let Some(found) = resolver.resolve_most_recent(&pubkey).await {
            packet = Some(found);
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let sp = packet.ok_or_else(|| format!("did:dht not found on the DHT: {did}"))?;

    let mut id = ResolvedIdentity {
        iroh_node: None,
        namespace: None,
    };
    for rr in sp.all_resource_records() {
        let RData::TXT(txt) = &rr.rdata else { continue };
        let Ok(value) = String::try_from(txt.clone()) else {
            continue;
        };
        // Record names resolve as "_iroh.<zbase32>", "_ns.<zbase32>", etc.
        let label = rr.name.to_string();
        if label.starts_with("_iroh") {
            id.iroh_node = Some(value);
        } else if label.starts_with("_ns") {
            id.namespace = Some(value);
        }
    }
    Ok(id)
}
