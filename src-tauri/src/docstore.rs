// The iroh-docs engine — candidate replacement for the atrium repo + hand-rolled
// 4-verb RPC (see CLAUDE.md 2026-07-05). iroh-docs is a multi-author synced KV:
// range-based set reconciliation (ships only the delta, not the whole set),
// live-sync over gossip, content-addressed values via iroh-blobs. In the swap it
// subsumes the repo engine AND the pull loop — importing a peer's doc and letting
// it sync IS "network surfacing," with no separate loop to hand-roll.
//
// Step 2 (this slice): stand the engine up INSIDE the real keeper binary and prove
// surfacing works there — two namespaces reconcile in-process, a live write
// propagates, and a small divergence transfers only the delta. This is the spike's
// surfacing proof (CLAUDE.md 2026-07-05) ported into the app so we confirm the deps
// link and the API runs under the keeper's own tokio runtime, not just a standalone
// probe. It runs ALONGSIDE the atrium repo (still the durable store) and is
// in-memory + logged only. Cutover — docs on the keeper's own endpoint, a
// persistent redb store, and removing atrium — is the next slice.
//
// Identity binding: the namespace + author keys derive from the same Sia AppKey the
// rest of the keeper's identity hangs off (HKDF, domain-separated `info`), so the
// keeper's doc is recoverable from the recovery phrase, same one-root-secret move
// as the did:dht key and settings encryption.

use std::time::Duration;

use futures_lite::{Stream, StreamExt};
use hkdf::Hkdf;
use iroh::{endpoint::presets, protocol::Router, Endpoint};
use iroh_blobs::{store::mem::MemStore, BlobsProtocol, ALPN as BLOBS_ALPN};
use iroh_docs::{
    api::protocol::{AddrInfoOptions, ShareMode},
    engine::LiveEvent,
    protocol::Docs,
    store::Query,
    Author, Capability, NamespaceSecret, ALPN as DOCS_ALPN,
};
use iroh_gossip::{net::Gossip, ALPN as GOSSIP_ALPN};
use sha2::Sha256;
use tokio::time::timeout;

/// HKDF `info`s for the doc keys — domain-separated from the did:dht identity
/// (`pin:did-dht:v1`), the atproto signing key (`pin:atproto-signing:v1`), and
/// settings (`pin:settings:v1`), all off the same AppKey root.
const NS_INFO: &[u8] = b"pin:iroh-docs-namespace:v1";
const AUTHOR_INFO: &[u8] = b"pin:iroh-docs-author:v1";

/// The keeper's marker entry, mirroring the atrium repo's marker record — a known
/// key we write and read back to prove the engine (and, post-sync, surfacing).
const MARKER_KEY: &[u8] = b"dev.sia.pin.marker/self";

/// HKDF-SHA256 → 32 bytes. 32 is always a valid output length.
fn hkdf32(ikm: &[u8], info: &[u8]) -> Result<[u8; 32], String> {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut okm = [0u8; 32];
    hk.expand(info, &mut okm)
        .map_err(|e| format!("hkdf expand: {e}"))?;
    Ok(okm)
}

