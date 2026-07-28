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

pub use pin_rpc::{clear, new_inbox, queued, HeyHandler, ALPN};
use pin_rpc::{hey_request, parse_hey_response, MAX_FRAME};

/// One-shot self-test: bind a throwaway client endpoint, dial the Curator's endpoint
/// over the /hey ALPN, send a synthetic knock, and confirm it's accepted. Proves
/// serve + dial + the inbox path end-to-end on one machine. The caller clears the
/// inbox afterward (this knock is synthetic).
pub async fn self_test(server_addr: EndpointAddr) -> Result<String, String> {
    let client = Endpoint::bind(presets::N0)
        .await
        .map_err(|e| format!("client bind: {e}"))?;
    let result = run_self_test(&client, server_addr).await;
    client.close().await;
    result
}

async fn run_self_test(client: &Endpoint, server_addr: EndpointAddr) -> Result<String, String> {
    let conn = tokio::time::timeout(Duration::from_secs(20), client.connect(server_addr, ALPN))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| format!("connect: {e}"))?;

    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("open_bi: {e}"))?;
    send.write_all(&hey_request("did:self-test", "00", "at://self-test"))
        .await
        .map_err(|e| format!("write: {e}"))?;
    send.finish().map_err(|e| format!("finish: {e}"))?;
    let response = recv
        .read_to_end(MAX_FRAME)
        .await
        .map_err(|e| format!("read: {e}"))?;
    conn.close(0u32.into(), b"bye");

    parse_hey_response(&response)?;
    Ok("ok (hey round-trip)".to_string())
}
