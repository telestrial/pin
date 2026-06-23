// The Curator's serve-side RPC over iroh.
//
// Slice 4: peers dial the Curator's endpoint (ALPN "pin-keeper/0") and make
// request/response calls over a QUIC bidi stream — the serve half of the keeper
// protocol. The verb set is head / record / diff / hey.
//
// Slice 5 added `record`: a lookup of one record by (collection, rkey) against
// the live repo, returning its CID and value — the first verb that touches repo
// content, so the handler holds the shared repo (an async mutex — `get_raw` takes
// `&mut`) and `respond` is async.
//
// The `hey` slice added the inbox knock — the one PUSH verb in an otherwise
// pull-shaped protocol (atproto has no "notify me" channel): a peer hands us
// `{ from, sig, referent }` and we enqueue it (no sig-verify / referent-fetch
// yet — that's the reconcile loop).
//
// This slice adds `diff`, completing the verb set. `diff(since?)` is incremental
// repo sync: it returns a CAR of just the blocks the caller needs to advance
// from a commit they hold (`since`) to the current root — or the whole repo when
// `since` is absent/unknown. The honest delta needs to walk an arbitrary old
// root AND read raw blocks, neither of which the encapsulated live repo exposes,
// so `diff` opens a FRESH read-only `CarStore` on `repo.car` (shared-read
// alongside the live handle): export the CID set from the current root, export
// it from `since`, subtract, and ship the difference as a CAR. `since ==`
// current short-circuits to an empty CAR (up to date).
//
// The one-shot self-test on start exercises all four verbs over a throwaway
// client endpoint dialing the node: `head` (signed root), `record` (the marker
// round-trips), `hey` (a knock is accepted), and `diff` (the returned CAR
// reopens into a repo whose marker reads back) — the on-machine proof that
// serve + dial + content read + inbound knock + repo sync all work.
//
// Wire format per call: the dialer opens a bidi stream, writes a JSON request,
// finishes its send side; the server reads to end, writes a JSON response,
// finishes. One request/response per stream.

use std::collections::HashSet;
use std::io::Cursor;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atrium_repo::blockstore::{AsyncBlockStoreRead, AsyncBlockStoreWrite, CarStore, SHA2_256};
use atrium_repo::{Cid, Repository};
use iroh::endpoint::{presets, Connection};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use tokio::fs::OpenOptions;

use crate::repo::SharedRepo;

pub const ALPN: &[u8] = b"pin-keeper/0";
// Per-frame ceiling for both request and response reads. Generous because the
// `diff` response carries a CAR; a small keeper repo is well under this. Very
// large repos would need streaming instead of a single framed response — a
// later refinement. Note: this is a read cap, not a pre-allocation.
const MAX_FRAME: usize = 16 * 1024 * 1024;

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
    /// `hey`: the knocking party (DID or node id).
    #[serde(default)]
    from: Option<String>,
    /// `hey`: hex signature over the knock (not verified yet — that's reconcile).
    #[serde(default)]
    sig: Option<String>,
    /// `hey`: the AT-URI the knock is about ("I did something about this").
    #[serde(default)]
    referent: Option<String>,
    /// `diff`: the commit CID the caller already holds (absent = full repo).
    #[serde(default)]
    since: Option<String>,
}

/// An inbound knock parked in the inbox until the reconcile loop drains it
/// (fetch the referent, verify the sig, materialize an index record). None of
/// that happens this slice — we just hold the pointer, so the fields are stored
/// but not yet read (the reconcile slice is what reads them).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Knock {
    pub from: String,
    pub sig: String,
    pub referent: String,
}

