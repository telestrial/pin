//! The /hey inbox knock — Pin's one PUSH primitive, served over iroh.
//!
//! iroh-docs' own sync protocol (range-based set reconciliation + live-sync over
//! gossip, on its own ALPNs) covers reads. What ALPN `pin-keeper/0` carries is the
//! thing sync can't: a peer telling us it did something about us. `{ from, sig,
//! referent }` — "I did something about this" — gets accepted and parked. The
//! reconcile loop (not yet built) is what drains the inbox: verify the sig, fetch
//! the referent, materialize an index record.
//!
//! Accepting-and-parking is deliberately the whole job here. A knock is tiny and
//! rare, and store-and-forward retry lives on the sender, so the inbox tolerates an
//! offline receiver — which is why it can ship before the harder reconcile work.
//!
//! **Every instance that's up serves this**, browser tab or desktop. A tab has no
//! listening socket, so inbound arrives over the relay it already holds rather than
//! a direct path, but it answers the same protocol — hence one shared crate instead
//! of a native copy and a wasm copy that could drift apart.
//!
//! Wire format per call: the dialer opens a bidi stream, writes a JSON request,
//! finishes its send side; the server reads to end, writes a JSON response, finishes.

use std::sync::{Arc, Mutex};

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"pin-keeper/0";

/// Per-frame read cap. A /hey knock is a few small fields, so this is generous.
pub const MAX_FRAME: usize = 64 * 1024;

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

/// A fresh, empty inbox.
pub fn new_inbox() -> HeyInbox {
    Arc::new(Mutex::new(Vec::new()))
}

/// How many knocks are parked — what diagnostics report.
pub fn queued(inbox: &HeyInbox) -> usize {
    inbox.lock().map(|i| i.len()).unwrap_or(0)
}

/// Drop every parked knock. Used after a synthetic self-test knock so real knocks
/// start counting from zero.
pub fn clear(inbox: &HeyInbox) {
    if let Ok(mut i) = inbox.lock() {
        i.clear();
    }
}

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

/// Serves the /hey inbox knock over iroh (ALPN `pin-keeper/0`).
#[derive(Debug, Clone)]
pub struct HeyHandler {
    inbox: HeyInbox,
}

impl HeyHandler {
    pub fn new(inbox: HeyInbox) -> Self {
        Self { inbox }
    }

    /// Handle one request frame, returning the response frame. Pure over the inbox,
    /// so it's directly testable without a network.
    pub fn respond(&self, request: &[u8]) -> Vec<u8> {
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
            inbox.push(Knock {
                from,
                sig,
                referent,
            });
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

/// The request frame a dialer sends for a `hey` knock. Here so a caller doesn't
/// hand-write the JSON and drift from what `respond` parses.
pub fn hey_request(from: &str, sig: &str, referent: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "verb": "hey",
        "from": from,
        "sig": sig,
        "referent": referent,
    }))
    .unwrap_or_default()
}

/// Read a response frame's `accepted` flag, or the server's error message.
pub fn parse_hey_response(response: &[u8]) -> Result<(), String> {
    let v: serde_json::Value =
        serde_json::from_slice(response).map_err(|e| format!("parse: {e}"))?;
    if v.get("accepted").and_then(|a| a.as_bool()) == Some(true) {
        return Ok(());
    }
    Err(match v.get("error").and_then(|e| e.as_str()) {
        Some(err) => format!("hey server error: {err}"),
        None => "hey not accepted".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_well_formed_knock_is_accepted_and_parked() {
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        let response = handler.respond(&hey_request("did:x", "00", "at://y"));
        assert!(parse_hey_response(&response).is_ok());
        assert_eq!(queued(&inbox), 1);
        let knock = inbox.lock().unwrap()[0].clone();
        assert_eq!(knock.from, "did:x");
        assert_eq!(knock.referent, "at://y");
    }

    #[test]
    fn an_incomplete_knock_is_rejected_and_parks_nothing() {
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        let response = handler.respond(br#"{"verb":"hey","from":"did:x"}"#);
        assert!(parse_hey_response(&response).is_err());
        assert_eq!(queued(&inbox), 0);
    }

    #[test]
    fn an_unknown_verb_is_rejected() {
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        assert!(parse_hey_response(&handler.respond(br#"{"verb":"nope"}"#)).is_err());
        assert!(parse_hey_response(&handler.respond(b"not json")).is_err());
        assert_eq!(queued(&inbox), 0);
    }

    #[test]
    fn clear_empties_the_inbox() {
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        handler.respond(&hey_request("did:x", "00", "at://y"));
        clear(&inbox);
        assert_eq!(queued(&inbox), 0);
    }
}
