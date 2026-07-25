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
use pin_derive::{decode_app_key, hkdf32, AUTHOR_INFO, NS_INFO};
use wasm_bindgen::prelude::*;

// The live engine. Single-threaded on wasm, so a thread_local is the app singleton.
// Held as Rc so calls clone it out (cheap) and never hold the RefCell borrow across
// an await.
struct Engine {
    doc: Doc,
    blobs: MemStore,
    author_id: AuthorId,
    _endpoint: Endpoint,
    _gossip: Gossip,
    _docs: Docs,
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

fn record_key(collection: &str, rkey: &str) -> Vec<u8> {
    format!("{collection}/{rkey}").into_bytes()
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
    let router = Router::builder(endpoint.clone())
        .accept(BLOBS_ALPN, BlobsProtocol::new(&blobs, None))
        .accept(GOSSIP_ALPN, gossip.clone())
        .accept(DOCS_ALPN, docs.clone())
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
        blobs,
        author_id,
        _endpoint: endpoint,
        _gossip: gossip,
        _docs: docs,
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

/// List the rkeys under a collection (entries whose key starts with `collection/`).
/// Returns a JS array of strings.
#[wasm_bindgen]
pub async fn list_records(collection: String) -> Result<JsValue, JsValue> {
    let eng = engine()?;
    let prefix = format!("{collection}/");
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
