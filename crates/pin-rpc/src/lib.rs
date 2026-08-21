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
//! **The reply is empty, and it means custody.** A knock rides one bidirectional stream:
//! the dialer writes and finishes, and the receiver reads and closes its side without
//! writing a byte — but only if it parked the knock. If it did not, it RESETS the stream,
//! so the sender's read fails. Acknowledged means we have it and the sender is done;
//! anything else means draw no conclusion and come back.
//!
//! It was unidirectional first, and that was wrong twice over. `finish()` closes the LOCAL
//! side of a stream and says nothing about the peer having read anything, so a sender that
//! finished and immediately closed the connection tore the stream down underneath the
//! receiver's read — knocks counted as delivered that never arrived. Making it
//! bidirectional fixed the tear-down and left the second half: the reply acknowledged
//! unconditionally, so a knock dropped for a full inbox was reported as landed and never
//! retried. Out-of-graph engagement has no other route, so that is a count permanently
//! short.
//!
//! Refusal is deliberately indistinguishable from unreachability — a reset reads the same
//! as an offline node, a bad network, or a relay dropping the connection. So withholding
//! the ack is the backpressure signal, and it is the hook a sanction would hang on without
//! introducing any state a prober could observe. What the original silence was protecting
//! survives: the reply carries no bytes, and it is decided before anything is verified
//! (that is the reconcile loop's job, minutes later), so it reveals nothing about whether a
//! signature checked, whether the subject was ours, or whether a count moved. The only
//! thing a sender learns is whether we took the frame, which is the only thing it needs.
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

use iroh::endpoint::{Connection, VarInt};
use iroh::protocol::{AcceptError, ProtocolHandler};
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"pin-keeper/0";

/// Per-frame read cap. A knock is one signed record — a few hundred bytes — so this is
/// generous, and it is a read bound rather than an allocation.
pub const MAX_FRAME: usize = 64 * 1024;

/// How many knocks may be parked at once.
///
/// The inbox is in memory, so it needs a ceiling: without one a peer could grow it until
/// the process dies. When it is full a knock is DROPPED rather than evicting an older one
/// — a flooder should not be able to push real knocks out — and the stream is refused
/// rather than acknowledged, so the sender keeps it outstanding and comes back once the
/// drain has made room.
pub const MAX_INBOX: usize = 1024;

/// Sent when a knock is refused, to reset the stream rather than close it cleanly.
///
/// The code itself is never read: a sender only needs its read to fail, and reading a
/// reason out of a refusal would be a response frame by another name.
const REFUSED: VarInt = VarInt::from_u32(1);

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
///
/// It carries a signal as well as the knocks, so the loop that drains it can wait to be
/// told rather than look on a timer. Without one a knock sits until the reconcile cadence
/// comes round, which is the whole delay between someone liking a post and its author
/// counting it — and a cadence short enough to hide that would be a poll running forever
/// for something that happens rarely.
#[derive(Debug, Clone)]
pub struct HeyInbox {
    parked: Arc<Mutex<Vec<Knock>>>,
    /// Capacity one, and sent with `try_send`. The drain takes everything at once, so one
    /// pending signal says exactly as much as a hundred would; a full channel means a
    /// wake is already owed and dropping the extra loses nothing.
    tell: async_channel::Sender<()>,
    told: async_channel::Receiver<()>,
}

/// A fresh, empty inbox.
pub fn new_inbox() -> HeyInbox {
    let (tell, told) = async_channel::bounded(1);
    HeyInbox {
        parked: Arc::new(Mutex::new(Vec::new())),
        tell,
        told,
    }
}

/// Wait until something is parked.
///
/// Returns immediately when a wake is already owed — including one for a knock the
/// cadence happened to drain first, which costs one extra pass over an empty inbox and
/// nothing else. The alternative, clearing the signal on drain, would race a knock landing
/// between the drain and the clear and lose the wake for it.
///
/// Safe to drop half-finished, which the caller does on every cadence that wins the race:
/// the wake is a queued message rather than an edge, so one that arrives while nobody is
/// waiting stays queued and the next call takes it.
///
/// Never returns if the inbox is dropped, which only happens as the engine goes away: the
/// caller races this against its own cadence, so a dead signal degrades to that cadence
/// rather than stalling.
pub async fn wait(inbox: &HeyInbox) {
    let _ = inbox.told.recv().await;
}

/// How many knocks are parked — what diagnostics report, and what the drain works
/// through.
pub fn queued(inbox: &HeyInbox) -> usize {
    inbox.parked.lock().map(|i| i.len()).unwrap_or(0)
}

/// Take everything parked, leaving the inbox empty.
pub fn drain(inbox: &HeyInbox) -> Vec<Knock> {
    inbox
        .parked
        .lock()
        .map(|mut i| std::mem::take(&mut *i))
        .unwrap_or_default()
}

