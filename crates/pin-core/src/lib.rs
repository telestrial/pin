// pin-core — the shared iroh-docs engine, the atproto repo's replacement.
//
// The record CRUD surface (open / put_record / get_record / delete_record /
// list_records, keyed by `collection/rkey`) is the one interface the app talks to
// in both environments: over wasm-bindgen in the browser (this file's exports) and
// over Tauri IPC to the native Curator (B2). Record values are opaque bytes — the
// same encrypted blob the app writes to atproto today — so migrating a collection
// is "write the same ciphertext into a doc entry instead of a PDS record."
//
// B1 scope: in-memory store (`MemStore`) everywhere, wasm-focused. Browser state is
// ephemeral for now (persistence across reload is a later slice). The native
// FsStore path returns in B2 when src-tauri adopts this crate for the Curator.
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::str::FromStr;

use futures_lite::StreamExt as _;
use iroh::{endpoint::presets, protocol::Router, Endpoint};
use iroh_blobs::{store::mem::MemStore, BlobsProtocol, ALPN as BLOBS_ALPN};
use iroh_docs::{
    api::{
        protocol::{AddrInfoOptions, ShareMode},
        Doc,
    },
    engine::LiveEvent,
    protocol::Docs,
    store::Query,
    Author, AuthorId, Capability, DocTicket, NamespaceSecret, ALPN as DOCS_ALPN,
};
use iroh_gossip::{net::Gossip, ALPN as GOSSIP_ALPN};
// Shared with the native Curator: same domain-separated derivation so a browser and a
// desktop signed in with the same Sia recovery phrase land on the same namespace +
// author (the one-root-secret move).
use pin_derive::{
    collection_prefix, decode_app_key, decode_hex32, hkdf32, record_key, AUTHOR_INFO, NS_INFO,
};
// The /hey inbox knock, the same crate the native Curator serves — one protocol, so
// a peer knocking gets the same answer from a tab as from a desktop.
use pin_rpc::{HeyHandler, HeyInbox, ALPN as HEY_ALPN};
use wasm_bindgen::prelude::*;

// The live engine. Single-threaded on wasm, so a thread_local is the app singleton.
// Held as Rc so calls clone it out (cheap) and never hold the RefCell borrow across
// an await.
struct Engine {
    doc: Doc,
    /// Channel docs, keyed by namespace id — one replica per channel this instance
    /// serves (as author) or follows (as subscriber). Separate docs rather than
    /// entries in `doc` because iroh-docs' read capability is whole-namespace: a
    /// subscriber given access to the identity doc would see every other channel's
    /// keys (leaking obscure channels' existence) and the settings ciphertext.
    /// One doc per channel is the only grain that matches Pin's per-channel `K`.
    channels: RefCell<HashMap<String, Doc>>,
    blobs: MemStore,
    author_id: AuthorId,
    endpoint: Endpoint,
    /// Inbound /hey knocks, parked until a reconcile loop drains them. Held so
    /// `status()` can report the depth — the same field the native Curator reports.
    hey_inbox: HeyInbox,
    _gossip: Gossip,
    docs: Docs,
    _router: Router,
}

