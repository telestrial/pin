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

use hkdf::Hkdf;
use pkarr::Keypair;
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