/// Drop every parked knock. Used after a synthetic self-test knock so real knocks
/// start counting from zero.
pub fn clear(inbox: &HeyInbox) {
    if let Ok(mut i) = inbox.parked.lock() {
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
    /// value is what the handler answers on: parked is acknowledged, anything else — a
    /// frame we can't read, a full inbox — is refused.
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
        let Ok(mut parked) = self.inbox.parked.lock() else {
            return false;
        };
        if parked.len() >= MAX_INBOX {
            return false;
        }
        parked.push(Knock { record });
        // Released before signalling: the waiter is woken to take this lock, and holding
        // it across the wake would hand it a lock we still own.
        drop(parked);
        // Only after a knock is actually parked, so a wake always has something behind it.
        // Full means a wake is already owed, which is as much as this one would say.
        let _ = self.inbox.tell.try_send(());
        true
    }
}

impl ProtocolHandler for HeyHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        // One knock per stream, many streams per connection, until the peer closes.
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
            // Answered on custody alone, and decided here rather than after the drain
            // verifies anything — so the one bit a knocker can read is whether we took
            // the frame, never what we made of it.
            if self.accept_knock(&request) {
                send.finish().map_err(AcceptError::from_err)?;
            } else {
                // Withholding the ack has to be a deliberate act: dropping a `SendStream`
                // finishes it, so omission would still acknowledge. Resetting is what
                // makes the sender's read fail, which is how it knows to keep the knock
                // outstanding and try again.
                let _ = send.reset(REFUSED);
            }
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

    /// Drive one real knock over one real connection, and report whether the SENDER's
    /// read completed — which is the whole of what it has to go on.
    ///
    /// Two local endpoints with no relay and no discovery, so this needs nothing off the
    /// machine. It is here because the accept path is the one part of this crate a pure
    /// test cannot reach, and whether a refusal reaches the sender is a wire behavior:
    /// dropping a `SendStream` finishes it, so an implementation that meant to withhold
    /// the ack by omission would pass every test above this one.
    fn knock_acknowledged(prefill: usize) -> bool {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let inbox = new_inbox();
            for _ in 0..prefill {
                inbox
                    .parked
                    .lock()
                    .unwrap()
                    .push(Knock { record: record() });
            }

            let server = iroh::Endpoint::bind(iroh::endpoint::presets::Minimal)
                .await
                .unwrap();
            let addr = server.addr();
            let router = iroh::protocol::Router::builder(server)
                .accept(ALPN, HeyHandler::new(inbox))
                .spawn();

            let client = iroh::Endpoint::bind(iroh::endpoint::presets::Minimal)
                .await
                .unwrap();
            let conn = client.connect(addr, ALPN).await.unwrap();
            let (mut send, mut recv) = conn.open_bi().await.unwrap();
            send.write_all(&hey_request(&record())).await.unwrap();
            send.finish().unwrap();
            let acknowledged = recv.read_to_end(MAX_FRAME).await.is_ok();

            conn.close(0u32.into(), b"bye");
            router.shutdown().await.ok();
            acknowledged
        })
    }

    #[test]
    fn a_parked_knock_is_acknowledged() {
        assert!(knock_acknowledged(0));
    }

    #[test]
    fn a_knock_refused_for_a_full_inbox_reaches_the_sender_as_a_failure() {
        // The one that matters: acknowledging this would have the sender record it as
        // delivered and never come back, and out-of-graph engagement has no second route.
        assert!(!knock_acknowledged(MAX_INBOX));
    }

    #[test]
    fn a_knock_parks_the_record_it_carried() {
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        assert!(handler.accept_knock(&hey_request(&record())));
        assert_eq!(queued(&inbox), 1);
        assert_eq!(inbox.parked.lock().unwrap()[0].record, record());
    }

    #[test]
    fn parking_a_knock_owes_the_drain_a_wake() {
        // What `wait` returns on, checked without a runtime: `try_recv` reads the same
        // queued message. Without it a knock waits out the reconcile cadence, which is the
        // last stretch of delay between a like and its author counting it.
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        assert!(inbox.told.try_recv().is_err(), "nothing owed yet");

        assert!(handler.accept_knock(&hey_request(&record())));
        assert!(inbox.told.try_recv().is_ok(), "a wake is owed");
        assert!(inbox.told.try_recv().is_err(), "and only one");
    }

    #[test]
    fn a_refused_knock_owes_nothing() {
        // Signalling before the park would wake the drain over an empty inbox for
        // anything a stranger sends, parseable or not — a way to make us work that costs
        // the sender a malformed frame.
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        assert!(!handler.accept_knock(b"not json"));
        assert!(!handler.accept_knock(&hey_request(&serde_json::json!(null))));
        assert!(inbox.told.try_recv().is_err());
    }

    #[test]
    fn a_second_knock_needs_no_second_wake() {
        // Capacity one on purpose: the drain takes everything at once, so a full channel
        // means a wake is already owed and the extra says nothing. What must not happen is
        // the send blocking or the knock being refused because of it.
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        assert!(handler.accept_knock(&hey_request(&record())));
        assert!(handler.accept_knock(&hey_request(&record())));
        assert_eq!(queued(&inbox), 2);
    }

    #[test]
    fn a_record_survives_the_wire_verbatim() {
        // The signature is checked against fields read off this record, so anything the
        // frame did to it on the way through would be a knock that can never verify.
        let inbox = new_inbox();
        let handler = HeyHandler::new(inbox.clone());
        handler.accept_knock(&hey_request(&record()));
        let parked = inbox.parked.lock().unwrap()[0].record.clone();
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
        assert_eq!(inbox.parked.lock().unwrap()[0].record["sig"], "first");
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