thread_local! {
    static ENGINE: RefCell<Option<Rc<Engine>>> = const { RefCell::new(None) };
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn je<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn engine() -> Result<Rc<Engine>, JsValue> {
    ENGINE
        .with(|e| e.borrow().clone())
        .ok_or_else(|| JsValue::from_str("pin-core not initialized (call open first)"))
}

/// Open (create) the in-memory doc engine, with the namespace + author derived from
/// the Sia AppKey. Returns the namespace id. A second call rebuilds from scratch.
#[wasm_bindgen]
pub async fn open(app_key_hex: String) -> Result<String, JsValue> {
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let ns_seed = hkdf32(&app_key, NS_INFO);
    let author_seed = hkdf32(&app_key, AUTHOR_INFO);

    let endpoint = Endpoint::bind(presets::N0).await.map_err(je)?;
    let blobs = MemStore::default();
    let gossip = Gossip::builder().spawn(endpoint.clone());
    let docs = Docs::memory()
        .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
        .await
        .map_err(je)?;
    // Serve the /hey inbox alongside docs/blobs/gossip on one ALPN-multiplexed
    // Router — the same set the native Curator serves. A browser tab has no
    // listening socket, so inbound arrives over its relay rather than a direct
    // path, but it answers the identical protocol.
    let hey_inbox = pin_rpc::new_inbox();
    let router = Router::builder(endpoint.clone())
        .accept(BLOBS_ALPN, BlobsProtocol::new(&blobs, None))
        .accept(GOSSIP_ALPN, gossip.clone())
        .accept(DOCS_ALPN, docs.clone())
        .accept(HEY_ALPN, HeyHandler::new(hey_inbox.clone()))
        .spawn();

    let author = Author::from_bytes(&author_seed);
    let author_id = author.id();
    docs.api().author_import(author).await.map_err(je)?;
    let ns = NamespaceSecret::from_bytes(&ns_seed);
    let namespace_id = ns.id().to_string();
    let doc = docs
        .api()
        .import_namespace(Capability::Write(ns))
        .await
        .map_err(je)?;

    let eng = Rc::new(Engine {
        doc,
        channels: RefCell::new(HashMap::new()),
        blobs,
        author_id,
        endpoint,
        hey_inbox,
        _gossip: gossip,
        docs,
        _router: router,
    });
    ENGINE.with(|e| *e.borrow_mut() = Some(eng));
    Ok(namespace_id)
}

/// Write a record. `value` is opaque bytes (the app's encrypted blob).
#[wasm_bindgen]
pub async fn put_record(collection: String, rkey: String, value: Vec<u8>) -> Result<(), JsValue> {
    let eng = engine()?;
    eng.doc
        .set_bytes(eng.author_id, record_key(&collection, &rkey), value)
        .await
        .map_err(je)?;
    Ok(())
}

/// Read a record's bytes, or `undefined` if absent.
#[wasm_bindgen]
pub async fn get_record(collection: String, rkey: String) -> Result<Option<Vec<u8>>, JsValue> {
    let eng = engine()?;
    let entry = eng
        .doc
        .get_exact(eng.author_id, record_key(&collection, &rkey), false)
        .await
        .map_err(je)?;
    match entry {
        None => Ok(None),
        Some(e) => {
            let bytes = eng.blobs.get_bytes(e.content_hash()).await.map_err(je)?;
            Ok(Some(bytes.to_vec()))
        }
    }
}

/// Delete a record (tombstone).
#[wasm_bindgen]
pub async fn delete_record(collection: String, rkey: String) -> Result<(), JsValue> {
    let eng = engine()?;
    eng.doc
        .del(eng.author_id, record_key(&collection, &rkey))
        .await
        .map_err(je)?;
    Ok(())
}

/// This instance's iroh network status, classified EXACTLY as the native Curator
/// does (see src-tauri/src/curator.rs) so the Curate page can render one interface
/// over both — a browser tab is a full peer, not a lesser tier, and its status
/// should read the same way.
///
/// The honest browser differences show up as values, not missing fields:
/// `directAddrs` is normally empty because a tab has no listening socket, so every
/// path runs through a relay. `online` (a relay is connected) is therefore what
/// makes this tab dialable — by a peer that already holds its ADDRESS, since
/// discovery-by-bare-id doesn't resolve in wasm (see the note on `start_sync`).
/// `rpcServing` / `heyQueued` are real here too: the Router accepts the same
/// pin-keeper/0 ALPN the native Curator does.
#[wasm_bindgen]
pub fn status() -> Result<JsValue, JsValue> {
    let eng = engine()?;
    let addr = eng.endpoint.addr();
    let relays = js_sys::Array::new();
    let direct = js_sys::Array::new();
    let other = js_sys::Array::new();
    for a in &addr.addrs {
        let s = JsValue::from_str(&format!("{a:?}"));
        if a.is_relay() {
            relays.push(&s);
        } else if a.is_ip() {
            direct.push(&s);
        } else {
            other.push(&s);
        }
    }
    let obj = js_sys::Object::new();
    let set = |k: &str, v: &JsValue| {
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(k), v);
    };
    set("nodeId", &JsValue::from_str(&eng.endpoint.id().to_string()));
    set("online", &JsValue::from_bool(relays.length() > 0));
    set("relays", &relays);
    set("directAddrs", &direct);
    set("otherAddrs", &other);
    // The Router is spawned in `open`, so an engine that exists is serving.
    set("rpcServing", &JsValue::from_bool(true));
    set(
        "heyQueued",
        &JsValue::from_f64(pin_rpc::queued(&eng.hey_inbox) as f64),
    );
    Ok(obj.into())
}

