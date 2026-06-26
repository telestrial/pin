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

use hkdf::Hkdf;
use pkarr::dns::rdata::RData;
use pkarr::{Client, Keypair, PublicKey, SignedPacket};
use sha2::Sha256;

/// HKDF `info` for the did:dht identity key — domain-separated from the repo
/// signing key (`pin:atproto-signing:v1`) and settings (`pin:settings:v1`).
const DID_DHT_INFO: &[u8] = b"pin:did-dht:v1";

/// Derive the ed25519 did:dht identity keypair from the Sia AppKey via HKDF — the
/// same one-root-secret move as the repo signing key, different `info`. ed25519
/// accepts any 32 bytes as a seed (no scalar-range rejection, unlike P-256), so
/// this never needs a retry.
pub fn derive_identity(app_key: &[u8]) -> Result<Keypair, String> {
    let hk = Hkdf::<Sha256>::new(None, app_key);
    let mut seed = [0u8; 32];
    hk.expand(DID_DHT_INFO, &mut seed)
        .map_err(|e| format!("hkdf expand: {e}"))?;
    Ok(Keypair::from_secret_key(&seed))
}

/// The `did:dht:<zbase32(pubkey)>` identifier for this keypair.
pub fn did_dht(keypair: &Keypair) -> String {
    format!("did:dht:{}", keypair.public_key())
}

/// Publish the keeper's DID document to the Mainline DHT and self-resolve it to
/// verify. `records` are `(name, value)` TXT pairs — a pragmatic Pin convention
/// (we resolve our own docs, so strict did:dht-spec DNS encoding can come later):
/// e.g. `_iroh` = the keeper's iroh node id, `_vm` = the repo's did:key
/// verification method, `_mirror` = the Sia mirror share URL.
///
/// DHT-only (`no_relays()`), so this proves the decentralized leg — no n0, no
/// pkarr relay. Publish stores to the closest nodes (~seconds); a SEPARATE fresh
/// client then resolves it back, so a hit proves the doc is genuinely on the DHT,
/// not local cache. Best-effort from the caller's side — a failure leaves the node
/// serving over iroh (peers handed the NodeAddr can still reach it).
pub async fn publish_doc(keypair: &Keypair, records: &[(String, String)]) -> Result<String, String> {
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
    let packet = builder.sign(keypair).map_err(|e| format!("sign doc: {e}"))?;

    let mut pb = Client::builder();
    pb.no_relays();
    let publisher = pb.build().map_err(|e| format!("dht client: {e}"))?;
    publisher
        .publish(&packet, None)
        .await
        .map_err(|e| format!("publish: {e}"))?;

    // Verify from a SEPARATE fresh DHT-only client (empty cache → a hit came from
    // the DHT). pkarr verifies the signature on resolve, so a returned packet is
    // provably ours.
    let mut rb = Client::builder();
    rb.no_relays();
    let resolver = rb.build().map_err(|e| format!("dht client: {e}"))?;
    let pubkey = keypair.public_key();
    for _ in 0..6 {
        if let Some(sp) = resolver.resolve(&pubkey).await {
            let n = sp.all_resource_records().count();
            return Ok(format!("ok (published + self-resolved {n} records via Mainline DHT)"));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Err("published but could not self-resolve from the DHT".to_string())
}

/// The coordinates a peer needs after resolving someone's did:dht: where to reach
/// them + the key to verify their repo. Fields are `Option` because a document may
/// omit records (and clients ignore record types they don't understand).
#[derive(Debug, Clone)]
pub struct ResolvedIdentity {
    /// The iroh node id to dial (from the document's `_iroh` record).
    pub iroh_node: Option<String>,
    /// The repo's did:key verification method (from `_vm`) — verifies repo commits.
    pub verification: Option<String>,
}

/// Resolve a peer's `did:dht` from the Mainline DHT into the coordinates to reach +
/// verify them. DHT-only (no relays, no n0). pkarr verifies the packet signature on
/// resolve, so the records are provably the DID owner's. This is the read side the
/// pull/reconcile loops use to turn a follow's DID into a dial-able keeper.
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
    let mut packet = None;
    for _ in 0..6 {
        if let Some(found) = resolver.resolve(&pubkey).await {
            packet = Some(found);
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let sp = packet.ok_or_else(|| format!("did:dht not found on the DHT: {did}"))?;

    let mut id = ResolvedIdentity {
        iroh_node: None,
        verification: None,
    };
    for rr in sp.all_resource_records() {
        let RData::TXT(txt) = &rr.rdata else { continue };
        let Ok(value) = String::try_from(txt.clone()) else {
            continue;
        };
        // Record names resolve as "_iroh.<zbase32>", "_vm.<zbase32>", etc.
        let label = rr.name.to_string();
        if label.starts_with("_iroh") {
            id.iroh_node = Some(value);
        } else if label.starts_with("_vm") {
            id.verification = Some(value);
        }
    }
    Ok(id)
}
