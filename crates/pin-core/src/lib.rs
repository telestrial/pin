// pin-core — the shared iroh-docs engine, the atproto repo's replacement.
//
// The record CRUD surface (open / put_record / get_record / delete_record /
// list_records, keyed by `collection/rkey`) is the one interface the app talks to
// in both environments: over wasm-bindgen in the browser (this file's exports) and
// over Tauri IPC to the native keeper (B2). Record values are opaque bytes — the
// same encrypted blob the app writes to atproto today — so migrating a collection
// is "write the same ciphertext into a doc entry instead of a PDS record."
//
// B1 scope: in-memory store (`MemStore`) everywhere, wasm-focused. Browser state is
// ephemeral for now (persistence across reload is a later slice). The native
// FsStore path returns in B2 when src-tauri adopts this crate for the keeper.
#![allow(dead_code)]

use std::cell::RefCell;
use std::rc::Rc;

use futures_lite::StreamExt as _;
use hkdf::Hkdf;
use iroh::{endpoint::presets, protocol::Router, Endpoint};
use iroh_blobs::{store::mem::MemStore, BlobsProtocol, ALPN as BLOBS_ALPN};
use iroh_docs::{
    api::Doc, protocol::Docs, store::Query, Author, AuthorId, Capability, NamespaceSecret,
    ALPN as DOCS_ALPN,
};
use iroh_gossip::{net::Gossip, ALPN as GOSSIP_ALPN};
use sha2::Sha256;
use wasm_bindgen::prelude::*;

// HKDF `info`s — same domain-separated derivation the native keeper uses, so a
// browser and a desktop signed in with the same Sia recovery phrase land on the
// same namespace + author (the one-root-secret move).
const NS_INFO: &[u8] = b"pin:iroh-docs-namespace:v1";
const AUTHOR_INFO: &[u8] = b"pin:iroh-docs-author:v1";

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

fn hkdf32(ikm: &[u8], info: &[u8]) -> Result<[u8; 32], JsValue> {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut okm = [0u8; 32];
    hk.expand(info, &mut okm).map_err(je)?;
    Ok(okm)
}

fn decode_app_key(hex: &str) -> Result<[u8; 32], JsValue> {
    if hex.len() != 64 {
        return Err(JsValue::from_str(
            "app key hex must be 32 bytes (64 hex chars)",
        ));
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(je)?;
    }
    Ok(out)
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
    let app_key = decode_app_key(&app_key_hex)?;
    let ns_seed = hkdf32(&app_key, NS_INFO)?;
    let author_seed = hkdf32(&app_key, AUTHOR_INFO)?;

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
