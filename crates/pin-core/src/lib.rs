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

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::str::FromStr;
use std::sync::Arc;

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
    collection_prefix, decode_app_key, decode_hex32, hkdf32, parse_record_key, record_key,
    RecordKey, AUTHOR_INFO, EV_CONTENT_READY, EV_ERROR, EV_INSERT_LOCAL, EV_INSERT_REMOTE,
    EV_NEIGHBOR_DOWN, EV_NEIGHBOR_UP, EV_PENDING_CONTENT_READY, EV_SYNC_FINISHED, NS_INFO,
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
    /// Whether the doc-change pump is already running (see `subscribe_doc_changes`).
    /// One pump per engine: a second would double every change, and the callers most
    /// likely to subscribe twice are the ones that mount twice (StrictMode, hot reload).
    changes_subscribed: Cell<bool>,
    /// Whether the pull loop is already running (see `start_pull_loop`). One per
    /// engine — a second would double every pass's network work for nothing.
    pull_running: Cell<bool>,
    /// Same, for the locator keep-alive loop.
    keep_alive_running: Cell<bool>,
    repack_running: Cell<bool>,
    /// Same, for the instance-registration loop.
    instance_running: Cell<bool>,
    /// Same, for the identity-publishing loop.
    identity_running: Cell<bool>,
    /// Channel-doc serve loop guard (see `start_channel_doc_loop`).
    channel_doc_running: Cell<bool>,
    /// Channel live-sync loop guard (see `start_channel_sync_loop`).
    channel_sync_running: Cell<bool>,
    /// Doc-to-Sia snapshot loop guard (see `start_snapshot_loop`).
    snapshot_running: Cell<bool>,
    /// Instance rendezvous loop guard (see `start_rendezvous_loop`).
    rendezvous_running: Cell<bool>,
    /// Same, for the engagement crawl/fold loop.
    engagement_running: Cell<bool>,
    deliver_running: Cell<bool>,
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
        changes_subscribed: Cell::new(false),
        pull_running: Cell::new(false),
        keep_alive_running: Cell::new(false),
        repack_running: Cell::new(false),
        instance_running: Cell::new(false),
        identity_running: Cell::new(false),
        channel_doc_running: Cell::new(false),
        channel_sync_running: Cell::new(false),
        snapshot_running: Cell::new(false),
        rendezvous_running: Cell::new(false),
        engagement_running: Cell::new(false),
        deliver_running: Cell::new(false),
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

/// Report every change to this instance's own doc, as `(collection, rkey, kind)`.
///
/// This is the repo's CHANGE FEED — the "state out" half of repo-as-only-contract.
/// The frontend never has to ask whether a record moved: whatever wrote it (a peer's
/// device syncing in, or this instance's own Curator work) announces it, and one
/// listener routes by collection to decide what to re-read. It replaces per-feature
/// polling, which is what the app did before: each consumer that cared about a
/// background write ran its own timer, and every new Curator job would have added
/// another.
///
/// Faithful, not filtered — the engine reports what happened and the frontend decides
/// what it means:
///   - Record events (`insert-local` / `insert-remote`) carry `collection` + `rkey`,
///     split by `pin_derive::parse_record_key` so both engines decompose keys the
///     same way.
///   - Stream-level events (`content-ready`, `sync-finished`, neighbor up/down) aren't
///     about one record and carry EMPTY strings for both. `content-ready` in
///     particular still matters: iroh-blobs content LAGS the entry, so a reader that
///     acted only on `insert-remote` can find the value not yet readable. An empty
///     collection means "something landed — re-check what you care about."
///   - Local writes are reported too, so a consumer can see its own write land.
///     Filtering them out is the caller's job (`isRemoteChange` in docs.ts).
///
/// One pump per engine; a second call is a no-op. Only `open()` (which rebuilds the
/// engine) clears that.
#[wasm_bindgen]
pub async fn subscribe_doc_changes(on_change: js_sys::Function) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.changes_subscribed.replace(true) {
        return Ok(());
    }
    let mut events = eng.doc.subscribe().await.map_err(je)?;
    wasm_bindgen_futures::spawn_local(async move {
        while let Some(res) = events.next().await {
            let (kind, key) = match &res {
                Ok(ev) => live_event_parts(ev),
                Err(e) => (EV_ERROR, e.to_string()),
            };
            let (collection, rkey) = parse_record_key(&key).unwrap_or(("", ""));
            // Ignore a JS callback throw; keep pumping.
            let _ = on_change.call3(
                &JsValue::NULL,
                &JsValue::from_str(collection),
                &JsValue::from_str(rkey),
                &JsValue::from_str(kind),
            );
        }
    });
    Ok(())
}

