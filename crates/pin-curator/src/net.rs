//! The two network reads the crawl makes, behind a seam.
//!
//! Reading somebody is exactly this: resolve their key to a packet, download the blob the
//! packet points at. Everything else a pass does — ranking the frontier, deciding what
//! fades, writing a record — is pure, or is a doc write. So these two are the whole of
//! what stands between the crawl's logic and a test of it.
//!
//! The seam exists because of what this crate is for. Pin's substrate decides **who can
//! see whom**, and that is a property of a SEQUENCE — carol becomes visible to john once
//! alice's record lands, and not before. `frontier` can be tested over hand-built records
//! and says nothing about that, because ordering is not visibility. A pass has to actually
//! run, over several identities, against a network they share.
//!
//! Generic rather than `dyn`, so a fake costs no allocation and no new dependency, and so
//! the futures keep whatever Send-ness their target gives them — a browser's are not Send
//! and a boxed trait object would have to pick one answer for both targets.

use pin_pkarr::TxtRecord;

/// Resolving a key, and downloading what it points at.
///
/// The error type is `String` throughout, matching what both primitives already return.
/// It carries the distinction a crawl acts on: an error is UNREACHABLE — the network could
/// not answer — and is never the same as a resolve that succeeded and published nothing.
/// Collapsing the two is the shape that has bitten this repo three times, so an
/// implementation must fail rather than return empty when it could not read.
pub trait Network {
    /// This identity's packet, as the DHT (or a relay) currently answers.
    fn resolve(
        &self,
        did: &str,
    ) -> impl std::future::Future<Output = Result<Vec<TxtRecord>, String>>;

    /// The bytes behind a share URL.
    fn download(&self, url: &str) -> impl std::future::Future<Output = Result<Vec<u8>, String>>;
}

/// The real one: Mainline (or the pkarr relays, by target) and a Sia session.
///
/// Holds the session by `Arc` because that is how every context already carries it, so
/// constructing this is a clone rather than a handoff.
#[derive(Clone)]
pub struct LiveNetwork {
    sia: std::sync::Arc<pin_sia::Session>,
}

impl LiveNetwork {
    pub fn new(sia: std::sync::Arc<pin_sia::Session>) -> Self {
        Self { sia }
    }

    /// The session underneath, for the paths that still take one directly.
    pub fn sia(&self) -> &std::sync::Arc<pin_sia::Session> {
        &self.sia
    }
}

impl Network for LiveNetwork {
    async fn resolve(&self, did: &str) -> Result<Vec<TxtRecord>, String> {
        pin_pkarr::resolve(did).await
    }

    async fn download(&self, url: &str) -> Result<Vec<u8>, String> {
        self.sia.download_item(url).await
    }
}
