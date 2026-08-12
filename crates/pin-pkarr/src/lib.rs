//! Publish and resolve pkarr records — the signed, mutable, identity-keyed pointers
//! Pin uses instead of a server.
//!
//! See Cargo.toml for why this is one crate with two transports. The short version:
//! only the transport is a real capability difference (a browser can't send UDP), and
//! everything above it — packet building, signing, TTL, retries, TXT extraction — was
//! previously written twice and is now written once.

use pkarr::dns::rdata::RData;
use pkarr::{Client, Keypair, PublicKey, SignedPacket};

/// A TXT name/value pair. The wire shape the frontend already speaks (`PkarrTxt`).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct TxtRecord {
    pub name: String,
    pub value: String,
}

/// Max bytes in one TXT character-string. A longer value is split across indexed
/// records `<prefix>0`, `<prefix>1`, … and rejoined on the way back.
///
/// Not enforced by the DNS layer any more — the JS client this replaced threw past 255,
/// while `simple_dns` splits into several character-strings and rejoins them invisibly.
/// Chunking stays mandatory regardless: it is the convention every already-published
/// record uses, and the ~1000-byte ceiling on the whole packet is a separate limit that
/// chunking does not lift.
const TXT_MAX: usize = 255;

/// Split a value into indexed TXT records so a long pointer fits under the per-string
/// cap. Generic over the prefix, since the splitting never differed between conventions.
///
/// The frontend has a parallel implementation for the conventions IT publishes (`_dir`
/// for an identity document, the rendezvous ticket) — see `src/lib/pkarr.ts`. That is
/// tolerable only because no convention currently crosses implementations: `_c` is
/// written and read here, the others there. The moment one does cross — the Curator
/// reading `_dir`, say — they have to become one, because a reader that cannot rejoin
/// what a writer split is a silent data failure.
pub fn chunk_txt(prefix: &str, value: &str) -> Vec<TxtRecord> {
    value
        .as_bytes()
        .chunks(TXT_MAX)
        .enumerate()
        .map(|(i, part)| TxtRecord {
            name: format!("{prefix}{i}"),
            // Chunks land on byte offsets. Every value we publish is ASCII (share URLs,
            // tickets, base64), so this cannot split a multi-byte character —
            // `from_utf8_lossy` rather than a panic because a corrupted pointer is
            // preferable to taking down a publish, and the guard is unreachable anyway.
            value: String::from_utf8_lossy(part).into_owned(),
        })
        .collect()
}

/// Rejoin a value split by `chunk_txt`. Records arrive fully-qualified
/// (`<prefix>0.<zbase32>`) and in arbitrary order, so match on the prefix and sort by
/// the numeric index. Returns "" when no records match — which is how "nothing is
/// published under this convention" is reported.
pub fn rejoin_txt(records: &[TxtRecord], prefix: &str) -> String {
    let mut parts: Vec<(u32, &str)> = records
        .iter()
        .filter_map(|r| {
            let rest = r.name.strip_prefix(prefix)?;
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            // Reject a bare prefix with no index, so `_c` alone is not read as `_c0`.
            if digits.is_empty() {
                return None;
            }
            digits.parse().ok().map(|i| (i, r.value.as_str()))
        })
        .collect();
    parts.sort_by_key(|(i, _)| *i);
    parts.into_iter().map(|(_, v)| v).collect()
}

/// DNS TTL on every record we publish.
///
/// This governs how long relays and resolver caches hold a packet — NOT how long the
/// record lives on the DHT (that's Mainline's own ~2h expiry, refreshed by keep-alive
/// republishing). It's deliberately short: a high TTL leaves a just-published change
/// invisible behind stale caches for that long, which is precisely what once hid a
/// freshly-published post from a subscriber. Mutable pointers want fast propagation,
/// and the cost is only more frequent re-resolves.
pub const RECORD_TTL_SECS: u32 = 60;

/// Publishes fail transiently — flaky networks, cold-client warmup, and pkarr's own
/// concurrency guard ("A different SignedPacket is being concurrently published for
/// the same PublicKey") when two instances write the same key at once. Retrying the
/// same signed packet after a pause lets the competing publish finish and then lands.
pub const PUBLISH_RETRIES: usize = 3;
const RETRY_DELAY_MS: u32 = 2000;

