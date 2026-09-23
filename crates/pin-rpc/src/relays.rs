//! Which relays this instance reaches the network through.
//!
//! Pin talks to two kinds of relay and the word is the same for both, which is exactly
//! why they live in one type. **pkarr relays** are how a browser reaches the Mainline
//! DHT at all, because a sandbox cannot send UDP; they carry our signed identity and
//! channel pointers, and iroh publishes its own node addresses through one too. **iroh
//! relays** are transport: the path a connection takes until holepunching finds a direct
//! one, and — for a browser peer, which has no listening socket and no UDP — the path it
//! takes forever.
//!
//! Before this existed all four destinations were `presets::N0`, at three call sites that
//! each bundled two of them, plus a constant in `pin-pkarr`. Nothing chose them and
//! nothing could: a relay was a property of the build. The cost was not the company in
//! the path so much as the opacity — a resolve that came back empty could be an empty
//! answer, a rate-limited one, or a cached miss, and we had no vantage from which to tell
//! which. A relay we run has a log.
//!
//! Lives here rather than beside either consumer because `presets` is gated on iroh's
//! `with_crypto_provider`, and this is the one crate shared by the browser engine and the
//! desktop shell that declares `iroh` with its default features rather than inheriting
//! them from whatever else the workspace happens to build.

use iroh::endpoint::presets::{Minimal, Preset};
use iroh::endpoint::Builder;
use iroh::{RelayMap, RelayMode};
use url::Url;

/// A chosen set of relays, parsed.
///
/// Parsed at construction rather than at use: applying a preset cannot fail — iroh's
/// trait hands back a `Builder`, not a `Result` — so a malformed URL has to be a refusal
/// at the point somebody typed it, where it can be reported, rather than a panic deep in
/// a bind.
#[derive(Debug, Clone)]
pub struct Relays {
    pkarr: Vec<String>,
    node_pkarr: Url,
    iroh: RelayMap,
}

impl Relays {
    /// Parse a configured set, or say which entry is wrong.
    ///
    /// Both lists must be non-empty. There is no fallback to a public relay when a list
    /// is blank, and that is the point: an instance configured with nothing would
    /// otherwise reach whatever the build happened to compile in, which is the quiet
    /// failure this type exists to remove.
    pub fn parse(pkarr: &[String], iroh: &[String]) -> Result<Self, String> {
        if pkarr.is_empty() {
            return Err("no pkarr relay configured".to_string());
        }
        if iroh.is_empty() {
            return Err("no iroh relay configured".to_string());
        }
        // iroh's node-address publisher takes ONE relay, where our own records fan out
        // across every entry. First rather than a merge: the fan-out exists to widen
        // overlap for records we publish, and a node address is re-published every few
        // minutes anyway, so a second copy buys nothing it does not already have.
        let node_pkarr: Url = pkarr[0]
            .parse()
            .map_err(|e| format!("pkarr relay {}: {e}", pkarr[0]))?;
        let iroh = RelayMap::try_from_iter(iroh.iter().map(String::as_str))
            .map_err(|e| format!("iroh relay: {e}"))?;
        Ok(Self {
            pkarr: pkarr.to_vec(),
            node_pkarr,
            iroh,
        })
    }

    /// The pkarr relays our own records fan out across — what `pin_pkarr::set_relays`
    /// takes. Returned rather than applied here so this crate keeps no dependency on
    /// the crate that publishes those records.
    pub fn pkarr(&self) -> &[String] {
        &self.pkarr
    }
}

/// Configure an endpoint to reach the network through these relays and no others.
///
/// This is `presets::N0` with its three destinations replaced. What is deliberately NOT
/// carried over is `DnsAddressLookup`: it is a second resolver for the records the pkarr
/// resolver beside it already answers for, pointed at n0's DNS server, so keeping it
/// would leave a name lookup going somewhere nobody chose. Our `_iroh` records carry
/// each endpoint's address, so a bare-id dial — the one thing that lookup is for — is a
/// fall-through we already avoid rather than a path we depend on.
impl Preset for &Relays {
    fn apply(self, builder: Builder) -> Builder {
        use iroh::address_lookup::{PkarrPublisher, PkarrResolver};

        Minimal
            .apply(builder)
            .address_lookup(PkarrPublisher::builder(self.node_pkarr.clone()))
            .address_lookup(PkarrResolver::builder(self.node_pkarr.clone()))
            .relay_mode(RelayMode::Custom(self.iroh.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    /// Plain HTTP throughout, and that is the ordinary case rather than an edge one: a
    /// relay on this machine has no certificate and wants none. There is no separate
    /// test for it because every fixture here is already http, so one could not fail on
    /// its own.
    #[test]
    fn a_configured_set_parses() {
        let relays = Relays::parse(
            &v(&["http://localhost:6881"]),
            &v(&["http://localhost:3340"]),
        )
        .expect("parses");
        assert_eq!(relays.pkarr(), ["http://localhost:6881"]);
    }

    /// An empty list is refused rather than filled in. Answering it with a public relay
    /// would mean an instance nobody configured still reaches the network, which reads
    /// as working and is the failure hardest to notice.
    #[test]
    fn an_empty_list_is_refused_rather_than_defaulted() {
        assert!(Relays::parse(&[], &v(&["http://localhost:3340"])).is_err());
        assert!(Relays::parse(&v(&["http://localhost:6881"]), &[]).is_err());
    }

    #[test]
    fn a_malformed_url_names_itself() {
        let err =
            Relays::parse(&v(&["not a url"]), &v(&["http://localhost:3340"])).expect_err("refused");
        assert!(err.contains("not a url"), "{err}");
    }

    /// The fan-out is ours; iroh's node-address publisher takes one. Both halves of that
    /// come off one list, so the second entry has to survive parsing rather than being
    /// dropped when the first is picked for the publisher.
    #[test]
    fn every_pkarr_entry_survives_while_the_publisher_takes_one() {
        let relays = Relays::parse(
            &v(&["http://localhost:6881", "https://pkarr.pubky.org"]),
            &v(&["http://localhost:3340"]),
        )
        .expect("parses");
        assert_eq!(relays.pkarr().len(), 2);
        assert_eq!(relays.node_pkarr.as_str(), "http://localhost:6881/");
    }
}
