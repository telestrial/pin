//! The /hey inbox knock — Pin's one PUSH primitive, served over iroh.
//!
//! iroh-docs' own sync protocol (range-based set reconciliation + live-sync over
//! gossip, on its own ALPNs) covers reads. What ALPN `pin-keeper/0` carries is the
//! thing sync can't: a peer telling us it did something about us. Everything else in
//! the system is pull-shaped — a crawl finds what people in your graph endorsed — and a
//! knock is how someone OUTSIDE that graph reaches you at all.
//!
//! **The knock carries the signed record**, not a pointer to one. Both halves of what
//! atproto calls a strongRef: the record says what was asserted, and it verifies against
//! the actor named on it with no lookup, no packet, and no prior contact, because a
//! `did:dht` IS its ed25519 public key. So a stranger's knock costs a parse and one
//! signature check, and we never fetch them — which is what makes accepting knocks from
//! outside the graph affordable in the first place.
//!
//! **The record travels as opaque JSON.** This crate is a courier: it does not parse an
//! endorsement, so it cannot corrupt one, and a later rung of the ladder (a comment, an
//! access request for a private channel) needs no change here to pass through. The same
//! posture the identity loop takes when it publishes endorsements verbatim.
//!
//! **There is no reply.** One unidirectional stream per knock: the dialer writes and
//! finishes, and that is the whole exchange. A response frame would be a timing oracle —
//! how long we take to answer distinguishes "verified" from "dropped at the door" from
//! "not running", and lets a flooder tune against us — while telling the sender nothing
//! QUIC hasn't already: the stream closed, so it landed. Silence is the only reliably
//! constant answer, and it collapses four observable states into one.
//!
//! Accepting-and-parking is deliberately the whole job. The reconcile loop is what
//! drains the inbox — verify the signature, match the subject against what this identity
//! publishes, fold it into a count. Store-and-forward retry lives on the sender, so the
//! inbox tolerates an offline receiver.
//!
//! **Every instance that's up serves this**, browser tab or desktop. A tab has no
//! listening socket, so inbound arrives over the relay it already holds rather than
//! a direct path, but it answers the same protocol — hence one shared crate instead
//! of a native copy and a wasm copy that could drift apart.

use std::sync::{Arc, Mutex};

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"pin-keeper/0";

/// Per-frame read cap. A knock is one signed record — a few hundred bytes — so this is
/// generous, and it is a read bound rather than an allocation.
pub const MAX_FRAME: usize = 64 * 1024;

/// How many knocks may be parked at once.
///
/// The inbox is in memory and nothing drains it yet, so it needs a ceiling: without one
/// a peer could grow it until the process dies, and there is no reply through which to
/// signal backpressure. When it is full a knock is DROPPED rather than evicting an older
/// one — a flooder should not be able to push real knocks out — and the sender's own
/// retry is what recovers it once the drain has made room.
pub const MAX_INBOX: usize = 1024;

#[derive(Serialize, Deserialize)]
struct Request {
    verb: String,
    /// `hey`: the signed record, exactly as its author wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    record: Option<serde_json::Value>,
}

/// An inbound knock, parked until the reconcile loop drains it.
///
/// It carries only the record, because the record names its own actor. Repeating that
/// outside it would be two places for one fact and a claim to cross-check — and the copy
/// outside the signature is the one that could lie.
#[derive(Debug, Clone)]
pub struct Knock {
    pub record: serde_json::Value,
}

/// The `hey` inbox: knocks accepted but not yet reconciled. In-memory — a knock lost to
/// a restart is one the sender retries. A std mutex (not tokio), since it is only ever
/// held for a push or a read with no await in between.
pub type HeyInbox = Arc<Mutex<Vec<Knock>>>;

/// A fresh, empty inbox.
pub fn new_inbox() -> HeyInbox {
    Arc::new(Mutex::new(Vec::new()))
}

/// How many knocks are parked — what diagnostics report, and what the drain works
/// through.
pub fn queued(inbox: &HeyInbox) -> usize {
    inbox.lock().map(|i| i.len()).unwrap_or(0)
}

/// Take everything parked, leaving the inbox empty.
pub fn drain(inbox: &HeyInbox) -> Vec<Knock> {
    inbox
        .lock()
        .map(|mut i| std::mem::take(&mut *i))
        .unwrap_or_default()
}