/// Public relays to fan out to in the browser.
///
/// Exactly the set the vendored JS client used, which is what keeps every record
/// published before this crate existed resolvable.
///
/// Adding more is a false economy, and measured as one: including a third
/// (`relay.pkarr.org`, from the crate's `DEFAULT_RELAYS`) took a sync spec from ~10s to
/// 1.2–1.7m. The fan-out below awaits EVERY relay, so a slow one adds its latency to
/// every publish and every resolve — and it answered health checks in 0.6s, so this is
/// about how long it takes to make a store resolvable, not reachability. More relays
/// subtract resilience under this design rather than adding it; a dead one would cost the
/// full timeout. The wider-overlap argument for read-after-write doesn't pay for that,
/// since the two below are the relays our own records actually live on.
#[cfg(target_arch = "wasm32")]
const RELAYS: [&str; 2] = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];

/// How many times to re-attempt a DHT lookup. Cold-client Mainline lookups are
/// timing-sensitive — a single attempt can miss a record that is genuinely there — so
/// this spans roughly the same window the browser gives its relay fan-out.
#[cfg(not(target_arch = "wasm32"))]
const RESOLVE_ATTEMPTS: usize = 6;

async fn sleep_retry() {
    #[cfg(target_arch = "wasm32")]
    gloo_timers::future::TimeoutFuture::new(RETRY_DELAY_MS).await;
    #[cfg(not(target_arch = "wasm32"))]
    tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS as u64)).await;
}

/// Rebuild the ed25519 keypair from a 32-byte seed.
///
/// Seeds rather than keypairs are what cross every boundary in Pin — a keypair object
/// can't travel over IPC or wasm-bindgen, but 32 bytes can, and both engines rebuild
/// it identically.
pub fn keypair_from_seed(seed: &[u8]) -> Result<Keypair, String> {
    let seed32: [u8; 32] = seed
        .try_into()
        .map_err(|_| "seed must be exactly 32 bytes".to_string())?;
    Ok(Keypair::from_secret_key(&seed32))
}

/// Sign arbitrary bytes with the identity keypair a seed implies.
///
/// Here rather than in a crate of its own because this crate already owns the
/// relationship between a seed and the identity key it produces, and the string that
/// names it. Signing something OTHER than a pkarr packet with that key is still the same
/// question — what can this identity assert — so keeping one home for it means no second
/// place can disagree about which key an identity signs with.
///
/// The signature comes back base64 (standard, padded), matching every other place bytes
/// travel through JSON both implementations read.
///
/// CALLERS MUST DOMAIN-SEPARATE. This key also signs pkarr packets, so a message with no
/// distinguishing prefix could in principle be a valid signature for something in
/// another protocol. Each caller prefixes its own constant; see `pin_engagement`.
pub fn sign_detached(seed: &[u8], message: &[u8]) -> Result<String, String> {
    let sig = keypair_from_seed(seed)?.sign(message);
    Ok(pin_crypto::b64_encode(&sig.to_bytes()))
}

/// Verify a detached signature against the key embedded in a `did:dht:` string.
///
/// NO NETWORK. A did:dht identifier IS its ed25519 public key in z-base32, so verifying
/// anyone's signature needs nothing but their identifier — the self-certifying property
/// that made did:dht worth choosing. Which is why an engagement count can be verified
/// on arrival from a stranger we have never resolved and will never fetch.
pub fn verify_detached(did_or_key: &str, message: &[u8], sig_b64: &str) -> Result<(), String> {
    let public_key = parse_key(did_or_key)?;
    let bytes = pin_crypto::b64_decode(sig_b64).ok_or("signature is not base64")?;
    let bytes: [u8; 64] = bytes
        .try_into()
        .map_err(|_| "signature must be 64 bytes".to_string())?;
    public_key
        .verify(message, &ed25519_dalek::Signature::from_bytes(&bytes))
        .map_err(|_| "signature does not verify for this identity".to_string())
}

/// The z-base32 public-key string for a seed — the key a resolver looks up.
pub fn public_key_from_seed(seed: &[u8]) -> Result<String, String> {
    Ok(keypair_from_seed(seed)?.public_key().to_string())
}

