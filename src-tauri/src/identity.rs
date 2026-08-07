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
//! What's left here is the key and the DID string. PUBLISHING the document belongs to
//! the identity loop (`pin_curator::run_identity_loop`), which assembles the whole
//! packet — directory pointer, doc namespace, every live endpoint — from the doc and
//! sends it through `pin_pkarr` like every other pkarr write in the codebase. This
//! module used to carry its own DHT publish + self-resolve, which was a second
//! implementation of that.

use pkarr::Keypair;

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