/// List the rkeys under a collection (entries whose key starts with `collection/`).
/// Returns a JS array of strings.
#[wasm_bindgen]
pub async fn list_records(collection: String) -> Result<JsValue, JsValue> {
    let eng = engine()?;
    let prefix = collection_prefix(&collection);
    let mut stream = Box::pin(eng.doc.get_many(Query::all().build()).await.map_err(je)?);
    let arr = js_sys::Array::new();
    while let Some(res) = stream.next().await {
        let entry = res.map_err(je)?;
        let key = String::from_utf8_lossy(entry.key());
        if let Some(rkey) = key.strip_prefix(&prefix) {
            arr.push(&JsValue::from_str(rkey));
        }
    }
    Ok(arr.into())
}

/// List every record's full key (`collection/rkey`) across all collections.
/// Returns a JS array of strings. Used to snapshot the whole doc (docsMirror).
#[wasm_bindgen]
pub async fn list_all() -> Result<JsValue, JsValue> {
    let eng = engine()?;
    let mut stream = Box::pin(eng.doc.get_many(Query::all().build()).await.map_err(je)?);
    let arr = js_sys::Array::new();
    while let Some(res) = stream.next().await {
        let entry = res.map_err(je)?;
        arr.push(&JsValue::from_str(&String::from_utf8_lossy(entry.key())));
    }
    Ok(arr.into())
}

// ── Live sync ──────────────────────────────────────────────────────────────
// The browser opens its own replica of the AppKey-derived namespace (via `open`);
// the Curator opens the SAME namespace (same recovery phrase -> same AppKey -> same
// HKDF). `start_sync` joins the Curator as a sync peer so the two replicas reconcile
// live over iroh — the front end of the Curator. `share` is the symmetric verb (a
// tab can serve for dev). Same-identity: both hold the write capability already, so
// the ticket only carries where to reach the peer.

/// Produce a shareable DocTicket for this identity's doc (write capability + this
/// node's relay address). A peer imports it to sync. Lets a second browser tab act
/// as a sync counterpart during dev.
#[wasm_bindgen]
pub async fn share() -> Result<String, JsValue> {
    let eng = engine()?;
    let ticket = eng
        .doc
        .share(ShareMode::Write, AddrInfoOptions::RelayAndAddresses)
        .await
        .map_err(je)?;
    Ok(ticket.to_string())
}

/// Join the peer(s) in `ticket` and live-sync this identity's doc with them.
/// `on_event` is invoked with a short label string per `LiveEvent` (insert-local /
/// insert-remote / sync-finished / neighbor-up|down) so the UI can show the loop is
/// alive. Subscribes BEFORE starting sync (mirroring iroh-docs' import_and_subscribe)
/// so no events are missed; the event pump runs on the local executor for the life
/// of the engine.
///
/// NOTE (2026-07-25): the peer coordinates MUST include an address — the ticket
/// carries node id + relay URL + direct addrs. Dialing by a bare node id (letting
/// iroh discovery resolve it) does NOT work in the relay-only wasm/browser build
/// (no DNS resolver in the sandbox), so a rendezvous must publish the ticket/addr,
/// not just the id.
#[wasm_bindgen]
pub async fn start_sync(ticket: String, on_event: js_sys::Function) -> Result<(), JsValue> {
    let eng = engine()?;
    let ticket = DocTicket::from_str(&ticket).map_err(je)?;
    let mut events = eng.doc.subscribe().await.map_err(je)?;
    eng.doc.start_sync(ticket.nodes).await.map_err(je)?;
    wasm_bindgen_futures::spawn_local(async move {
        while let Some(res) = events.next().await {
            let label = match res {
                Ok(ev) => live_event_label(&ev),
                Err(e) => format!("error: {e}"),
            };
            // Ignore a JS callback throw; keep pumping.
            let _ = on_event.call1(&JsValue::NULL, &JsValue::from_str(&label));
        }
    });
    Ok(())
}