/// Decode the 32-byte Sia AppKey from its hex form (the HKDF IKM).
fn decode_app_key(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// A full keeper-shaped iroh-docs stack: one endpoint + blobs + gossip + docs,
/// wired through an ALPN-multiplexed Router — exactly the shape the real keeper
/// serves under. In-memory for this slice.
struct Stack {
    endpoint: Endpoint,
    docs: Docs,
    _blobs: MemStore,
    _router: Router,
}

impl Stack {
    async fn spawn() -> Result<Self, String> {
        let endpoint = Endpoint::bind(presets::N0)
            .await
            .map_err(|e| format!("endpoint bind: {e}"))?;
        let blobs = MemStore::default();
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await
            .map_err(|e| format!("docs spawn: {e}"))?;
        let router = Router::builder(endpoint.clone())
            .accept(BLOBS_ALPN, BlobsProtocol::new(&blobs, None))
            .accept(GOSSIP_ALPN, gossip)
            .accept(DOCS_ALPN, docs.clone())
            .spawn();
        // Wait for reachability so the share ticket carries usable addresses.
        let _ = timeout(Duration::from_secs(10), endpoint.online()).await;
        Ok(Stack {
            endpoint,
            docs,
            _blobs: blobs,
            _router: router,
        })
    }

    async fn shutdown(self) {
        self.endpoint.close().await;
    }
}

/// Drive a doc's LiveEvent stream until `pred` matches or we time out. Generic over
/// the stream's error type so we don't pull in anyhow (iroh-docs yields
/// `Result<LiveEvent, _>`).
async fn wait_event<S, E>(
    stream: &mut S,
    secs: u64,
    mut pred: impl FnMut(&LiveEvent) -> bool,
) -> bool
where
    S: Stream<Item = Result<LiveEvent, E>> + Unpin,
{
    timeout(Duration::from_secs(secs), async {
        while let Some(Ok(ev)) = stream.next().await {
            if pred(&ev) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

/// Prove the iroh-docs engine surfaces network content from inside the real keeper:
/// bring up two in-process stacks, derive the doc's namespace + author from the
/// keeper's AppKey, and confirm (1) B reconciles A's full set, (2) a live write on A
/// surfaces on B, (3) a small divergence transfers only the delta. Returns a summary
/// on success. (1) and (2) are hard — they prove surfacing works at all; (3) is the
/// RBSR efficiency observation (soft — reported, never fatal).
pub async fn surfacing_self_test(app_key_hex: &str) -> Result<String, String> {
    let app_key = decode_app_key(app_key_hex).ok_or("app key hex must be 32 bytes")?;
    let ns_seed = hkdf32(&app_key, NS_INFO)?;
    let author_seed = hkdf32(&app_key, AUTHOR_INFO)?;

    let a = Stack::spawn().await?;
    let author = Author::from_bytes(&author_seed);
    let author_id = author.id();
    a.docs
        .author_import(author)
        .await
        .map_err(|e| format!("author import: {e}"))?;
    let ns = NamespaceSecret::from_bytes(&ns_seed);
    let doc_a = a
        .docs
        .import_namespace(Capability::Write(ns))
        .await
        .map_err(|e| format!("import namespace: {e}"))?;

    // Seed the doc: the marker plus a handful of entries so reconciliation has a
    // real set to move.
    doc_a
        .set_bytes(author_id, MARKER_KEY.to_vec(), b"curator doc online".to_vec())
        .await
        .map_err(|e| format!("set marker: {e}"))?;
    const N: usize = 20;
    for i in 0..N {
        doc_a
            .set_bytes(
                author_id,
                format!("item/{i:04}").into_bytes(),
                format!("body-{i}").into_bytes(),
            )
            .await
            .map_err(|e| format!("set item: {e}"))?;
    }
    let count_a = doc_a
        .get_many(Query::all().build())
        .await
        .map_err(|e| format!("count A: {e}"))?
        .count()
        .await;

    // (1) Full reconcile: B imports A's ticket and should converge to A's set.
    let b = Stack::spawn().await?;
    let ticket = doc_a
        .share(ShareMode::Write, AddrInfoOptions::RelayAndAddresses)
        .await
        .map_err(|e| format!("share: {e}"))?;
    let (doc_b, mut events_b) = b
        .docs
        .import_and_subscribe(ticket)
        .await
        .map_err(|e| format!("import ticket: {e}"))?;
    let mut received = 0usize;
    let synced = wait_event(&mut events_b, 30, |ev| match ev {
        LiveEvent::SyncFinished(s) => {
            if let Ok(d) = &s.result {
                received = d.entries_received;
            }
            true
        }
        _ => false,
    })
    .await;
    if !synced {
        a.shutdown().await;
        b.shutdown().await;
        return Err("no SyncFinished within 30s (surfacing failed)".into());
    }
    let count_b = doc_b
        .get_many(Query::all().build())
        .await
        .map_err(|e| format!("count B: {e}"))?
        .count()
        .await;
    if count_b != count_a {
        a.shutdown().await;
        b.shutdown().await;
        return Err(format!(
            "B did not converge: A={count_a}, B={count_b} (received {received})"
        ));
    }

    // (2) Live sync: a NEW write on A must reach B via the subscription, no re-poll.
    doc_a
        .set_bytes(author_id, b"live/marker".to_vec(), b"pushed live".to_vec())
        .await
        .map_err(|e| format!("set live: {e}"))?;
    let live = wait_event(&mut events_b, 20, |ev| {
        matches!(ev, LiveEvent::InsertRemote { entry, .. } if entry.key() == b"live/marker")
    })
    .await;
    if !live {
        a.shutdown().await;
        b.shutdown().await;
        return Err("live write did not surface on B within 20s".into());
    }

    // (3) RBSR delta (soft): diverge A by a few entries, re-sync, and observe that
    // reconciliation transfers ~the delta, not the whole set. Drop live sync first
    // so the next round is a clean reconcile.
    doc_b.leave().await.ok();
    tokio::time::sleep(Duration::from_millis(500)).await;
    const DELTA: usize = 3;
    for i in 0..DELTA {
        doc_a
            .set_bytes(
                author_id,
                format!("delta/{i}").into_bytes(),
                format!("delta-body-{i}").into_bytes(),
            )
            .await
            .map_err(|e| format!("set delta: {e}"))?;
    }
    let mut events_b2 = doc_b
        .subscribe()
        .await
        .map_err(|e| format!("resubscribe: {e}"))?;
    doc_b
        .start_sync(vec![a.endpoint.addr()])
        .await
        .map_err(|e| format!("start_sync: {e}"))?;
    let mut delta_received: Option<usize> = None;
    wait_event(&mut events_b2, 30, |ev| match ev {
        LiveEvent::SyncFinished(s) => {
            if let Ok(d) = &s.result {
                delta_received = Some(d.entries_received);
            }
            true
        }
        _ => false,
    })
    .await;
    let delta_note = match delta_received {
        Some(r) if r <= DELTA + 1 => format!("delta sync received {r} (only the delta)"),
        Some(r) => format!("delta sync received {r} (expected ~{DELTA} — observe)"),
        None => "delta sync did not report (soft)".to_string(),
    };

    a.shutdown().await;
    b.shutdown().await;
    Ok(format!(
        "ok (B reconciled {count_b}/{count_a}, live ok, {delta_note})"
    ))
}