/// Build and sign the packet for a set of TXT records.
///
/// Each value must fit one TXT character-string (255 bytes); callers split longer
/// values across indexed records before reaching here.
pub fn build_packet(seed: &[u8], records: &[TxtRecord]) -> Result<SignedPacket, String> {
    let keypair = keypair_from_seed(seed)?;
    let mut builder = SignedPacket::builder();
    for r in records {
        let name = r
            .name
            .as_str()
            .try_into()
            .map_err(|_| format!("bad record name: {}", r.name))?;
        let value = r
            .value
            .as_str()
            .try_into()
            .map_err(|_| format!("record value too long for a TXT string: {}", r.name))?;
        builder = builder.txt(name, value, RECORD_TTL_SECS);
    }
    builder.sign(&keypair).map_err(|e| format!("sign: {e}"))
}

/// Accept either a `did:dht:<key>` or a bare z-base32 key.
pub fn parse_key(did_or_key: &str) -> Result<PublicKey, String> {
    let z = did_or_key.strip_prefix("did:dht:").unwrap_or(did_or_key);
    z.try_into().map_err(|_| format!("bad pkarr key: {z}"))
}

/// Pull the TXT records out of a resolved packet, skipping anything else.
///
/// Names come back fully-qualified (`_c0.<zbase32>`), which is what the frontend's
/// reassembly matches on — it keys off the prefix and index, not the whole name.
pub fn extract_txt(packet: &SignedPacket) -> Vec<TxtRecord> {
    let mut out = Vec::new();
    for rr in packet.all_resource_records() {
        let RData::TXT(txt) = &rr.rdata else { continue };
        let Ok(value) = String::try_from(txt.clone()) else {
            continue;
        };
        out.push(TxtRecord {
            name: rr.name.to_string(),
            value,
        });
    }
    out
}

// --- Browser transport: public relays over HTTP -------------------------------

/// One client PER relay, rather than one multi-relay client.
///
/// The multi-relay client cancels the remaining relays as soon as one answers, so a
/// publish reliably lands on exactly ONE relay — and then a resolve that happens to
/// ask a different relay reads stale data. That asymmetry is what made a just-
/// published post invisible to a subscriber for minutes. Separate clients let us fan a
/// write out to every relay and gather every answer on read.
#[cfg(target_arch = "wasm32")]
fn relay_clients(timeout_ms: u64) -> Result<Vec<Client>, String> {
    RELAYS
        .iter()
        .map(|relay| {
            let mut b = Client::builder();
            b.no_dht();
            b.relays(&[*relay])
                .map_err(|e| format!("relay {relay}: {e}"))?;
            b.request_timeout(std::time::Duration::from_millis(timeout_ms));
            b.build().map_err(|e| format!("relay client: {e}"))
        })
        .collect()
}

#[cfg(target_arch = "wasm32")]
const PUBLISH_TIMEOUT_MS: u64 = 15000;

/// Also the gather window for a resolve. Too short and a fast relay serving a STALE
/// packet wins before the slower relay holding the fresh one can answer — so give the
/// gather real room rather than optimizing for the miss case.
#[cfg(target_arch = "wasm32")]
const RESOLVE_TIMEOUT_MS: u64 = 12000;

/// Publish to every relay and succeed if any accepts.
///
/// A relay that failed this round simply won't carry the packet until the next publish
/// or keep-alive re-fans it; we only retry the whole fan-out when every relay failed.
#[cfg(target_arch = "wasm32")]
pub async fn publish(seed: &[u8], records: &[TxtRecord]) -> Result<(), String> {
    let packet = build_packet(seed, records)?;
    let clients = relay_clients(PUBLISH_TIMEOUT_MS)?;
    let mut last_err = String::new();
    for attempt in 0..PUBLISH_RETRIES {
        if attempt > 0 {
            sleep_retry().await;
        }
        // Concurrently, not in sequence: relays are independent, and awaiting them one
        // at a time would multiply the timeout by the relay count.
        let results =
            futures_buffered::join_all(clients.iter().map(|c| c.publish(&packet, None))).await;
        let mut any_ok = false;
        for r in results {
            match r {
                Ok(()) => any_ok = true,
                Err(e) => last_err = format!("publish: {e}"),
            }
        }
        if any_ok {
            return Ok(());
        }
    }
    Err(if last_err.is_empty() {
        "pkarr publish failed on all relays".to_string()
    } else {
        last_err
    })
}