/// Start the Curator's subscription pull loop in this tab.
///
/// The same loop the desktop Curator runs, from the same crate — a tab is a shorter-
/// lived instance of the Curator, not a lesser one. What differs is uptime: this stops
/// when the tab closes, and a desktop's doesn't.
///
/// Reports each pass to `on_pass` as a JSON `PullOutcome` (or an error string), which
/// is diagnostics only — the loop's actual output is the records it writes, and those
/// announce themselves on the change feed.
///
/// Spawned locally rather than by the shared crate, because which executor a task
/// belongs on is a per-target question: here there is only one.
#[wasm_bindgen]
pub async fn start_pull_loop(
    app_key_hex: String,
    cadence_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.pull_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let ctx = pin_curator::PullContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        sia: sia(),
        app_key,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_pull_loop(
            ctx,
            std::time::Duration::from_secs(cadence_secs as u64),
            |result| {
                let report = match &result {
                    Ok(o) => serde_json::json!({
                        "cached": o.cached,
                        "unresolved": o.unresolved,
                        "failed": o.failed,
                        "dropped": o.dropped,
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                // Ignore a JS callback throw; the loop outlives any one report.
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start the Curator's locator keep-alive loop in this tab.
///
/// The same loop the desktop runs, and it matters here for the same reason: an owned
/// channel whose locator ages off the DHT stops resolving for its subscribers, and a
/// tab is a full instance of the Curator rather than a lesser one. Uptime is what
/// differs — a tab republishes while it's open, a desktop while it's on.
///
/// Needs no Sia session: republishing re-signs a pointer that already names its object.
#[wasm_bindgen]
pub async fn start_keep_alive_loop(
    app_key_hex: String,
    cadence_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.keep_alive_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let ctx = pin_curator::KeepAliveContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        app_key,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_keep_alive_loop(
            ctx,
            std::time::Duration::from_secs(cadence_secs as u64),
            |result| {
                let report = match &result {
                    Ok(o) => serde_json::json!({
                        "refreshed": o.refreshed,
                        "unknown": o.unknown,
                        "failed": o.failed,
                        "talliesRefreshed": o.tallies_refreshed,
                        "talliesFailed": o.tallies_failed,
                        "settings": format!("{:?}", o.settings).to_lowercase(),
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start the channel-doc serve loop in this tab.
///
/// Serves each owned channel as a live replica and keeps a read ticket published, so a
/// subscriber is pushed new posts rather than polling for them. It copies the sealed
/// manifest out of the main doc verbatim, so it needs no Sia session and never sees a
/// channel's content.
#[wasm_bindgen]
pub async fn start_channel_doc_loop(
    app_key_hex: String,
    cadence_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.channel_doc_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let ctx = pin_curator::ChannelDocContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        docs: eng.docs.api().clone(),
        app_key,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_channel_doc_loop(
            ctx,
            std::time::Duration::from_secs(cadence_secs as u64),
            |result| {
                let report = match &result {
                    Ok(o) => serde_json::json!({
                        "copied": o.copied,
                        "unchanged": o.unchanged,
                        "advertised": o.advertised,
                        "unpublished": o.unpublished,
                        "failed": o.failed,
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start the channel live-sync loop in this tab.
///
/// Imports each subscribed channel's doc from its author and writes what arrives into
/// `sub/<channelID>` — the same record the polling rung writes, so whatever renders is
/// already watching it.
#[wasm_bindgen]
pub async fn start_channel_sync_loop(
    app_key_hex: String,
    cadence_secs: u32,
    retry_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.channel_sync_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let ctx = pin_curator::ChannelSyncContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        docs: eng.docs.api().clone(),
        app_key,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_channel_sync_loop(
            ctx,
            std::time::Duration::from_secs(cadence_secs as u64),
            std::time::Duration::from_secs(retry_secs as u64),
            |result| {
                let report = match &result {
                    Ok(o) => serde_json::json!({
                        "imported": o.imported,
                        "watching": o.watching,
                        "unavailable": o.unavailable,
                        "failed": o.failed,
                        "pushed": o.pushed,
                        "stale": o.stale,
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start the doc-to-Sia snapshot loop in this tab.
///
/// The identity's durability floor: whatever is in the doc, mirrored to Sia and named
/// by a published locator. One writer, reading the doc — it replaces a snapshot that
/// two React effects each took on their own debounce, racing on one pointer.
#[wasm_bindgen]
pub async fn start_snapshot_loop(
    app_key_hex: String,
    cadence_secs: u32,
    settle_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.snapshot_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let ctx = pin_curator::SnapshotContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        sia: sia(),
        app_key,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_snapshot_loop(
            ctx,
            std::time::Duration::from_secs(cadence_secs as u64),
            std::time::Duration::from_secs(settle_secs as u64),
            |result| {
                let report = match &result {
                    Ok(o) => serde_json::json!({
                        "unchanged": o.unchanged,
                        "records": o.records,
                        "url": o.url,
                        "published": o.published,
                        "pruned": o.pruned,
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start the repack loop in this tab.
///
/// The same loop the desktop Curator runs — scheduling isn't a capability boundary, so
/// a tab that's open tidies its own storage rather than waiting for a machine that
/// might not exist. It needs a connected Sia session, since every leg of a pass is a
/// Sia call.
///
/// `now_secs` and `now_iso` come from the caller: wasm has no system clock, and the
/// loop is the wrong place to learn about one.
#[wasm_bindgen]
pub async fn start_repack_loop(
    app_key_hex: String,
    cadence_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.repack_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let ctx = pin_curator::RepackContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        sia: sia(),
        app_key,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_repack_loop(
            ctx,
            std::time::Duration::from_secs(cadence_secs as u64),
            || (js_sys::Date::now() / 1000.0) as i64,
            || js_sys::Date::new_0().to_iso_string().into(),
            |result| {
                let report = match &result {
                    Ok(Some(o)) => serde_json::json!({
                        "reclaimedSlabs": o.reclaimed_slabs,
                        "moved": o.moved,
                        "channels": o.channels,
                        "pins": o.pins,
                    })
                    .to_string(),
                    Ok(None) => serde_json::json!({ "idle": true }).to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start this instance's registration loop in this tab.
///
/// A tab is a real endpoint of this identity — it can be synced with and dialed over
/// its relay — so it belongs in the published set while it's open. It registers as NOT
/// durable, which is the honest difference: a desktop stays up, a tab doesn't, and a
/// peer choosing among endpoints should know which is which.
#[wasm_bindgen]
pub async fn start_instance_loop(
    cadence_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.instance_running.replace(true) {
        return Ok(());
    }
    let ctx = pin_curator::InstanceContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        node_id: eng.endpoint.id().to_string(),
        durable: false,
    };
    // The home relay, read per pass rather than captured: a tab is relay-only, and the
    // endpoint reaches its relay some time after binding — so the first pass usually has
    // nothing to report and a later one fills it in.
    let endpoint = eng.endpoint.clone();
    let relay = move || {
        endpoint.addr().addrs.iter().find_map(|a| match a {
            iroh::TransportAddr::Relay(url) => Some(url.to_string()),
            _ => None,
        })
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_instance_loop(
            ctx,
            std::time::Duration::from_secs(cadence_secs as u64),
            // js_sys::Date rather than SystemTime, which panics on this target.
            || (js_sys::Date::now() / 1000.0) as u64,
            relay,
            |result| {
                let report = match &result {
                    Ok(o) => serde_json::json!({ "live": o.live, "pruned": o.pruned }).to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start the instance rendezvous loop in this tab — advertise where this tab can be
/// reached, and sync with the identity's other instances.
///
/// A tab is a full peer here, not a client: it publishes its own ticket and can be
/// synced FROM as well as syncing TO. It advertises as not-durable, which is the honest
/// difference — a peer choosing among endpoints should know which one will still be
/// there in an hour.
#[wasm_bindgen]
pub async fn start_rendezvous_loop(
    app_key_hex: String,
    cadence_secs: u32,
    retry_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.rendezvous_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let ctx = pin_curator::RendezvousContext {
        doc: eng.doc.clone(),
        app_key,
        instance_id: eng.endpoint.id().to_string(),
        durable: false,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_rendezvous_loop(
            ctx,
            std::time::Duration::from_secs(cadence_secs as u64),
            std::time::Duration::from_secs(retry_secs as u64),
            // js_sys::Date rather than SystemTime, which panics on this target.
            || (js_sys::Date::now() / 1000.0) as u64,
            |result| {
                let report = match &result {
                    Ok(o) => serde_json::json!({
                        "advertised": o.advertised,
                        "peers": o.peers,
                        "reached": o.reached,
                        "syncing": o.syncing,
                        "unreachable": o.unreachable,
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start the engagement loop in this tab — read what the graph endorsed, hold what
/// verifies, publish a tally per subject.
///
/// The same loop a desktop runs, from the same crate. A tab reaches the network exactly as
/// well while it is open, so there is nothing about crawling that differs by device; what
/// differs is only how long it stays open to keep doing it.
#[wasm_bindgen]
pub async fn start_engagement_loop(
    app_key_hex: String,
    cadence_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.engagement_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let own_did = format!(
        "did:dht:{}",
        pin_pkarr::public_key_from_seed(&pin_derive::did_dht_seed(&app_key))
            .map_err(|e| JsValue::from_str(&e))?
    );
    let ctx = pin_curator::EngagementContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        docs: eng.docs.api().clone(),
        sia: sia(),
        app_key,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_engagement_loop(
            ctx,
            own_did,
            std::time::Duration::from_secs(cadence_secs as u64),
            // From JS: neither SystemTime nor a date formatter is available on this target.
            || js_sys::Date::new_0().to_iso_string().into(),
            |result| {
                let report = match &result {
                    Ok(o) => serde_json::json!({
                        "reached": o.reached,
                        "unreachable": o.unreachable,
                        "added": o.added,
                        "withdrawn": o.withdrawn,
                        "tallies": o.tallies,
                        "cleared": o.cleared,
                        "rejected": o.rejected,
                        "notOurs": o.not_ours,
                        "published": o.published,
                        "publishFailed": o.publish_failed,
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start the delivery loop in this tab — knock this identity's endorsements through to
/// the people they are about.
///
/// A tab dials exactly as well as a desktop, so this is the same loop from the same crate.
/// What differs is only how long it stays open to keep making the attempt — and an
/// endorsement it doesn't get to is one the next instance picks up, since the mark that
/// says what has been delivered lives in the doc they share.
#[wasm_bindgen]
pub async fn start_deliver_loop(
    app_key_hex: String,
    cadence_secs: u32,
    retry_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.deliver_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let own_did = format!(
        "did:dht:{}",
        pin_pkarr::public_key_from_seed(&pin_derive::did_dht_seed(&app_key))
            .map_err(|e| JsValue::from_str(&e))?
    );
    let ctx = pin_curator::DeliverContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        endpoint: eng.endpoint.clone(),
        app_key,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_deliver_loop(
            ctx,
            own_did,
            std::time::Duration::from_secs(cadence_secs as u64),
            std::time::Duration::from_secs(retry_secs as u64),
            |result| {
                let report = match result {
                    Ok(o) => serde_json::json!({
                        "delivered": o.delivered,
                        "already": o.already,
                        "unreachable": o.unreachable,
                        "noTarget": o.no_target,
                        "own": o.own,
                        "dropped": o.dropped,
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
    Ok(())
}

/// Start the identity-publishing loop in this tab — one packet under the did:dht key
/// carrying the directory pointer, the doc namespace, and every live endpoint.
///
/// A tab publishes the same record a desktop does, from the same crate, because both
/// assemble it from the doc rather than from what they happen to know locally. That's
/// what stopped them overwriting each other.
#[wasm_bindgen]
pub async fn start_identity_loop(
    app_key_hex: String,
    namespace_id: String,
    cadence_secs: u32,
    on_pass: js_sys::Function,
) -> Result<(), JsValue> {
    let eng = engine()?;
    if eng.identity_running.replace(true) {
        return Ok(());
    }
    let app_key = decode_app_key(&app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    let ctx = pin_curator::IdentityContext {
        doc: eng.doc.clone(),
        blobs: (*eng.blobs).clone(),
        author_id: eng.author_id,
        sia: sia(),
        app_key,
        namespace_id,
    };
    wasm_bindgen_futures::spawn_local(async move {
        pin_curator::run_identity_loop(
            ctx,
            std::time::Duration::from_secs(cadence_secs as u64),
            // Both clocks come from JS: neither SystemTime nor a date formatter is
            // available on this target.
            || js_sys::Date::new_0().to_iso_string().into(),
            || (js_sys::Date::now() / 1000.0) as u64,
            |result| {
                let report = match &result {
                    Ok(o) => serde_json::json!({
                        "uploaded": o.uploaded,
                        "published": o.published,
                        "endpoints": o.endpoints,
                        "empty": o.empty,
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e }).to_string(),
                };
                let _ = on_pass.call1(&JsValue::NULL, &JsValue::from_str(&report));
            },
        )
        .await
    });
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

/// Every record in the doc, as `{collection, rkey}` pairs (JSON). Used to snapshot the
/// whole doc (docsMirror).
///
/// The key is split HERE, by `pin_derive`'s `RecordKey`, rather than handed over raw
/// for the frontend to split — so this engine and the desktop's decompose keys with
/// one definition. Keys that aren't record keys are skipped: a whole-doc snapshot
/// shouldn't fail over one stray key.
#[wasm_bindgen]
pub async fn list_all() -> Result<String, JsValue> {
    let eng = engine()?;
    let mut stream = Box::pin(eng.doc.get_many(Query::all().build()).await.map_err(je)?);
    let mut keys = Vec::new();
    while let Some(res) = stream.next().await {
        let entry = res.map_err(je)?;
        if let Some(parsed) = RecordKey::parse(&String::from_utf8_lossy(entry.key())) {
            keys.push(parsed);
        }
    }
    out(&keys)
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
/// namespace id. `on_event(nsID, kind, key)` fires per `LiveEvent` — structured
/// rather than one string so the frontend never parses a label, and the desktop's
/// Tauri-event payload carries the same three fields.
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
            let (kind, key) = match &res {
                Ok(ev) => live_event_parts(ev),
                Err(e) => (EV_ERROR, e.to_string()),
            };
            // Ignore a JS callback throw; keep pumping.
            let _ = on_event.call3(
                &JsValue::NULL,
                &JsValue::from_str(&ns_for_events),
                &JsValue::from_str(kind),
                &JsValue::from_str(&key),
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

/// Split a `LiveEvent` into its shared `kind` (see `pin_derive`'s `EV_*`) and the
/// entry key it concerns, empty when the event isn't about one entry. The native
/// Curator maps its own `LiveEvent` to the same pair, so the frontend gets one
/// vocabulary from both engines.
fn live_event_parts(ev: &LiveEvent) -> (&'static str, String) {
    match ev {
        LiveEvent::InsertLocal { entry } => (
            EV_INSERT_LOCAL,
            String::from_utf8_lossy(entry.key()).to_string(),
        ),
        LiveEvent::InsertRemote { entry, .. } => (
            EV_INSERT_REMOTE,
            String::from_utf8_lossy(entry.key()).to_string(),
        ),
        LiveEvent::ContentReady { .. } => (EV_CONTENT_READY, String::new()),
        LiveEvent::PendingContentReady => (EV_PENDING_CONTENT_READY, String::new()),
        LiveEvent::NeighborUp(_) => (EV_NEIGHBOR_UP, String::new()),
        LiveEvent::NeighborDown(_) => (EV_NEIGHBOR_DOWN, String::new()),
        LiveEvent::SyncFinished(_) => (EV_SYNC_FINISHED, String::new()),
    }
}

/// The one-line form, for `start_sync`'s status callback (the sync panel displays it).
/// Built from the same parts so there's only ever one spelling.
fn live_event_label(ev: &LiveEvent) -> String {
    let (kind, key) = live_event_parts(ev);
    if key.is_empty() {
        kind.to_string()
    } else {
        format!("{kind} {key}")
    }
}

// --- Key derivations ---------------------------------------------------------
//
// Thin wasm-bindgen wrappers over `pin_derive`, so the browser reaches the SAME
// derivations the native Curator calls directly rather than reimplementing them in
// TypeScript. Pure functions — no engine, no network — but they still need the wasm
// module instantiated, which `core/wasm.ts` handles for every caller at once.
//
// Each returns 32 bytes (a `Uint8Array` in JS). The two IKM families are visible in
// the parameter names: `app_key` derivations are recoverable from the recovery
// phrase, `channel_key` ones are what a subscriber holding only K can reach.

/// A plaintext content fingerprint (CIDv1, raw codec, SHA-256).
///
/// Uploads already carry their own hash back from `pin-sia`, so nothing in the
/// production path calls this — it exists for bytes the app holds without having just
/// uploaded them, which today means the integration tier's fake client.
#[wasm_bindgen]
pub fn content_hash(bytes: &[u8]) -> String {
    pin_crypto::content_hash(bytes)
}

// --- the channel locator ------------------------------------------------------
//
// A channel's durable round-trip, sequenced in `pin_channel` rather than here so the
// Curator can resolve subscribed channels natively for its pull loop without the
// sequence being written a second time.
//
// The manifest crosses as an opaque JSON string. Nothing in Rust reads a field of it,
// so modelling the type would mean a second definition of a rich nested shape with
// nothing to use it — and JSON is the plaintext inside every manifest already sealed on
// Sia regardless, so it is what has to be produced either way.

/// Seal a manifest under K, upload it, and publish the pointer. Returns `Published`
/// as JSON — the caller needs the object id to reclaim the generation it superseded.
#[wasm_bindgen]
pub async fn channel_publish(channel_key: &[u8], manifest_json: String) -> Result<String, JsValue> {
    let key = key32(channel_key)?;
    let published = pin_channel::publish(&sia(), &key, &manifest_json)
        .await
        .map_err(je)?;
    serde_json::to_string(&published).map_err(|e| JsValue::from_str(&format!("encode: {e}")))
}

/// Read a channel from K alone. `undefined` when the locator resolves to nothing, which
/// is ordinary — unpublished, or aged off the DHT.
#[wasm_bindgen]
pub async fn channel_resolve(channel_key: &[u8]) -> Result<Option<String>, JsValue> {
    let key = key32(channel_key)?;
    match pin_channel::resolve(&sia(), &key).await.map_err(je)? {
        None => Ok(None),
        Some(resolved) => Ok(Some(
            serde_json::to_string(&resolved)
                .map_err(|e| JsValue::from_str(&format!("encode: {e}")))?,
        )),
    }
}

/// Re-sign a channel's current pointer to refresh its TTL, without minting a new object.
#[wasm_bindgen]
pub async fn channel_republish_pointer(
    channel_key: &[u8],
    item_url: String,
) -> Result<(), JsValue> {
    let key = key32(channel_key)?;
    pin_channel::republish_pointer(&key, &item_url)
        .await
        .map_err(je)
}

/// Open a sealed manifest blob with K — the path a CACHED copy takes, so that a cached
/// read and a fresh resolve decode identically.
#[wasm_bindgen]
pub fn channel_open_blob(channel_key: &[u8], blob: &str) -> Result<String, JsValue> {
    pin_channel::open_blob(&key32(channel_key)?, blob).map_err(je)
}

/// Where a channel's tallies currently are, without fetching them.
///
/// Exposed apart from the fetch, unlike the manifest's composed `channel_resolve`,
/// because for tallies the split IS the point: the URL is a content address, so a caller
/// holding the one it last read learns from this alone that the counts haven't moved and
/// skips the download.
#[wasm_bindgen]
pub async fn channel_resolve_tallies_url(channel_key: &[u8]) -> Result<Option<String>, JsValue> {
    pin_channel::resolve_tallies_url(&key32(channel_key)?)
        .await
        .map_err(je)
}

/// Download and open a channel's tallies at a URL already resolved for it. Returns the
/// subject-to-tally map as JSON.
#[wasm_bindgen]
pub async fn channel_fetch_tallies(
    channel_key: &[u8],
    item_url: String,
) -> Result<String, JsValue> {
    pin_channel::fetch_tallies(&sia(), &key32(channel_key)?, &item_url)
        .await
        .map_err(je)
}

// --- manifest transforms -------------------------------------------------------
//
// The rules for changing a channel, reached from the browser. Manifests and items cross
// as JSON strings, which is the shape they already travel in everywhere else — sealed
// under K on Sia, cached in the doc — so nothing here invents a second encoding.
//
// Each takes `now` from the caller rather than reading a clock: `SystemTime::now()`
// panics on wasm32, and the timestamp has to be the one JavaScript would have written,
// because a manifest's `publishedAt` is compared as a string to decide which of two
// copies is newer.

fn manifest_in(json: &str) -> Result<pin_manifest::ChannelManifest, JsValue> {
    serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&format!("manifest is not readable: {e}")))
}

fn item_in(json: &str) -> Result<pin_manifest::ItemRef, JsValue> {
    serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("item is not readable: {e}")))
}

fn out<T: serde::Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|e| JsValue::from_str(&format!("encode: {e}")))
}

/// Add a newly published item to the front of the channel.
#[wasm_bindgen]
pub fn manifest_append_item(
    manifest_json: &str,
    item_json: &str,
    now: &str,
) -> Result<String, JsValue> {
    let manifest =
        pin_manifest::append_item(&manifest_in(manifest_json)?, item_in(item_json)?, now);
    out(&manifest)
}

/// Retract one item, returning the next manifest and the bytes nothing else references.
#[wasm_bindgen]
pub fn manifest_delete_item(
    manifest_json: &str,
    item_id: &str,
    protected_object_ids: Vec<String>,
    now: &str,
) -> Result<String, JsValue> {
    out(&pin_manifest::delete_item(
        &manifest_in(manifest_json)?,
        item_id,
        &protected_object_ids.into_iter().collect(),
        now,
    ))
}

/// Retract a single attachment, leaving the post and its other files in place.
#[wasm_bindgen]
pub fn manifest_remove_attachment(
    manifest_json: &str,
    item_id: &str,
    attachment_url: &str,
    protected_object_ids: Vec<String>,
    now: &str,
) -> Result<String, JsValue> {
    let rewritten = pin_manifest::remove_attachment(
        &manifest_in(manifest_json)?,
        item_id,
        attachment_url,
        &protected_object_ids.into_iter().collect(),
        now,
    )
    .map_err(je)?;
    out(&rewritten)
}

/// Replace an item's content, keeping its place in the channel's chronology.
#[wasm_bindgen]
pub fn manifest_edit_item(
    manifest_json: &str,
    old_item_id: &str,
    new_item_json: &str,
    removed_attachment_object_ids: Vec<String>,
    now: &str,
) -> Result<String, JsValue> {
    let rewritten = pin_manifest::edit_item(
        &manifest_in(manifest_json)?,
        old_item_id,
        item_in(new_item_json)?,
        &removed_attachment_object_ids,
        now,
    )
    .map_err(je)?;
    out(&rewritten)
}

/// Enumerate what a whole-channel retract leaves behind. `manifest_json` is empty when
/// the locator no longer resolves — a retract whose target is already gone still
/// succeeds, having nothing to enumerate.
#[wasm_bindgen]
pub fn manifest_enumerate_retract(
    manifest_json: &str,
    protected_object_ids: Vec<String>,
) -> Result<String, JsValue> {
    let manifest = if manifest_json.is_empty() {
        None
    } else {
        Some(manifest_in(manifest_json)?)
    };
    out(&pin_manifest::enumerate_retract(
        manifest.as_ref(),
        &protected_object_ids.into_iter().collect(),
    ))
}

/// Build the manifest a new channel starts life as.
///
/// Images arrive already stored, as references inside the args — storing bytes needs a
/// connected Sia session, and which one that is differs by platform, so it stays with the
/// caller and this stays a pure build.
#[wasm_bindgen]
pub fn manifest_create_channel(new_channel_json: &str, now: &str) -> Result<String, JsValue> {
    let new: pin_manifest::NewChannel = serde_json::from_str(new_channel_json)
        .map_err(|e| JsValue::from_str(&format!("new channel is not readable: {e}")))?;
    out(&pin_manifest::create_channel(new, now))
}

/// Apply a patch to a channel's details, reporting the images it left behind.
#[wasm_bindgen]
pub fn manifest_edit_channel(
    manifest_json: &str,
    patch_json: &str,
    now: &str,
) -> Result<String, JsValue> {
    let patch: pin_manifest::ChannelPatch = serde_json::from_str(patch_json)
        .map_err(|e| JsValue::from_str(&format!("channel patch is not readable: {e}")))?;
    out(&pin_manifest::edit_channel(
        &manifest_in(manifest_json)?,
        patch,
        now,
    ))
}

/// Shape an upload result and a draft into the item that goes in the manifest.
#[wasm_bindgen]
pub fn manifest_build_item(
    uploaded_json: &str,
    draft_json: &str,
    now: &str,
) -> Result<String, JsValue> {
    let uploaded: pin_manifest::UploadedItem = serde_json::from_str(uploaded_json)
        .map_err(|e| JsValue::from_str(&format!("upload result is not readable: {e}")))?;
    let draft: pin_manifest::ItemDraft = serde_json::from_str(draft_json)
        .map_err(|e| JsValue::from_str(&format!("draft is not readable: {e}")))?;
    out(&pin_manifest::build_item_ref(&uploaded, draft, now))
}

// --- the encrypted-blob envelope ----------------------------------------------
//
// Thin wrappers over `pin_crypto`, so the browser seals and opens blobs with the SAME
// code the Curator will — and, more to the point, with one definition of a format that
// live manifests on Sia are already written in. Web Crypto's AES-GCM used to be the
// implementation here; pin-crypto's tests decrypt a blob it produced, which is what
// makes swapping it out safe rather than hopeful.
//
// Keys arrive as bytes and are length-checked here: a JS caller can hand over any
// Uint8Array, and a 31-byte key should say so rather than fail somewhere in the cipher.

fn key32(key: &[u8]) -> Result<[u8; 32], JsValue> {
    key.try_into()
        .map_err(|_| JsValue::from_str(&format!("key must be 32 bytes; got {}", key.len())))
}

/// A channel's public identifier, derived from its key. Pin's own format (a truncated
/// SHA-256 in a specific base32 alphabet), so it is derived in one place rather than
/// independently on each side — two sides disagreeing would name the same channel
/// differently and never find each other's.
#[wasm_bindgen]
pub fn channel_id(channel_key: &[u8]) -> Result<String, JsValue> {
    Ok(pin_crypto::channel_id(&key32(channel_key)?))
}

/// Seal a UTF-8 string under a channel key, returning the base64 blob.
#[wasm_bindgen]
pub fn encrypt_for_channel(key: &[u8], plaintext: &str) -> Result<String, JsValue> {
    pin_crypto::encrypt(&key32(key)?, plaintext.as_bytes()).map_err(je)
}

/// Open a base64 blob sealed under a channel key. The plaintext is UTF-8 (a manifest's
/// JSON), so this returns it as a string.
#[wasm_bindgen]
pub fn decrypt_for_channel(key: &[u8], blob_b64: &str) -> Result<String, JsValue> {
    let bytes = pin_crypto::decrypt(&key32(key)?, blob_b64).map_err(je)?;
    String::from_utf8(bytes).map_err(|_| JsValue::from_str("decrypted blob is not valid UTF-8"))
}

/// Seal the settings payload, padded to a fixed size so its length carries nothing.
#[wasm_bindgen]
pub fn encrypt_settings(key: &[u8], plaintext: &str) -> Result<String, JsValue> {
    pin_crypto::encrypt_settings(&key32(key)?, plaintext.as_bytes()).map_err(je)
}

/// Open a padded settings blob, returning the payload with the padding stripped.
#[wasm_bindgen]
pub fn decrypt_settings(key: &[u8], blob_b64: &str) -> Result<String, JsValue> {
    let bytes = pin_crypto::decrypt_settings(&key32(key)?, blob_b64).map_err(je)?;
    String::from_utf8(bytes)
        .map_err(|_| JsValue::from_str("decrypted settings blob is not valid UTF-8"))
}

/// The settings pad size, exposed so the app has one definition of it rather than a
/// copy that could drift out of step with what the padding actually does.
#[wasm_bindgen]
pub fn settings_pad_size() -> usize {
    pin_crypto::SETTINGS_PAD_SIZE
}

/// Settings-record encryption key.
#[wasm_bindgen]
pub fn derive_settings_key(app_key: &[u8]) -> Vec<u8> {
    pin_derive::settings_key(app_key).to_vec()
}

/// Sia whole-doc snapshot encryption key.
#[wasm_bindgen]
pub fn derive_snapshot_key(app_key: &[u8]) -> Vec<u8> {
    pin_derive::snapshot_key(app_key).to_vec()
}

/// The collection holding publish state.
#[wasm_bindgen]
pub fn published_collection() -> String {
    pin_derive::PUBLISHED_COLLECTION.to_string()
}

/// The rkey for one channel's publish state — the spelling the keep-alive loop looks
/// under, so the frontend has to write it the same way.
#[wasm_bindgen]
pub fn published_channel_rkey(channel_id: &str) -> String {
    pin_derive::published_channel_rkey(channel_id)
}

// --- engagement -----------------------------------------------------------------
//
// All three of these are PURE — no session, no network — so this is the wasm engine on
// both platforms, the same way `core/crypto.ts` derives through it on desktop. Nothing
// forks, because nothing about signing a record differs by device.

// --- the chunked-TXT convention -------------------------------------------------
//
// A pointer longer than one TXT character-string is split across indexed records and
// rejoined on the way back. Exposed here because the convention CROSSES: the Curator's
// loops publish `_dir`, `_s` and the channel locators in Rust, and the frontend reads
// them — so a reader that could not rejoin what a writer split would be a silent data
// failure, not an untidiness. There was a second implementation in TypeScript and a third
// in the integration fake; this is the one both now call.

/// Split a value into indexed TXT records under a prefix.
#[wasm_bindgen]
pub fn pkarr_chunk_txt(prefix: &str, value: &str) -> Result<String, JsValue> {
    out(&pin_pkarr::chunk_txt(prefix, value))
}

/// Rejoin a value split under a prefix. Records arrive in any order and with
/// fully-qualified names (`_c0.<pubkey>`), which is how a resolve returns them. Anything
/// not matching the prefix is ignored, so an empty string means "nothing published here".
#[wasm_bindgen]
pub fn pkarr_rejoin_txt(records_json: &str, prefix: &str) -> Result<String, JsValue> {
    let records: Vec<pin_pkarr::TxtRecord> = serde_json::from_str(records_json)
        .map_err(|e| JsValue::from_str(&format!("decode records: {e}")))?;
    Ok(pin_pkarr::rejoin_txt(&records, prefix))
}

/// The collection this identity's own endorsements live in.
#[wasm_bindgen]
pub fn endorse_collection() -> String {
    pin_derive::ENDORSE_COLLECTION.to_string()
}

/// The collection where counts are cached for reading.
#[wasm_bindgen]
pub fn tally_collection() -> String {
    pin_derive::TALLY_COLLECTION.to_string()
}

/// Where one subject's count is cached. From Rust because the Curator's loops write
/// these records and the frontend reads them: an address spelled twice would have one
/// side writing where the other never looks, silently.
#[wasm_bindgen]
pub fn tally_rkey(channel_id: &str, subject: &str) -> String {
    pin_derive::tally_rkey(channel_id, subject)
}

/// The subject an endorsement of this item names — the hash a count is keyed by, so a
/// reader can find the aggregate for something it is displaying.
///
/// `attachment` names one of the post's attachments by its content hash, in which case
/// the subject is that FILE's rather than the post's. Its count is separate on purpose:
/// keeping an attachment alive is not keeping the post alive, and counting a partial
/// custodian as a full one would overstate the redundancy the number reports.
#[wasm_bindgen]
pub fn engagement_subject(
    channel_id: &str,
    published_at: &str,
    attachment: Option<String>,
) -> String {
    subject_for(channel_id, published_at, attachment.as_deref())
}

fn subject_for(channel_id: &str, published_at: &str, attachment: Option<&str>) -> String {
    match attachment {
        Some(hash) => pin_crypto::attachment_subject(channel_id, published_at, hash),
        None => pin_crypto::engagement_subject(channel_id, published_at),
    }
}

/// Whether an endorsement holds up: signed by the identity it claims, and consistent
/// with any coordinates it carries.
///
/// Exposed so nothing verifies a record twice. Anything that displays a count from
/// records it did not write is asserting they are real, and a second implementation of
/// that check is a second chance to accept a forgery.
#[wasm_bindgen]
pub fn endorsement_verify(record_json: &str) -> Result<(), JsValue> {
    let record: pin_engagement::Endorsement = serde_json::from_str(record_json)
        .map_err(|e| JsValue::from_str(&format!("decode endorsement: {e}")))?;
    record.verify().map_err(|e| JsValue::from_str(&e))
}

/// Where one endorsement lives. Needed on its own as well as from `sign_endorsement`,
/// because withdrawing one addresses the record without producing another.
#[wasm_bindgen]
pub fn endorse_rkey(
    kind: &str,
    channel_id: &str,
    published_at: &str,
    attachment: Option<String>,
) -> String {
    pin_derive::endorse_rkey(
        kind,
        &subject_for(channel_id, published_at, attachment.as_deref()),
    )
}

/// Sign one endorsement, returning the record as the exact JSON to store.
///
/// Serialized here rather than returned as an object to stringify on the far side, so
/// the bytes that land in the doc are the ones Rust produced and the fold reads them
/// back with the same serde definition. Nothing in the path re-encodes.
///
/// `attachment` endorses one FILE of the post rather than the post, named by its content
/// hash. It goes into the reference too when there is one, so the self-check reproduces
/// the right subject — a record whose attachment field was dropped would otherwise read as
/// an endorsement of the whole post.
///
/// `reference_did_dht` is what chooses the visibility tier. Passing the channel author's
/// did:dht makes the record navigable and is correct ONLY for a public subject; passing
/// nothing publishes the subject hash alone, which is the answer for an unlisted or
/// private one — where a reference would give away the channel, and that it exists.
///
/// `now` comes from the caller: `SystemTime::now()` panics on wasm32, and this is the
/// same reason the manifest transforms take their timestamp as an argument.
#[wasm_bindgen]
pub fn sign_endorsement(
    app_key_hex: &str,
    kind: &str,
    channel_id: &str,
    published_at: &str,
    version: &str,
    reference_did_dht: Option<String>,
    attachment: Option<String>,
    now: &str,
) -> Result<String, JsValue> {
    let app_key = decode_app_key(app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key must be 32 bytes of hex"))?;
    let reference = reference_did_dht.map(|did_dht| pin_engagement::SubjectRef {
        did_dht,
        channel_id: channel_id.to_string(),
        published_at: published_at.to_string(),
        attachment: attachment.clone(),
    });
    let record = pin_engagement::Endorsement::sign(
        &pin_derive::did_dht_seed(&app_key),
        kind,
        &subject_for(channel_id, published_at, attachment.as_deref()),
        version,
        now,
        reference,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    out(&record)
}

/// The rkey for the settings snapshot's publish state. Same contract as above: the
/// frontend writes it when it snapshots, the keep-alive loop reads it to know which
/// pointer to republish.
#[wasm_bindgen]
pub fn published_settings_rkey() -> String {
    pin_derive::PUBLISHED_SETTINGS_RKEY.to_string()
}

/// The collection holding what this identity keeps — one record per pin.
#[wasm_bindgen]
pub fn pinned_collection() -> String {
    pin_derive::PINNED_COLLECTION.to_string()
}

/// The rkey for one pin, from the logical item it keeps. The Curator's repack reads
/// these to learn what's in this identity's scope, so the spelling is shared.
#[wasm_bindgen]
pub fn pinned_rkey(channel_id: &str, published_at: &str) -> String {
    pin_derive::pinned_rkey(channel_id, published_at)
}

/// Pin-record encryption key.
#[wasm_bindgen]
pub fn derive_pinned_key(app_key: &[u8]) -> Vec<u8> {
    pin_derive::pinned_key(app_key).to_vec()
}

/// The TXT prefix the settings locator's pointer is chunked under. Read from here
/// rather than spelled again in TypeScript, because the frontend publishes this record
/// and the Curator republishes it — and a mismatch writes the pointer somewhere no
/// reader looks, which recovery cannot tell apart from having no settings at all.
#[wasm_bindgen]
pub fn settings_pointer_prefix() -> String {
    pin_derive::SETTINGS_POINTER_PREFIX.to_string()
}

/// Publish-state encryption key.
#[wasm_bindgen]
pub fn derive_published_key(app_key: &[u8]) -> Vec<u8> {
    pin_derive::published_key(app_key).to_vec()
}

/// The identity's did:dht ed25519 seed — the same value `identity.rs` derives.
#[wasm_bindgen]
pub fn derive_did_dht_seed(app_key: &[u8]) -> Vec<u8> {
    pin_derive::did_dht_seed(app_key).to_vec()
}

/// A channel's pkarr locator seed, from its channel key K.
#[wasm_bindgen]
pub fn derive_channel_locator_seed(channel_key: &[u8]) -> Vec<u8> {
    pin_derive::channel_locator_seed(channel_key).to_vec()
}

/// A channel's iroh-docs namespace seed (AppKey-derived — the write capability stays
/// with the author).
#[wasm_bindgen]
pub fn derive_channel_doc_seed(app_key: &[u8], channel_id: &str) -> Vec<u8> {
    pin_derive::channel_doc_seed(app_key, channel_id).to_vec()
}

/// The pkarr seed for a channel's read-DocTicket record, from its channel key K.
#[wasm_bindgen]
pub fn derive_channel_doc_ticket_seed(channel_key: &[u8]) -> Vec<u8> {
    pin_derive::channel_doc_ticket_seed(channel_key).to_vec()
}

/// The pkarr seed for your settings-snapshot pointer.
#[wasm_bindgen]
pub fn derive_settings_locator_seed(app_key: &[u8]) -> Vec<u8> {
    pin_derive::settings_locator_seed(app_key).to_vec()
}

/// The pkarr seed for your instance-rendezvous directory.
#[wasm_bindgen]
pub fn derive_rendezvous_seed(app_key: &[u8]) -> Vec<u8> {
    pin_derive::rendezvous_seed(app_key).to_vec()
}

/// The pkarr seed for one instance's rendezvous entry.
#[wasm_bindgen]
pub fn derive_rendezvous_instance_seed(rendezvous_seed: &[u8], instance_id: &str) -> Vec<u8> {
    pin_derive::rendezvous_instance_seed(rendezvous_seed, instance_id).to_vec()
}

// --- pkarr: the signed, identity-keyed pointers -------------------------------
//
// Wrappers over `pin_pkarr`, which the native Curator also uses — so the packet shape,
// TTL and retry posture are one definition, and only the transport differs by target
// (public relays here, since a browser can't send UDP; the Mainline DHT natively).
//
// Records cross as a JSON array of {name, value} rather than through a typed binding:
// it's a handful of small strings on an infrequent call, and it keeps this seam free of
// an extra serde-to-JS dependency.

/// The z-base32 public key for a 32-byte seed — the key a resolver looks up.
#[wasm_bindgen]
pub fn pkarr_public_key(seed: &[u8]) -> Result<String, JsValue> {
    pin_pkarr::public_key_from_seed(seed).map_err(|e| JsValue::from_str(&e))
}

/// Publish TXT records signed by the key derived from `seed`, replacing whatever that
/// key previously pointed at. Takes seconds (DHT store latency); call in the background.
#[wasm_bindgen]
pub async fn pkarr_publish(seed: Vec<u8>, records_json: String) -> Result<(), JsValue> {
    let records: Vec<pin_pkarr::TxtRecord> = serde_json::from_str(&records_json)
        .map_err(|e| JsValue::from_str(&format!("records: {e}")))?;
    pin_pkarr::publish(&seed, &records)
        .await
        .map_err(|e| JsValue::from_str(&e))
}

/// Resolve a `did:dht:<key>` (or bare key) to its current TXT records, as JSON. An
/// empty array means nothing is published or resolvable — an ordinary outcome, not an
/// error.
#[wasm_bindgen]
pub async fn pkarr_resolve(key: String) -> Result<String, JsValue> {
    let records = pin_pkarr::resolve(&key)
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&records).map_err(|e| JsValue::from_str(&format!("encode: {e}")))
}

// --- Sia: bytes, custody and the connect flow ---------------------------------
//
// Wrappers over `pin_sia`, which the desktop backend also uses — so the connect
// typestate, the pinned-objects walk and the descriptor shapes are one definition
// rather than a TypeScript copy and a Rust copy kept in step by comment.
//
// Structured results cross as JSON, matching the pkarr seam above: the descriptors
// already derive `Serialize`, and their `slabs` field reuses the SDK's own type,
// whose serde emits byte-for-byte the shape the frontend's `Slab` interface expects.
// Raw bytes cross as `Vec<u8>` (an ArrayBuffer in JS), never base64.

// `Arc` rather than `Rc` even though this is single-threaded: the shared pull loop
// takes an `Arc<Session>` so that natively the same type can cross a thread, and one
// session type keeps that crate free of a target-conditional signature. Atomic
// refcounting on a single thread is uncontended and costs nothing worth naming.
thread_local! {
    static SIA: RefCell<Option<Arc<pin_sia::Session>>> = const { RefCell::new(None) };
}

/// The session, created on first use.
///
/// Unlike the doc engine there is no "call open first" precondition: a `Session` is
/// inert until connected, and every operation below already reports the
/// not-connected case, so lazily minting one keeps the auth screens free of an
/// initialization step whose only job would be to fail later anyway.
fn sia() -> Arc<pin_sia::Session> {
    SIA.with(|s| {
        let mut slot = s.borrow_mut();
        if slot.is_none() {
            *slot = Some(Arc::new(pin_sia::Session::new()));
        }
        slot.clone().expect("session just created")
    })
}

/// Bridge a JS callback into the shard-progress hook, so upload progress bars keep
/// working across this boundary. A throwing callback is swallowed: it drives a
/// progress bar, and letting it abort an upload in flight would be a poor trade.
fn shard_callback(f: Option<js_sys::Function>) -> Option<pin_sia::ShardCallback> {
    f.map(|f| -> pin_sia::ShardCallback {
        std::sync::Arc::new(move || {
            let _ = f.call0(&JsValue::NULL);
        })
    })
}

// -- connect flow --------------------------------------------------------------

/// Restore a session from a stored AppKey. `false` means the indexer does not
/// recognise it — approval revoked, or never registered — which sends the user back
/// to the welcome screen rather than being an error worth reporting.
#[wasm_bindgen]
pub async fn sia_connect(app_key_hex: String, indexer_url: String) -> Result<bool, JsValue> {
    sia()
        .connect(&app_key_hex, &indexer_url)
        .await
        .map_err(|e| JsValue::from_str(&e))
}

/// Begin a connection and return the URL the user approves at.
#[wasm_bindgen]
pub async fn sia_request_connection(indexer_url: String) -> Result<String, JsValue> {
    sia()
        .request_connection(&indexer_url)
        .await
        .map_err(|e| JsValue::from_str(&e))
}

/// Block until the user approves at the indexer.
///
/// One long call that polls internally until approval or expiry, rather than
/// something to re-drive from a timer. Safe to invoke twice (React strict mode mounts
/// effects twice); the second call sees an already-approved request and returns.
#[wasm_bindgen]
pub async fn sia_wait_for_approval() -> Result<(), JsValue> {
    sia()
        .wait_for_approval()
        .await
        .map_err(|e| JsValue::from_str(&e))
}

/// Finish registration with the recovery phrase; returns the AppKey hex to persist.
#[wasm_bindgen]
pub async fn sia_register(mnemonic: String) -> Result<String, JsValue> {
    sia()
        .register(&mnemonic)
        .await
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub async fn sia_is_connected() -> bool {
    sia().is_connected().await
}

#[wasm_bindgen]
pub async fn sia_app_key_hex() -> Option<String> {
    sia().app_key_hex().await
}

#[wasm_bindgen]
pub fn sia_generate_recovery_phrase() -> String {
    pin_sia::generate_recovery_phrase()
}

/// The public key for an AppKey, as `ed25519:<hex>`.
///
/// Pure, so the client can capture it at construction — the accessor that reads it
/// is synchronous, and the value is stamped into every published channel manifest.
#[wasm_bindgen]
pub fn sia_public_key(app_key_hex: &str) -> Result<String, JsValue> {
    let app_key = pin_derive::decode_app_key(app_key_hex)
        .ok_or_else(|| JsValue::from_str("app key hex must be 32 bytes (64 hex chars)"))?;
    Ok(pin_sia::public_key(&app_key))
}

/// `Ok` for a well-formed phrase; the error carries why, for inline validation.
#[wasm_bindgen]
pub fn sia_validate_recovery_phrase(phrase: &str) -> Result<(), JsValue> {
    pin_sia::validate_recovery_phrase(phrase)
        .map_err(|e| JsValue::from_str(&format!("recovery phrase: {e}")))
}

// -- byte I/O ------------------------------------------------------------------

#[wasm_bindgen]
pub async fn sia_upload_item(
    bytes: Vec<u8>,
    on_shard: Option<js_sys::Function>,
) -> Result<String, JsValue> {
    let uploaded = sia()
        .upload_item(bytes, shard_callback(on_shard))
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&uploaded).map_err(|e| JsValue::from_str(&format!("encode: {e}")))
}

/// Bin-pack several objects into shared slabs, preserving input order.
///
/// Takes a JS array of `Uint8Array` rather than a framed blob: framing exists on the
/// desktop only because a raw IPC body is a single blob, which is not a constraint
/// here.
#[wasm_bindgen]
pub async fn sia_upload_items_packed(
    items: js_sys::Array,
    on_shard: Option<js_sys::Function>,
) -> Result<String, JsValue> {
    let mut buffers = Vec::with_capacity(items.length() as usize);
    for value in items.iter() {
        let bytes = value
            .dyn_into::<js_sys::Uint8Array>()
            .map_err(|_| JsValue::from_str("packed upload expects an array of Uint8Array"))?;
        buffers.push(bytes.to_vec());
    }
    let uploaded = sia()
        .upload_items_packed(buffers, shard_callback(on_shard))
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&uploaded).map_err(|e| JsValue::from_str(&format!("encode: {e}")))
}

#[wasm_bindgen]
pub async fn sia_download_item(url: String) -> Result<Vec<u8>, JsValue> {
    sia()
        .download_item(&url)
        .await
        .map_err(|e| JsValue::from_str(&e))
}

// -- custody -------------------------------------------------------------------

#[wasm_bindgen]
pub async fn sia_pin_from_share_url(url: String) -> Result<String, JsValue> {
    sia()
        .pin_from_share_url(&url)
        .await
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub async fn sia_resolve_object_id(url: String) -> Result<String, JsValue> {
    sia()
        .resolve_object_id(&url)
        .await
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub async fn sia_delete_object(id: String) -> Result<(), JsValue> {
    sia()
        .delete_object(&id)
        .await
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub async fn sia_prune_slabs() -> Result<(), JsValue> {
    sia().prune_slabs().await.map_err(|e| JsValue::from_str(&e))
}

// -- accounting ----------------------------------------------------------------

#[wasm_bindgen]
pub async fn sia_account_snapshot() -> Result<String, JsValue> {
    let snapshot = sia()
        .account_snapshot()
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&snapshot).map_err(|e| JsValue::from_str(&format!("encode: {e}")))
}

#[wasm_bindgen]
pub async fn sia_list_pinned_objects() -> Result<String, JsValue> {
    let objects = sia()
        .list_pinned_objects()
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&objects).map_err(|e| JsValue::from_str(&format!("encode: {e}")))
}

/// One object's slabs by id, as JSON. `None` when it is not in scope — a normal
/// answer (repack asks about references that may already be gone), not an error.
#[wasm_bindgen]
pub async fn sia_get_object_slabs(id: String) -> Result<Option<String>, JsValue> {
    let found = sia()
        .get_object_slabs(&id)
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    match found {
        Some(info) => serde_json::to_string(&info)
            .map(Some)
            .map_err(|e| JsValue::from_str(&format!("encode: {e}"))),
        None => Ok(None),
    }
}