/// The `hey` inbox: knocks accepted but not yet reconciled. In-memory for now;
/// persisting + draining it is the reconcile slice. A std mutex (not tokio) —
/// it's only ever held for a push/read with no await in between.
pub type HeyInbox = Arc<Mutex<Vec<Knock>>>;

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
struct HeyResponse {
    accepted: bool,
    /// Inbox depth after enqueuing — lets the knocker (and our diagnostics) see
    /// the knock landed.
    queued: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffResponse {
    /// The current root commit CID the returned CAR advances to.
    root: String,
    /// True when `since` already equals the current root (empty CAR).
    up_to_date: bool,
    /// Hex-encoded CAR (roots = [root]) of the delta blocks. Empty when up to date.
    car: String,
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

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[derive(Debug, Clone)]
pub struct RpcHandler {
    head: Arc<Head>,
    repo: SharedRepo,
    inbox: HeyInbox,
    car_path: PathBuf,
}

impl RpcHandler {
    pub fn new(head: Head, repo: SharedRepo, inbox: HeyInbox, car_path: PathBuf) -> Self {
        Self {
            head: Arc::new(head),
            repo,
            inbox,
            car_path,
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
            "hey" => self.respond_hey(req.from, req.sig, req.referent),
            "diff" => self.respond_diff(req.since).await,
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

    fn respond_hey(
        &self,
        from: Option<String>,
        sig: Option<String>,
        referent: Option<String>,
    ) -> Vec<u8> {
        let (Some(from), Some(sig), Some(referent)) = (from, sig, referent) else {
            return error_frame("hey requires from, sig, and referent");
        };
        // Park the knock. We don't verify the sig or fetch the referent here —
        // that's the reconcile loop. Acceptance just means "received and queued."
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

    async fn respond_diff(&self, since: Option<String>) -> Vec<u8> {
        match self.diff_inner(since).await {
            Ok(frame) => frame,
            Err(e) => error_frame(&format!("diff: {e}")),
        }
    }

    async fn diff_inner(&self, since: Option<String>) -> Result<Vec<u8>, String> {
        // Current root from the live repo — authoritative even once writers exist.
        let current_root = { self.repo.lock().await.root() };

        let since_cid = since.as_deref().and_then(|s| Cid::from_str(s).ok());
        // Up-to-date short-circuit: the caller already holds the current root.
        if since_cid == Some(current_root) {
            return Ok(diff_frame(current_root, true, &[]));
        }

        // Fresh read-only view of the CAR: lets us walk an arbitrary old root AND
        // read raw blocks (the live repo exposes neither). Shared-read alongside
        // the live read+write handle. Re-indexes + hash-validates the whole CAR
        // each call — fine at keeper scale; an index cache is a later refinement.
        let file = OpenOptions::new()
            .read(true)
            .open(&self.car_path)
            .await
            .map_err(|e| format!("open car: {e}"))?;
        let mut store = CarStore::open(file)
            .await
            .map_err(|e| format!("open car store: {e}"))?;

        // CID set reachable from the current root. Collect into an owned local so
        // the export iterator (which borrows `repo`) is consumed before `repo`
        // drops at the block's end.
        let current_cids: HashSet<Cid> = {
            let mut repo = Repository::open(&mut store, current_root)
                .await
                .map_err(|e| format!("open current: {e}"))?;
            let cids = repo
                .export()
                .await
                .map_err(|e| format!("export current: {e}"))?
                .collect::<HashSet<Cid>>();
            cids
        };

        // CID set the caller already holds. If we don't have their commit, the
        // set is empty and they get the full repo (a correct superset).
        let old_cids: HashSet<Cid> = match since_cid {
            Some(s) => match Repository::open(&mut store, s).await {
                Ok(mut old) => {
                    let cids = old
                        .export()
                        .await
                        .map_err(|e| format!("export since: {e}"))?
                        .collect::<HashSet<Cid>>();
                    cids
                }
                Err(_) => HashSet::new(),
            },
            None => HashSet::new(),
        };

        // Ship a CAR (roots=[current_root]) of just the blocks they're missing.
        let delta: Vec<Cid> = current_cids.difference(&old_cids).copied().collect();
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut out = CarStore::create_with_roots(Cursor::new(&mut buf), [current_root])
                .await
                .map_err(|e| format!("create car: {e}"))?;
            for cid in &delta {
                let bytes = store
                    .read_block(*cid)
                    .await
                    .map_err(|e| format!("read block: {e}"))?;
                out.write_block(cid.codec(), SHA2_256, &bytes)
                    .await
                    .map_err(|e| format!("write block: {e}"))?;
            }
        }
        Ok(diff_frame(current_root, delta.is_empty(), &buf))
    }
}

fn diff_frame(root: Cid, up_to_date: bool, car: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&DiffResponse {
        root: root.to_string(),
        up_to_date,
        car: hex_encode(car),
    })
    .unwrap_or_else(|e| error_frame(&format!("encode: {e}")))
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
/// endpoint over the RPC ALPN, and confirm `head` (root matches), `record` (the
/// marker is found), and `hey` (a knock is accepted) round-trip. Proves serve +
/// dial + a content read + an inbound knock end-to-end on one machine. The knock
/// it sends is synthetic; the caller clears the inbox afterward.
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
    if record.get("found").and_then(|f| f.as_bool()) != Some(true) {
        conn.close(0u32.into(), b"bye");
        return Err(match record.get("error").and_then(|e| e.as_str()) {
            Some(err) => format!("record server error: {err}"),
            None => "record not found".to_string(),
        });
    }

    // hey: a knock must be accepted (synthetic; the caller clears the inbox).
    let hey = call(
        &conn,
        br#"{"verb":"hey","from":"did:self-test","sig":"00","referent":"at://self-test"}"#,
    )
    .await?;
    if hey.get("accepted").and_then(|a| a.as_bool()) != Some(true) {
        conn.close(0u32.into(), b"bye");
        return Err(match hey.get("error").and_then(|e| e.as_str()) {
            Some(err) => format!("hey server error: {err}"),
            None => "hey not accepted".to_string(),
        });
    }

    // diff (no `since` = full repo): the returned CAR must reopen into a repo
    // whose marker reads back — proving diff emits a complete, syncable repo.
    let diff = call(&conn, br#"{"verb":"diff"}"#).await?;
    conn.close(0u32.into(), b"bye");
    verify_diff(&diff, expected_root).await?;

    Ok("ok (head + record + hey + diff round-trip)".to_string())
}

/// Verify a `diff` response: the hex CAR reopens at the advertised root and the
/// marker record reads back out of it.
async fn verify_diff(diff: &serde_json::Value, expected_root: &str) -> Result<(), String> {
    if let Some(err) = diff.get("error").and_then(|e| e.as_str()) {
        return Err(format!("diff server error: {err}"));
    }
    let root_str = diff.get("root").and_then(|r| r.as_str()).unwrap_or("");
    if root_str != expected_root {
        return Err(format!("diff root mismatch: got {root_str}"));
    }
    let car_hex = diff.get("car").and_then(|c| c.as_str()).unwrap_or("");
    let car_bytes = hex_decode(car_hex).ok_or("diff: bad car hex")?;
    let root_cid = Cid::from_str(root_str).map_err(|e| format!("diff root cid: {e}"))?;

    let mut store = CarStore::open(Cursor::new(car_bytes))
        .await
        .map_err(|e| format!("diff car open: {e}"))?;
    let mut repo = Repository::open(&mut store, root_cid)
        .await
        .map_err(|e| format!("diff repo open: {e}"))?;
    let marker: Option<serde_json::Value> = repo
        .get_raw("dev.sia.pin.marker/self")
        .await
        .map_err(|e| format!("diff marker read: {e}"))?;
    if marker.is_none() {
        return Err("diff CAR missing marker".to_string());
    }
    Ok(())
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
