// Native-side glue for the /hey inbox knock.
//
// The protocol itself — ALPN, wire frames, the inbox, the ProtocolHandler — lives in
// the shared `pin-rpc` crate, because the browser instance serves the identical
// protocol (pin-core registers the same handler) and a divergence between the two
// would be a protocol bug. What's left here is the one piece that's genuinely
// native-only: a self-test that binds a throwaway second endpoint and dials our own
// node, which is a diagnostic rather than part of the protocol.

use std::time::Duration;

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr};

pub use pin_rpc::{clear, new_inbox, queued, HeyHandler, HeyInbox, ALPN};
use pin_rpc::{hey_request, MAX_FRAME};

/// How long to wait for a sent knock to show up in the inbox.
///
/// The knock is answered with silence, so landing it is observed on OUR side rather
/// than reported back — which means waiting for the server task to get to it.
const LANDING_TIMEOUT: Duration = Duration::from_secs(5);

/// One-shot self-test: bind a throwaway client endpoint, dial the Curator's endpoint
/// over the /hey ALPN, send a synthetic knock, and confirm it lands in the inbox.
/// Proves serve + dial + the inbox path end-to-end on one machine.
///
/// It watches the INBOX rather than a reply, because there is no reply — a knock is a
/// unidirectional stream by design. That makes this a stronger check than the ack it
/// replaces: an ack only said the frame was received, where inbox depth says it was
/// understood and parked. The caller clears the inbox afterward, since this knock is
/// synthetic.
pub async fn self_test(server_addr: EndpointAddr, inbox: &HeyInbox) -> Result<String, String> {
    let client = Endpoint::bind(presets::N0)
        .await
        .map_err(|e| format!("client bind: {e}"))?;
    let result = run_self_test(&client, server_addr, inbox).await;
    client.close().await;
    result
}

async fn run_self_test(
    client: &Endpoint,
    server_addr: EndpointAddr,
    inbox: &HeyInbox,
) -> Result<String, String> {
    let before = queued(inbox);

    let conn = tokio::time::timeout(Duration::from_secs(20), client.connect(server_addr, ALPN))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| format!("connect: {e}"))?;

    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("open_bi: {e}"))?;
    send.write_all(&hey_request(&synthetic_record()))
        .await
        .map_err(|e| format!("write: {e}"))?;
    send.finish().map_err(|e| format!("finish: {e}"))?;
    // Empty by protocol; completing is what says the frame was taken.
    recv.read_to_end(MAX_FRAME)
        .await
        .map_err(|e| format!("read: {e}"))?;

    // Still watched on THIS side rather than inferred from the read: inbox depth says the
    // knock was understood and parked, where the read only says it was consumed.
    let landed = wait_for_landing(inbox, before).await;
    conn.close(0u32.into(), b"bye");

    if landed {
        Ok("ok (hey knock landed)".to_string())
    } else {
        Err("knock sent but never reached the inbox".to_string())
    }
}

/// Poll until the inbox grows, or the timeout runs out.
async fn wait_for_landing(inbox: &HeyInbox, before: usize) -> bool {
    let deadline = tokio::time::Instant::now() + LANDING_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if queued(inbox) > before {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

/// A well-formed but unsigned record. The handler parks without verifying — that is the
/// drain's job — so this exercises the transport without needing an identity.
fn synthetic_record() -> serde_json::Value {
    serde_json::json!({
        "kind": "like",
        "actor": "did:dht:self-test",
        "subject": "self-test",
        "version": "self-test",
        "createdAt": "1970-01-01T00:00:00.000Z",
        "sig": "",
    })
}
