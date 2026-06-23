// The Curator's serve-side RPC over iroh.
//
// Slice 4: peers dial the Curator's endpoint (ALPN "pin-keeper/0") and make
// request/response calls over a QUIC bidi stream — the serve half of the keeper
// protocol. The verb set is head / record / diff / hey; this cut implements
// `head` (the repo's signed root commit) and stubs the other three. It also runs
// a one-shot self-test on start: a throwaway client endpoint dials the node and
// confirms `head` round-trips — the first time two iroh endpoints actually
// connect in Pin (replicating the probe's proven dial-by-key pattern).
//
// Wire format per call: the dialer opens a bidi stream, writes a JSON request,
// finishes its send side; the server reads to end, writes a JSON response,
// finishes. One request/response per stream.

use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::{presets, Connection};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"pin-keeper/0";
const MAX_FRAME: usize = 64 * 1024;

/// The repo's current signed head, served by the `head` verb. An immutable
/// snapshot for this cut (repo content is static after init).
#[derive(Debug, Clone)]
pub struct Head {
    pub did: String,
    pub root: String,
    pub sig: Vec<u8>,
}

#[derive(Deserialize)]
struct Request {
    verb: String,
}

#[derive(Serialize)]
struct HeadResponse<'a> {
    did: &'a str,
    root: &'a str,
    /// Hex-encoded commit signature.
    sig: String,
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
    error: &'a str,
}

fn error_frame(msg: &str) -> Vec<u8> {
    serde_json::to_vec(&ErrorResponse { error: msg }).unwrap_or_default()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[derive(Debug, Clone)]
pub struct RpcHandler {
    head: Arc<Head>,
}

impl RpcHandler {
    pub fn new(head: Head) -> Self {
        Self {
            head: Arc::new(head),
        }
    }

    fn respond(&self, request: &[u8]) -> Vec<u8> {
        let req: Request = match serde_json::from_slice(request) {
            Ok(r) => r,
            Err(e) => return error_frame(&format!("bad request: {e}")),
        };
        match req.verb.as_str() {
            "head" => serde_json::to_vec(&HeadResponse {
                did: &self.head.did,
                root: &self.head.root,
                sig: hex_encode(&self.head.sig),
            })
            .unwrap_or_else(|e| error_frame(&format!("encode: {e}"))),
            "record" | "diff" | "hey" => error_frame(&format!("unimplemented: {}", req.verb)),
            other => error_frame(&format!("unknown verb: {other}")),
        }
    }
}

impl ProtocolHandler for RpcHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let (mut send, mut recv) = connection.accept_bi().await.map_err(AcceptError::from_err)?;
        let request = recv
            .read_to_end(MAX_FRAME)
            .await
            .map_err(AcceptError::from_err)?;
        let response = self.respond(&request);
        send.write_all(&response)
            .await
            .map_err(AcceptError::from_err)?;
        send.finish().map_err(AcceptError::from_err)?;
        connection.closed().await;
        Ok(())
    }
}

/// One-shot self-test: bind a throwaway client endpoint, dial the Curator's
/// endpoint over the RPC ALPN, call `head`, and confirm the returned root
/// matches what the repo reports. Proves serve + dial end-to-end on one machine.
pub async fn self_test(server_addr: EndpointAddr, expected_root: &str) -> Result<String, String> {
    let client = Endpoint::bind(presets::N0)
        .await
        .map_err(|e| format!("client bind: {e}"))?;

    let result = run_self_test(&client, server_addr, expected_root).await;
    client.close().await;
    result
}

async fn run_self_test(
    client: &Endpoint,
    server_addr: EndpointAddr,
    expected_root: &str,
) -> Result<String, String> {
    let conn = tokio::time::timeout(Duration::from_secs(20), client.connect(server_addr, ALPN))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| format!("connect: {e}"))?;

    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("open_bi: {e}"))?;
    send.write_all(br#"{"verb":"head"}"#)
        .await
        .map_err(|e| format!("write: {e}"))?;
    send.finish().map_err(|e| format!("finish: {e}"))?;
    let response = recv
        .read_to_end(MAX_FRAME)
        .await
        .map_err(|e| format!("read: {e}"))?;

    conn.close(0u32.into(), b"bye");

    let value: serde_json::Value =
        serde_json::from_slice(&response).map_err(|e| format!("parse: {e}"))?;
    let got_root = value.get("root").and_then(|r| r.as_str()).unwrap_or("");
    if got_root == expected_root {
        Ok("ok (head round-trip, root matches)".to_string())
    } else if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        Err(format!("server error: {err}"))
    } else {
        Err(format!("head mismatch: got {got_root}"))
    }
}