/// Ask every relay and keep the newest packet.
///
/// `resolve_most_recent` gathers across the nodes a single client talks to, but a
/// per-relay client only ever hears from its own relay — so the across-relay
/// comparison has to happen here. Fresh clients each call also defeat the client-side
/// resolve cache, which would otherwise pin the first-seen (possibly stale) packet for
/// the whole session. A miss returns no records rather than erroring: callers treat
/// "no pointer" as an ordinary outcome.
#[cfg(target_arch = "wasm32")]
pub async fn resolve(did_or_key: &str) -> Result<Vec<TxtRecord>, String> {
    let public_key = parse_key(did_or_key)?;
    let clients = relay_clients(RESOLVE_TIMEOUT_MS)?;
    // Ask every relay at once — the timeout is a GATHER WINDOW, so asking them in
    // sequence would spend it once per relay instead of once in total.
    let answers =
        futures_buffered::join_all(clients.iter().map(|c| c.resolve_most_recent(&public_key)))
            .await;
    let newest =
        answers
            .into_iter()
            .flatten()
            .reduce(|a, b| if b.timestamp() > a.timestamp() { b } else { a });
    Ok(newest.as_ref().map(extract_txt).unwrap_or_default())
}

// --- Native transport: the Mainline DHT directly ------------------------------

#[cfg(not(target_arch = "wasm32"))]
fn dht_client() -> Result<Client, String> {
    let mut b = Client::builder();
    b.no_relays();
    b.build().map_err(|e| format!("dht client: {e}"))
}

/// Publish straight to the Mainline DHT — no relay, so no relay cache to lag behind.
#[cfg(not(target_arch = "wasm32"))]
pub async fn publish(seed: &[u8], records: &[TxtRecord]) -> Result<(), String> {
    let packet = build_packet(seed, records)?;
    let client = dht_client()?;
    let mut last_err = String::new();
    for attempt in 0..PUBLISH_RETRIES {
        if attempt > 0 {
            sleep_retry().await;
        }
        match client.publish(&packet, None).await {
            Ok(()) => return Ok(()),
            Err(e) => last_err = format!("publish: {e}"),
        }
    }
    Err(last_err)
}

