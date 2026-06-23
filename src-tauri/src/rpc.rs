// The Curator's serve-side RPC over iroh.
//
// Slice 4: peers dial the Curator's endpoint (ALPN "pin-keeper/0") and make
// request/response calls over a QUIC bidi stream — the serve half of the keeper
// protocol. The verb set is head / record / diff / hey.
//
// Slice 5 adds `record`: a lookup of one record by (collection, rkey) against the
// live repo, returning its CID and value. It's the first verb that touches repo
// content rather than just the signed head, so the handler now holds the shared
// repo (an async mutex — `get_raw` takes `&mut`) and `respond` is async. `diff`
// and `hey` remain stubbed.
//
// The one-shot self-test on start now exercises both `head` (the signed root) and
// `record` (the marker round-trips), over a throwaway client endpoint dialing the
// node — the on-machine proof that serve + dial + a content read all work.
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

use crate::repo::SharedRepo;

pub const ALPN: &[u8] = b"pin-keeper/0";
const MAX_FRAME: usize = 64 * 1024;

/// The repo's current signed head, served by the `head` verb. An immutable
/// snapshot taken at start (the repo is static after init this cut).
#[derive(Debug, Clone)]
pub struct Head {
    pub did: String,
    pub root: String,
    pub sig: Vec<u8>,
}

#[derive(Deserialize)]
struct Request {
    verb: String,
    /// `record`: the collection NSID (e.g. "dev.sia.pin.marker").
    #[serde(default)]
    collection: Option<String>,
    /// `record`: the record key (e.g. "self").
    #[serde(default)]
    rkey: Option<String>,
}

#[derive(Serialize)]
struct HeadResponse<'a> {
    did: &'a str,
    root: &'a str,
    /// Hex-encoded commit signature.
    sig: String,
}

#[derive(Serialize)]
struct RecordResponse {
    found: bool,
    /// The record's CID (its content hash), present iff found.
    cid: Option<String>,
    /// The record's value. DAG-CBOR decoded into the JSON data model — faithful
    /// for the JSON-shaped records Pin writes; a verifiable-bytes form is a later
    /// refinement for real peer sync.
    value: Option<serde_json::Value>,
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
    repo: SharedRepo,
}

impl RpcHandler {
    pub fn new(head: Head, repo: SharedRepo) -> Self {
        Self {
            head: Arc::new(head),
            repo,
        }
    }

    async fn respond(&self, request: &[u8]) -> Vec<u8> {
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
            "record" => self.respond_record(req.collection, req.rkey).await,
            "diff" | "hey" => error_frame(&format!("unimplemented: {}", req.verb)),
            other => error_frame(&format!("unknown verb: {other}")),
        }
    }

    async fn respond_record(
        &self,
        collection: Option<String>,
        rkey: Option<String>,
    ) -> Vec<u8> {
        let (Some(collection), Some(rkey)) = (collection, rkey) else {
            return error_frame("record requires collection and rkey");
        };
        let path = format!("{collection}/{rkey}");

        let mut repo = self.repo.lock().await;
        // The record's CID, via an MST lookup. The transient tree borrow ends
        // with this statement, freeing the repo for the get_raw below.
        let cid = match repo.tree().get(&path).await {
            Ok(c) => c,
            Err(e) => return error_frame(&format!("record lookup: {e}")),
        };
        let value: Option<serde_json::Value> = match repo.get_raw(&path).await {
            Ok(v) => v,
            Err(e) => return error_frame(&format!("record read: {e}")),
        };

        serde_json::to_vec(&RecordResponse {
            found: value.is_some(),
            cid: cid.map(|c| c.to_string()),
            value,
        })
        .unwrap_or_else(|e| error_frame(&format!("encode: {e}")))
    }
}

impl ProtocolHandler for RpcHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        // Service requests until the peer closes the connection — one
        // request/response per bidi stream, but many streams per connection
        // (the self-test alone makes two: head then record).
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
            let response = self.respond(&request).await;
            send.write_all(&response)
                .await
                .map_err(AcceptError::from_err)?;
            send.finish().map_err(AcceptError::from_err)?;
        }
    }
}

/// One-shot self-test: bind a throwaway client endpoint, dial the Curator's
/// endpoint over the RPC ALPN, and confirm both `head` (root matches) and
/// `record` (the marker is found) round-trip. Proves serve + dial + a content
/// read end-to-end on one machine.
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

    // head: the returned root must match what the repo reports.
    let head = call(&conn, br#"{"verb":"head"}"#).await?;
    let got_root = head.get("root").and_then(|r| r.as_str()).unwrap_or("");
    if got_root != expected_root {
        conn.close(0u32.into(), b"bye");
        return Err(match head.get("error").and_then(|e| e.as_str()) {
            Some(err) => format!("head server error: {err}"),
            None => format!("head mismatch: got {got_root}"),
        });
    }

    // record: the marker written at init must be found.
    let record = call(&conn, br#"{"verb":"record","collection":"dev.sia.pin.marker","rkey":"self"}"#)
        .await?;
    conn.close(0u32.into(), b"bye");
    if record.get("found").and_then(|f| f.as_bool()) != Some(true) {
        return Err(match record.get("error").and_then(|e| e.as_str()) {
            Some(err) => format!("record server error: {err}"),
            None => "record not found".to_string(),
        });
    }

    Ok("ok (head + record round-trip)".to_string())
}

/// Issue one request on a fresh bidi stream and parse the JSON response.
async fn call(conn: &Connection, request: &[u8]) -> Result<serde_json::Value, String> {
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("open_bi: {e}"))?;
    send.write_all(request)
        .await
        .map_err(|e| format!("write: {e}"))?;
    send.finish().map_err(|e| format!("finish: {e}"))?;
    let response = recv
        .read_to_end(MAX_FRAME)
        .await
        .map_err(|e| format!("read: {e}"))?;
    serde_json::from_slice(&response).map_err(|e| format!("parse: {e}"))
}