// ── Channel docs ───────────────────────────────────────────────────────────
// The top rung of the content-resolution ladder: instead of polling a channel's
// pkarr locator and re-fetching its manifest from Sia, a subscriber holds a live
// replica of the channel's own doc and is PUSHED updates as the author writes.
//
// Capability shape (settled 2026-07-28, probe-verified): the author holds the WRITE
// capability, derived from a seed only they can compute (AppKey + channelID). They
// hand subscribers a `ShareMode::Read` DocTicket, published to a `K`-derived pkarr
// record. Deriving the namespace from `K` instead would have been simpler, but a
// namespace secret IS the write capability — every subscriber could then write to
// (and spam) the author's channel doc. A read ticket also carries the author's node
// id + relay address, so it answers "where do I dial" in the same field.
//
// Two consequences worth holding:
//   - Reads here are author-AGNOSTIC (see `get_channel_record`), which is only safe
//     BECAUSE the capability is read-only for everyone but the author.
//   - A ticket must be minted while the endpoint is ONLINE and refreshed as
//     addresses change: `share` snapshots whatever addresses are known right now,
//     and a ticket with no relay URL is undialable from a browser (which has no
//     discovery — see the NOTE on `start_sync`).

/// Look up an open channel replica. Clones the `Doc` out (cheap) so no `RefCell`
/// borrow is ever held across an await.
fn channel_doc(eng: &Engine, ns_id: &str) -> Result<Doc, JsValue> {
    eng.channels
        .borrow()
        .get(ns_id)
        .cloned()
        .ok_or_else(|| JsValue::from_str(&format!("channel doc {ns_id} is not open")))
}

/// Author side: open (or reopen) the write replica of a channel's doc from its
/// 32-byte namespace seed. Returns the namespace id. Idempotent — opening the same
/// channel twice reuses the replica rather than rebuilding it.
///
/// The seed is derived by the app (from the AppKey + channelID) and handed in as
/// hex, rather than derived here from an `info` in `pin-derive`: since one
/// implementation computes it for both engines, there are no two copies to drift.
#[wasm_bindgen]
pub async fn open_channel_doc(ns_seed_hex: String) -> Result<String, JsValue> {
    let eng = engine()?;
    let seed = decode_hex32(&ns_seed_hex).ok_or_else(|| {
        JsValue::from_str("channel namespace seed must be 32 bytes (64 hex chars)")
    })?;
    let ns = NamespaceSecret::from_bytes(&seed);
    let ns_id = ns.id().to_string();
    if eng.channels.borrow().contains_key(&ns_id) {
        return Ok(ns_id);
    }
    let doc = eng
        .docs
        .api()
        .import_namespace(Capability::Write(ns))
        .await
        .map_err(je)?;
    eng.channels.borrow_mut().insert(ns_id.clone(), doc);
    Ok(ns_id)
}

/// Author side: mint a READ-mode ticket for a channel doc — the capability a
/// subscriber imports. Read-mode, so holding it can never write to the doc.
/// Call this while online; the ticket freezes the addresses known at this moment.
#[wasm_bindgen]
pub async fn share_channel_doc(ns_id: String) -> Result<String, JsValue> {
    let eng = engine()?;
    let doc = channel_doc(&eng, &ns_id)?;
    let ticket = doc
        .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
        .await
        .map_err(je)?;
    Ok(ticket.to_string())
}