/// Drop every parked knock. Used after a synthetic self-test knock so real knocks
/// start counting from zero.
pub fn clear(inbox: &HeyInbox) {
    if let Ok(mut i) = inbox.lock() {
        i.clear();
    }
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

    /// Take one request frame. Returns whether it was parked.
    ///
    /// Pure over the inbox, so it is directly testable without a network. The return
    /// value is for tests and diagnostics — nothing is sent back to the knocker, whether
    /// this succeeded or not.
    pub fn accept_knock(&self, request: &[u8]) -> bool {
        let Ok(req) = serde_json::from_slice::<Request>(request) else {
            return false;
        };
        if req.verb != "hey" {
            return false;
        }
        let Some(record) = req.record else {
            return false;
        };
        let Ok(mut inbox) = self.inbox.lock() else {
            return false;
        };
        if inbox.len() >= MAX_INBOX {
            return false;
        }
        inbox.push(Knock { record });
        true
    }
}

impl ProtocolHandler for HeyHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        // One knock per unidirectional stream, many streams per connection, until the
        // peer closes. Nothing is written back on any of them.
        loop {
            let mut recv = match connection.accept_uni().await {
                Ok(s) => s,
                // Peer closed the connection: clean end of the session.
                Err(_) => return Ok(()),
            };
            let request = recv
                .read_to_end(MAX_FRAME)
                .await
                .map_err(AcceptError::from_err)?;
            // A frame we can't use is dropped in silence, the same as one we can. Telling
            // a knocker which it was is the oracle this protocol declines to be.
            self.accept_knock(&request);
        }
    }
}

/// The request frame a dialer sends for a `hey` knock. Here so a caller doesn't
/// hand-write the JSON and drift from what the handler parses.
pub fn hey_request(record: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&Request {
        verb: "hey".to_string(),
        record: Some(record.clone()),
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> serde_json::Value {
        serde_json::json!({
            "kind": "like",
            "actor": "did:dht:someone",
            "subject": "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a",
            "version": "bafkreisomething",
            "createdAt": "2026-08-11T12:00:00.000Z",
            "sig": "Zm9vYmFy",
        })
    }

    #[test]
    fn a_knock_parks_the_record_it_carried() {
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        assert!(handler.accept_knock(&hey_request(&record())));
        assert_eq!(queued(&inbox), 1);
        assert_eq!(inbox.lock().unwrap()[0].record, record());
    }

    #[test]
    fn a_record_survives_the_wire_verbatim() {
        // The signature is checked against fields read off this record, so anything the
        // frame did to it on the way through would be a knock that can never verify.
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        handler.accept_knock(&hey_request(&record()));
        let parked = inbox.lock().unwrap()[0].record.clone();
        assert_eq!(
            serde_json::to_string(&parked).unwrap(),
            serde_json::to_string(&record()).unwrap()
        );
    }

    #[test]
    fn a_knock_with_no_record_parks_nothing() {
        // A knock used to be a pointer, and a pointer without a record is what this
        // protocol no longer accepts: there is nothing to verify and nothing to count.
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        assert!(!handler.accept_knock(br#"{"verb":"hey"}"#));
        assert_eq!(queued(&inbox), 0);
    }

    #[test]
    fn an_unknown_verb_or_unparseable_frame_parks_nothing() {
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        assert!(!handler.accept_knock(br#"{"verb":"nope","record":{}}"#));
        assert!(!handler.accept_knock(b"not json"));
        assert_eq!(queued(&inbox), 0);
    }

    #[test]
    fn a_full_inbox_refuses_rather_than_growing() {
        // Nothing drains it yet and there is no reply to signal backpressure, so the
        // ceiling is what stops a peer growing it until the process dies.
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        let frame = hey_request(&record());
        for _ in 0..MAX_INBOX {
            assert!(handler.accept_knock(&frame));
        }
        assert!(!handler.accept_knock(&frame));
        assert_eq!(queued(&inbox), MAX_INBOX);
    }

    #[test]
    fn a_full_inbox_keeps_the_knocks_it_already_has() {
        // Dropping the NEWEST rather than evicting the oldest, so a flooder cannot push
        // real knocks out of a full inbox.
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        let mut first = record();
        first["sig"] = serde_json::Value::String("first".into());
        handler.accept_knock(&hey_request(&first));
        for _ in 1..MAX_INBOX {
            handler.accept_knock(&hey_request(&record()));
        }
        handler.accept_knock(&hey_request(&record()));
        assert_eq!(inbox.lock().unwrap()[0].record["sig"], "first");
    }

    #[test]
    fn draining_takes_everything_and_leaves_the_inbox_empty() {
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        handler.accept_knock(&hey_request(&record()));
        handler.accept_knock(&hey_request(&record()));
        assert_eq!(drain(&inbox).len(), 2);
        assert_eq!(queued(&inbox), 0);
    }

    #[test]
    fn clear_empties_the_inbox() {
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        handler.accept_knock(&hey_request(&record()));
        clear(&inbox);
        assert_eq!(queued(&inbox), 0);
    }
}
