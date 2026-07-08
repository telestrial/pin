// The Curator's serve-side RPC over iroh — the /hey inbox knock.
//
// After the iroh-docs cutover, the old head/record/diff verbs are gone: iroh-docs'
// own sync protocol (range-based set reconciliation + live-sync over gossip, on its
// own ALPNs) subsumes them. What remains on ALPN "pin-keeper/0" is /hey — the one
// PUSH primitive atproto lacks: a peer hands us `{ from, sig, referent }` ("I did
// something about this") and we enqueue it. The reconcile loop (not yet built) is
// what drains the inbox: verify the sig, fetch the referent, materialize an index
// record. This slice just accepts + parks the knock.
//
// Wire format per call: the dialer opens a bidi stream, writes a JSON request,
// finishes its send side; the server reads to end, writes a JSON response, finishes.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::endpoint::{presets, Connection};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"pin-keeper/0";
// Per-frame read cap. A /hey knock is a few small fields, so this is generous.
const MAX_FRAME: usize = 64 * 1024;

#[derive(Deserialize)]
struct Request {
    verb: String,
    /// `hey`: the knocking party (DID or node id).
    #[serde(default)]
    from: Option<String>,
    /// `hey`: hex signature over the knock (not verified yet — that's reconcile).
    #[serde(default)]
    sig: Option<String>,
    /// `hey`: the AT-URI the knock is about ("I did something about this").
    #[serde(default)]
    referent: Option<String>,
}

/// An inbound knock parked in the inbox until the reconcile loop drains it (fetch
/// the referent, verify the sig, materialize an index record). None of that happens
/// yet — we just hold the pointer, so the fields are stored but not yet read.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Knock {
    pub from: String,
    pub sig: String,
    pub referent: String,
}

/// The `hey` inbox: knocks accepted but not yet reconciled. In-memory for now;
/// persisting + draining it is the reconcile slice. A std mutex (not tokio) — it's
/// only ever held for a push/read with no await in between.
pub type HeyInbox = Arc<Mutex<Vec<Knock>>>;

#[derive(Serialize)]
struct HeyResponse {
    accepted: bool,
    /// Inbox depth after enqueuing — lets the knocker (and our diagnostics) see the
    /// knock landed.
    queued: usize,
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
    error: &'a str,
}

fn error_frame(msg: &str) -> Vec<u8> {
    serde_json::to_vec(&ErrorResponse { error: msg }).unwrap_or_default()
}

/// Serves the /hey inbox knock over iroh (ALPN "pin-keeper/0").
#[derive(Debug, Clone)]
pub struct HeyHandler {
    inbox: HeyInbox,
}

impl HeyHandler {
    pub fn new(inbox: HeyInbox) -> Self {
        Self { inbox }
    }

    fn respond(&self, request: &[u8]) -> Vec<u8> {
        let req: Request = match serde_json::from_slice(request) {
            Ok(r) => r,
            Err(e) => return error_frame(&format!("bad request: {e}")),
        };
        match req.verb.as_str() {
            "hey" => self.respond_hey(req.from, req.sig, req.referent),
            other => error_frame(&format!("unknown verb: {other}")),
        }
    }

    fn respond_hey(
        &self,
        from: Option<String>,
        sig: Option<String>,
        referent: Option<String>,
    ) -> Vec<u8> {
        let (Some(from), Some(sig), Some(referent)) = (from, sig, referent) else {
            return error_frame("hey requires from, sig, and referent");
        };
        // Park the knock. We don't verify the sig or fetch the referent here — that's
        // the reconcile loop. Acceptance just means "received and queued."
        let queued = {
            let mut inbox = self.inbox.lock().unwrap();
            inbox.push(Knock { from, sig, referent });
            inbox.len()
        };
        serde_json::to_vec(&HeyResponse {
            accepted: true,
            queued,
        })
        .unwrap_or_else(|e| error_frame(&format!("encode: {e}")))
    }
}

impl ProtocolHandler for HeyHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        // Service requests until the peer closes the connection — one
        // request/response per bidi stream, many streams per connection.
        loop {
            let (mut send, mut recv) = match connection.accept_bi().await {
                Ok(s) => s,
                // Peer closed the connection: clean end of the session.
                Err(_) => return Ok(()),
            };
            let request = recv
                .read_to_end(MAX_FRAME)
                .await
                .map_err(AcceptError::from_err)?;
            let response = self.respond(&request);
            send.write_all(&response)
                .await
                .map_err(AcceptError::from_err)?;
            send.finish().map_err(AcceptError::from_err)?;
        }
    }
}

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
    send.write_all(br#"{"verb":"hey","from":"did:self-test","sig":"00","referent":"at://self-test"}"#)
        .await
        .map_err(|e| format!("write: {e}"))?;
    send.finish().map_err(|e| format!("finish: {e}"))?;
    let response = recv
        .read_to_end(MAX_FRAME)
        .await
        .map_err(|e| format!("read: {e}"))?;
    conn.close(0u32.into(), b"bye");

    let v: serde_json::Value =
        serde_json::from_slice(&response).map_err(|e| format!("parse: {e}"))?;
    if v.get("accepted").and_then(|a| a.as_bool()) == Some(true) {
        Ok("ok (hey round-trip)".to_string())
    } else {
        Err(match v.get("error").and_then(|e| e.as_str()) {
            Some(err) => format!("hey server error: {err}"),
            None => "hey not accepted".to_string(),
        })
    }
}