/// Subscriber side: import a channel's read ticket and live-sync it. Returns the
/// namespace id. `on_event(nsID, label)` fires per `LiveEvent`, so the app can react
/// to an `insert-remote` by re-reading the record and filling the feed in.
///
/// Uses `import_and_subscribe`, which subscribes BEFORE starting sync — so the first
/// reconciliation's events can't be missed (the initial catch-up is exactly the one
/// we most want to see).
#[wasm_bindgen]
pub async fn import_channel_doc(
    ticket: String,
    on_event: js_sys::Function,
) -> Result<String, JsValue> {
    let eng = engine()?;
    let ticket = DocTicket::from_str(&ticket).map_err(je)?;
    let (doc, events) = eng
        .docs
        .api()
        .import_and_subscribe(ticket)
        .await
        .map_err(je)?;
    let ns_id = doc.id().to_string();
    eng.channels.borrow_mut().insert(ns_id.clone(), doc);

    let ns_for_events = ns_id.clone();
    wasm_bindgen_futures::spawn_local(async move {
        let mut events = Box::pin(events);
        while let Some(res) = events.next().await {
            let label = match res {
                Ok(ev) => live_event_label(&ev),
                Err(e) => format!("error: {e}"),
            };
            // Ignore a JS callback throw; keep pumping.
            let _ = on_event.call2(
                &JsValue::NULL,
                &JsValue::from_str(&ns_for_events),
                &JsValue::from_str(&label),
            );
        }
    });
    Ok(ns_id)
}

/// Write a record into a channel doc (author side only — a read replica rejects it
/// with "Attempted to insert to read only replica").
#[wasm_bindgen]
pub async fn put_channel_record(
    ns_id: String,
    collection: String,
    rkey: String,
    value: Vec<u8>,
) -> Result<(), JsValue> {
    let eng = engine()?;
    let doc = channel_doc(&eng, &ns_id)?;
    doc.set_bytes(eng.author_id, record_key(&collection, &rkey), value)
        .await
        .map_err(je)?;
    Ok(())
}

/// Read a record from a channel doc, or `undefined` if absent.
///
/// Author-AGNOSTIC (`single_latest_per_key`, no author filter) — deliberately. On the
/// subscriber side the entry was written by the channel owner, whose `AuthorId` we
/// don't hold and would otherwise have to publish. Safe because the capability is
/// read-only for everyone but the owner: any entry at this key IS theirs. This is the
/// simplification the read-ticket choice buys.
#[wasm_bindgen]
pub async fn get_channel_record(
    ns_id: String,
    collection: String,
    rkey: String,
) -> Result<Option<Vec<u8>>, JsValue> {
    let eng = engine()?;
    let doc = channel_doc(&eng, &ns_id)?;
    let entry = doc
        .get_one(
            Query::single_latest_per_key()
                .key_exact(record_key(&collection, &rkey))
                .build(),
        )
        .await
        .map_err(je)?;
    match entry {
        None => Ok(None),
        Some(e) => {
            let bytes = eng.blobs.get_bytes(e.content_hash()).await.map_err(je)?;
            Ok(Some(bytes.to_vec()))
        }
    }
}

/// Delete a record from a channel doc (author side).
#[wasm_bindgen]
pub async fn delete_channel_record(
    ns_id: String,
    collection: String,
    rkey: String,
) -> Result<(), JsValue> {
    let eng = engine()?;
    let doc = channel_doc(&eng, &ns_id)?;
    doc.del(eng.author_id, record_key(&collection, &rkey))
        .await
        .map_err(je)?;
    Ok(())
}

/// The namespace ids of every channel doc currently open. Lets the app avoid
/// re-importing one it already holds, and gives the Curate page something to show.
#[wasm_bindgen]
pub fn channel_doc_namespaces() -> Result<JsValue, JsValue> {
    let eng = engine()?;
    let arr = js_sys::Array::new();
    for ns in eng.channels.borrow().keys() {
        arr.push(&JsValue::from_str(ns));
    }
    Ok(arr.into())
}

fn live_event_label(ev: &LiveEvent) -> String {
    match ev {
        LiveEvent::InsertLocal { entry } => {
            format!("insert-local {}", String::from_utf8_lossy(entry.key()))
        }
        LiveEvent::InsertRemote { entry, .. } => {
            format!("insert-remote {}", String::from_utf8_lossy(entry.key()))
        }
        LiveEvent::ContentReady { .. } => "content-ready".to_string(),
        LiveEvent::PendingContentReady => "pending-content-ready".to_string(),
        LiveEvent::NeighborUp(_) => "neighbor-up".to_string(),
        LiveEvent::NeighborDown(_) => "neighbor-down".to_string(),
        LiveEvent::SyncFinished(_) => "sync-finished".to_string(),
    }
}