/// Resolve from the DHT, retrying because a cold client can miss a record that's there.
///
/// `resolve_most_recent` rather than `resolve`: plain resolve takes the first node to
/// answer, and measurement showed that node can keep serving a superseded packet
/// indefinitely after a republish. Gathering and taking the highest timestamp returns
/// the fresh value on the first attempt instead.
#[cfg(not(target_arch = "wasm32"))]
pub async fn resolve(did_or_key: &str) -> Result<Vec<TxtRecord>, String> {
    let public_key = parse_key(did_or_key)?;
    let client = dht_client()?;
    for attempt in 0..RESOLVE_ATTEMPTS {
        if attempt > 0 {
            sleep_retry().await;
        }
        if let Some(found) = client.resolve_most_recent(&public_key).await {
            return Ok(extract_txt(&found));
        }
    }
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_key_from_seed_is_deterministic() {
        let a = public_key_from_seed(&[9u8; 32]).unwrap();
        let b = public_key_from_seed(&[9u8; 32]).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, public_key_from_seed(&[8u8; 32]).unwrap());
    }

    #[test]
    fn seeds_must_be_32_bytes() {
        assert!(keypair_from_seed(&[0u8; 31]).is_err());
        assert!(keypair_from_seed(&[0u8; 33]).is_err());
        assert!(keypair_from_seed(&[0u8; 32]).is_ok());
    }

    #[test]
    fn parse_key_accepts_both_forms() {
        let key = public_key_from_seed(&[4u8; 32]).unwrap();
        let bare = parse_key(&key).unwrap().to_string();
        let prefixed = parse_key(&format!("did:dht:{key}")).unwrap().to_string();
        assert_eq!(bare, key);
        assert_eq!(prefixed, key);
    }

    #[test]
    fn a_built_packet_round_trips_its_txt_records() {
        // The pair that has to agree: what build_packet writes, extract_txt reads back.
        let records = vec![
            TxtRecord {
                name: "_c0".into(),
                value: "sia://one".into(),
            },
            TxtRecord {
                name: "_c1".into(),
                value: "sia://two".into(),
            },
        ];
        let packet = build_packet(&[1u8; 32], &records).unwrap();
        let back = extract_txt(&packet);
        assert_eq!(back.len(), 2);
        // Names resolve fully-qualified, so match on the prefix the callers key off.
        assert!(back[0].name.starts_with("_c0"));
        assert_eq!(back[0].value, "sia://one");
        assert!(back[1].name.starts_with("_c1"));
        assert_eq!(back[1].value, "sia://two");
    }

    #[test]
    fn an_over_long_value_is_accepted_and_round_trips() {
        // Documents a real difference from the JS client this replaces, which THREW on
        // a value past 255 bytes. simple_dns instead splits it across several TXT
        // character-strings and rejoins them on read, so it round-trips identically.
        //
        // So callers lose a guardrail: forgetting to chunk now yields a working but
        // unconventional record rather than a loud error. Chunking stays mandatory
        // anyway — it's the wire convention already-published records use, and it's
        // unrelated to the ~1000 B ceiling on the whole packet, which still applies.
        let long = "x".repeat(300);
        let records = vec![TxtRecord {
            name: "_c0".into(),
            value: long.clone(),
        }];
        let packet = build_packet(&[1u8; 32], &records).unwrap();
        let back = extract_txt(&packet);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].value, long);
    }

    #[test]
    fn chunks_and_rejoins_a_value_longer_than_one_txt_string() {
        let url = "sia://host/".to_string() + &"a".repeat(600);
        let records = chunk_txt("_c", &url);
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].name, "_c0");
        assert_eq!(records[2].name, "_c2");
        assert!(records.iter().all(|r| r.value.len() <= TXT_MAX));
        assert_eq!(rejoin_txt(&records, "_c"), url);
    }

    #[test]
    fn a_short_value_is_one_indexed_record() {
        // Most published pointers fit in one string, so this is the common case — and it
        // has to carry an index. `rejoin_txt` deliberately refuses a bare prefix, so a
        // chunker that named a single record `_c` instead of `_c0` would write pointers
        // that nothing could read back.
        let records = chunk_txt("_c", "short");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "_c0");
        assert_eq!(rejoin_txt(&records, "_c"), "short");

        // And an empty value yields nothing rather than panicking or emitting an empty
        // record. Rejoining nothing is '', which every caller already reads as "absent".
        assert!(chunk_txt("_c", "").is_empty());
        assert_eq!(rejoin_txt(&chunk_txt("_c", ""), "_c"), "");
    }

    #[test]
    fn rejoins_regardless_of_order_and_qualified_names() {
        // What a resolver actually returns: fully-qualified names, arbitrary order.
        let records = vec![
            TxtRecord {
                name: "_c1.abc123".into(),
                value: "world".into(),
            },
            TxtRecord {
                name: "_c0.abc123".into(),
                value: "hello ".into(),
            },
        ];
        assert_eq!(rejoin_txt(&records, "_c"), "hello world");
    }

    #[test]
    fn conventions_do_not_read_each_other_s_records() {
        // One packet can carry several payloads — an identity document holds `_dir`
        // alongside `_iroh` — so a prefix must match only its own chunks.
        let records = vec![
            TxtRecord {
                name: "_dir0.abc".into(),
                value: "directory".into(),
            },
            TxtRecord {
                name: "_iroh0.abc".into(),
                value: "node".into(),
            },
        ];
        assert_eq!(rejoin_txt(&records, "_dir"), "directory");
        assert_eq!(rejoin_txt(&records, "_iroh"), "node");
        assert_eq!(rejoin_txt(&records, "_c"), "");
    }

    #[test]
    fn an_absent_convention_rejoins_to_nothing() {
        assert_eq!(rejoin_txt(&[], "_c"), "");
    }
}
