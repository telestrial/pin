// The iroh-docs engine — the repo/sync layer replacing the atrium repo + the
// hand-rolled 4-verb RPC (see CLAUDE.md 2026-07-05). iroh-docs is a multi-author
// synced KV: range-based set reconciliation (ships only the delta), live-sync over
// gossip, content-addressed values via iroh-blobs. Importing a peer's doc and
// letting it sync IS "network surfacing" — the pull loop collapses into the engine.
//
// Step 2 proved surfacing works inside the real Curator (two namespaces reconcile,
// live write propagates, delta-only transfer). Step 3a (this slice) stands the
// engine up for real: a PERSISTENT store (redb via iroh-blobs' fs-store, on disk)
// mounted on the Curator's OWN endpoint, running ALONGSIDE the atrium repo. The
// persistence proof is the "reopened from disk" state — the marker entry written on
// first run survives restarts. Removing atrium (and the head/record/diff verbs) is
// the next slice; this one adds without subtracting.
//
// Identity binding: the namespace + author keys derive from the same Sia AppKey the
// rest of the Curator's identity hangs off (HKDF, domain-separated `info`), so the
// Curator's doc is recoverable from the recovery phrase — the same one-root-secret
// move as the did:dht key and settings encryption.

use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use futures_lite::StreamExt as _;
use iroh::Endpoint;
use iroh_blobs::store::fs::FsStore;
use iroh_docs::{
    api::{
        protocol::{AddrInfoOptions, ShareMode},
        Doc,
    },
    engine::LiveEvent,
    protocol::Docs,
    store::Query,
    Author, AuthorId, Capability, DocTicket, NamespaceSecret,
};
use iroh_gossip::net::Gossip;
// Shared with pin-core (the browser engine): the doc namespace/author `info`s +
// hkdf32 + decode_app_key. Domain-separated from the did:dht identity
// (`pin:did-dht:v1`), the atproto signing key (`pin:atproto-signing:v1`), and
// settings (`pin:settings:v1`), all off the same AppKey root.
use pin_derive::{
    decode_app_key, decode_hex32, hkdf32, parse_record_key, record_key, AUTHOR_INFO,
    EV_CONTENT_READY, EV_ERROR, EV_INSERT_LOCAL, EV_INSERT_REMOTE, EV_NEIGHBOR_DOWN,
    EV_NEIGHBOR_UP, EV_PENDING_CONTENT_READY, EV_SYNC_FINISHED, NS_INFO,
};

/// The Curator's marker entry, mirroring the atrium repo's marker record — written
/// once, then expected to survive every reopen (the persistence self-check).
const MARKER_KEY: &[u8] = b"dev.sia.pin.marker/self";

/// The persistent iroh-docs engine, brought up on the Curator's endpoint and ready
/// to mount on its Router. Held for the Curator's lifetime; `docs`/`gossip` are
/// `Clone` and `blobs` derefs to the blobs `Store`, so the Router takes clones/refs
/// and this struct stays whole.
pub struct DocEngine {
    /// The Curator's own doc replica (this namespace). Handle for reading/writing
    /// entries and for `share()`ing a `DocTicket` a browser peer imports to sync.
    pub doc: Doc,
    /// The docs protocol handler (mount on `iroh_docs::ALPN`; also the API for
    /// reading/writing the Curator's doc).
    pub docs: Docs,
    /// The persistent blobs store (mount on `iroh_blobs::ALPN`; holds record
    /// values content-addressed).
    pub blobs: FsStore,
    /// The gossip overlay (mount on `iroh_gossip::ALPN`; drives live-sync).
    pub gossip: Gossip,
    /// The doc's author id (derived from the AppKey). Every read/write to `doc`
    /// is scoped to this author, so record CRUD over IPC needs it too.
    pub author_id: AuthorId,
    /// The Curator's doc namespace id (the doc's public identifier).
    pub namespace_id: String,
    /// The iroh node id this engine is serving on — this instance's dial coordinate,
    /// and the rkey it registers itself under.
    pub node_id: String,
    /// True if the marker was already present on load — i.e. the doc persisted from
    /// a prior run. False on first-ever creation. This is the persistence proof.
    pub reopened: bool,
    /// Channel doc replicas, keyed by namespace id — one per channel this instance
    /// serves (as author) or follows (as subscriber). The native counterpart of
    /// pin-core's `Engine.channels`, and it exists for the same reason: iroh-docs'
    /// read capability is whole-namespace, so a channel can't be an entry in the
    /// identity doc without exposing every other channel key and the settings
    /// ciphertext to whoever holds it. One doc per channel matches per-channel `K`.
    ///
    /// A `Doc` is cloned out under the lock and the lock released before any await —
    /// never held across one.
    channels: Mutex<HashMap<String, Doc>>,
    /// Whether the doc-change pump is already running (see `subscribe_changes`).
    /// One pump per engine: a second would double every change, and the frontend
    /// that subscribes is the kind of caller that remounts.
    changes_subscribed: AtomicBool,
    /// Whether the pull loop has been started on this engine. One per engine — a
    /// second would double every pass's network work for nothing.
    pull_started: AtomicBool,
    /// Same, for the locator keep-alive loop.
    keep_alive_started: AtomicBool,
    repack_started: AtomicBool,
    /// Same, for the instance-registration loop.
    instance_started: AtomicBool,
    /// Same, for the identity-publishing loop.
    identity_started: AtomicBool,
    /// Channel-doc serve loop guard (see `curator_start_channel_docs`).
    channel_doc_started: AtomicBool,
    /// Channel live-sync loop guard (see `curator_start_channel_sync`).
    channel_sync_started: AtomicBool,
    /// Doc-to-Sia snapshot loop guard (see `curator_start_snapshot`).
    snapshot_started: AtomicBool,
    /// Instance rendezvous loop guard (see `curator_start_rendezvous`).
    rendezvous_started: AtomicBool,
}

/// Bring up (or reopen) the Curator's persistent iroh-docs engine on `endpoint`,
/// under a namespace + author derived from the Sia AppKey. Stores live on disk under
/// `<data_dir>/docs` (`blobs.db`, `docs.redb`, `default-author`). Writes the marker
/// entry on first creation; finding it on a later run is what proves persistence.
pub async fn open_or_create(
    endpoint: &Endpoint,
    data_dir: &Path,
    app_key_hex: &str,
) -> Result<DocEngine, String> {
    let app_key = decode_app_key(app_key_hex).ok_or("app key hex must be 32 bytes")?;
    let ns_seed = hkdf32(&app_key, NS_INFO);
    let author_seed = hkdf32(&app_key, AUTHOR_INFO);

    let dir = data_dir.join("docs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create docs dir: {e}"))?;

    // Persistent stack on the Curator's endpoint: fs blobs store + redb-backed docs
    // replica + gossip. `(*blobs).clone()` hands `spawn` the blobs `Store` (FsStore
    // derefs to it); `gossip.clone()` because gossip is also mounted on the Router.
    let gossip = Gossip::builder().spawn(endpoint.clone());
    let blobs = FsStore::load(&dir)
        .await
        .map_err(|e| format!("blobs store load: {e}"))?;
    let docs = Docs::persistent(dir.clone())
        .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
        .await
        .map_err(|e| format!("docs spawn: {e}"))?;

    // Deterministic author + namespace from the recovery-phrase-derived AppKey.
    let author = Author::from_bytes(&author_seed);
    let author_id = author.id();
    docs.author_import(author)
        .await
        .map_err(|e| format!("author import: {e}"))?;
    let ns = NamespaceSecret::from_bytes(&ns_seed);
    let namespace_id = ns.id().to_string();
    // import_namespace attaches to the persisted replica if it already exists in
    // redb, or creates it fresh — either way the entries persisted last run are here.
    let doc = docs
        .import_namespace(Capability::Write(ns))
        .await
        .map_err(|e| format!("import namespace: {e}"))?;

    // Marker present → the doc persisted across a restart. Absent → first run, so
    // write it now (so the next run reopens).
    let existing = doc
        .get_exact(author_id, MARKER_KEY, false)
        .await
        .map_err(|e| format!("get marker: {e}"))?;
    let reopened = existing.is_some();
    if !reopened {
        doc.set_bytes(
            author_id,
            MARKER_KEY.to_vec(),
            b"curator doc online".to_vec(),
        )
        .await
        .map_err(|e| format!("set marker: {e}"))?;
    }

    Ok(DocEngine {
        doc,
        docs,
        blobs,
        gossip,
        author_id,
        namespace_id,
        node_id: endpoint.id().to_string(),
        reopened,
        channels: Mutex::new(HashMap::new()),
        changes_subscribed: AtomicBool::new(false),
        pull_started: AtomicBool::new(false),
        keep_alive_started: AtomicBool::new(false),
        repack_started: AtomicBool::new(false),
        instance_started: AtomicBool::new(false),
        identity_started: AtomicBool::new(false),
        channel_doc_started: AtomicBool::new(false),
        channel_sync_started: AtomicBool::new(false),
        snapshot_started: AtomicBool::new(false),
        rendezvous_started: AtomicBool::new(false),
    })
}

// --- Channel docs (native half of pin-core's channel-doc surface) -------------
//
// The ladder's top rung: a subscriber holds a live replica of a channel's own doc and
// is pushed updates, instead of polling the channel's pkarr locator and re-fetching
// its manifest from Sia.
//
// Capability shape (settled + probe-verified 2026-07-28): the author holds the WRITE
// capability, from a seed only they can compute; subscribers get a `ShareMode::Read`
// ticket published to a `K`-derived pkarr record. A namespace secret IS the write
// capability, so deriving the namespace from `K` — simpler — would let every
// subscriber write to the author's doc. The read ticket also carries node id + relay
// address, so it answers "where do I dial" in the same field.
//
// These MUST behave identically to pin-core's `*_channel_*` exports: same record key
// shape (`pin_derive::record_key`), same opaque byte values, same read semantics.
// Desktop and web sync the SAME channel docs, so a divergence here is a data bug.
impl DocEngine {
    /// Look up an open channel replica. Clones the `Doc` out so the lock is never held
    /// across an await.
    fn channel(&self, ns_id: &str) -> Result<Doc, String> {
        self.channels
            .lock()
            .unwrap()
            .get(ns_id)
            .cloned()
            .ok_or_else(|| format!("channel doc {ns_id} is not open"))
    }

    /// Author side: open (or reopen) the write replica of a channel's doc from its
    /// 32-byte namespace seed, returning the namespace id. Idempotent — opening the
    /// same channel twice reuses the replica.
    ///
    /// The seed arrives already derived (by the app, from the AppKey + channelID)
    /// rather than being computed here from a `pin-derive` `info`: one implementation
    /// computes it for both engines, so there are no two copies to drift.
    pub async fn open_channel(&self, ns_seed_hex: &str) -> Result<String, String> {
        let seed =
            decode_hex32(ns_seed_hex).ok_or("channel namespace seed must be 32 bytes hex")?;
        let ns = NamespaceSecret::from_bytes(&seed);
        let ns_id = ns.id().to_string();
        if self.channels.lock().unwrap().contains_key(&ns_id) {
            return Ok(ns_id);
        }
        let doc = self
            .docs
            .import_namespace(Capability::Write(ns))
            .await
            .map_err(|e| format!("import channel namespace: {e}"))?;
        self.channels.lock().unwrap().insert(ns_id.clone(), doc);
        Ok(ns_id)
    }

    /// Author side: mint a READ-mode ticket for a channel doc — the capability a
    /// subscriber imports, which can never write. Call this while the endpoint is
    /// ONLINE: `share` freezes whatever addresses are known right now, and a ticket
    /// with no relay URL is undialable from a browser (which has no discovery).
    pub async fn share_channel(&self, ns_id: &str) -> Result<String, String> {
        let doc = self.channel(ns_id)?;
        let ticket = doc
            .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
            .await
            .map_err(|e| format!("share channel doc: {e}"))?;
        Ok(ticket.to_string())
    }

    /// Write a record into a channel doc (author side; a read replica rejects it).
    pub async fn put_channel_record(
        &self,
        ns_id: &str,
        collection: &str,
        rkey: &str,
        value: Vec<u8>,
    ) -> Result<(), String> {
        let doc = self.channel(ns_id)?;
        doc.set_bytes(self.author_id, record_key(collection, rkey), value)
            .await
            .map_err(|e| format!("set_bytes: {e}"))?;
        Ok(())
    }

    /// Read a record from a channel doc, or `None` if absent.
    ///
    /// Author-AGNOSTIC (`single_latest_per_key`, no author filter), deliberately: on
    /// the subscriber side the entry was written by the channel owner, whose
    /// `AuthorId` we don't hold and would otherwise have to publish. Safe because the
    /// capability is read-only for everyone but the owner, so any entry at this key is
    /// theirs. Matches pin-core's `get_channel_record` exactly.
    pub async fn get_channel_record(
        &self,
        ns_id: &str,
        collection: &str,
        rkey: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        let doc = self.channel(ns_id)?;
        let entry = doc
            .get_one(
                Query::single_latest_per_key()
                    .key_exact(record_key(collection, rkey))
                    .build(),
            )
            .await
            .map_err(|e| format!("get_one: {e}"))?;
        match entry {
            None => Ok(None),
            Some(e) => {
                let bytes = self
                    .blobs
                    .get_bytes(e.content_hash())
                    .await
                    .map_err(|e| format!("get_bytes: {e}"))?;
                Ok(Some(bytes.to_vec()))
            }
        }
    }

    /// Delete a record from a channel doc (author side).
    pub async fn delete_channel_record(
        &self,
        ns_id: &str,
        collection: &str,
        rkey: &str,
    ) -> Result<(), String> {
        let doc = self.channel(ns_id)?;
        doc.del(self.author_id, record_key(collection, rkey))
            .await
            .map_err(|e| format!("del: {e}"))?;
        Ok(())
    }

    /// Subscriber side: import a channel's read ticket and live-sync it, returning the
    /// namespace id. `on_event(ns_id, kind, key)` fires per `LiveEvent` — the caller
    /// forwards it to the frontend (a Tauri event), matching what pin-core hands its
    /// JS callback. Kinds come from `pin_derive`'s `EV_*` so both engines speak one
    /// vocabulary.
    ///
    /// Uses `import_and_subscribe`, which subscribes BEFORE starting sync, so the
    /// first reconciliation's events can't be missed — that initial catch-up is
    /// exactly the one worth seeing.
    pub async fn import_channel<F>(&self, ticket: &str, on_event: F) -> Result<String, String>
    where
        F: Fn(&str, &str, &str) + Send + 'static,
    {
        let ticket = DocTicket::from_str(ticket).map_err(|e| format!("bad ticket: {e}"))?;
        let (doc, events) = self
            .docs
            .import_and_subscribe(ticket)
            .await
            .map_err(|e| format!("import channel doc: {e}"))?;
        let ns_id = doc.id().to_string();
        self.channels.lock().unwrap().insert(ns_id.clone(), doc);

        // The pump outlives this call and ends when the doc's stream closes (engine
        // shutdown). Spawned on whatever runtime the caller is on — the Doc handle's
        // ops are channel sends, so crossing runtimes is fine.
        let ns_for_events = ns_id.clone();
        tokio::spawn(async move {
            let mut events = Box::pin(events);
            while let Some(res) = events.next().await {
                let (kind, key) = match &res {
                    Ok(ev) => live_event_parts(ev),
                    Err(e) => (EV_ERROR, e.to_string()),
                };
                on_event(&ns_for_events, kind, &key);
            }
        });
        Ok(ns_id)
    }

    /// Claim the right to start the pull loop. True if it was already claimed, so a
    /// caller that sees true should do nothing.
    pub fn pull_started(&self) -> bool {
        self.pull_started.swap(true, Ordering::SeqCst)
    }

    /// Whether the keep-alive loop was already running; marks it started either way.
    pub fn repack_started(&self) -> bool {
        self.repack_started.swap(true, Ordering::SeqCst)
    }

    pub fn keep_alive_started(&self) -> bool {
        self.keep_alive_started.swap(true, Ordering::SeqCst)
    }

    /// Whether the channel-doc serve loop was already running; marks it started.
    pub fn channel_doc_started(&self) -> bool {
        self.channel_doc_started.swap(true, Ordering::SeqCst)
    }

    /// Whether the channel live-sync loop was already running; marks it started.
    pub fn channel_sync_started(&self) -> bool {
        self.channel_sync_started.swap(true, Ordering::SeqCst)
    }

    /// Whether the doc-to-Sia snapshot loop was already running; marks it started.
    pub fn snapshot_started(&self) -> bool {
        self.snapshot_started.swap(true, Ordering::SeqCst)
    }

    /// Whether the instance rendezvous loop was already running; marks it started.
    pub fn rendezvous_started(&self) -> bool {
        self.rendezvous_started.swap(true, Ordering::SeqCst)
    }

    /// Whether the instance-registration loop was already running; marks it started.
    pub fn instance_started(&self) -> bool {
        self.instance_started.swap(true, Ordering::SeqCst)
    }

    /// Whether the identity-publishing loop was already running; marks it started.
    pub fn identity_started(&self) -> bool {
        self.identity_started.swap(true, Ordering::SeqCst)
    }

    /// The namespace ids of every channel doc currently open.
    pub fn channel_namespaces(&self) -> Vec<String> {
        self.channels.lock().unwrap().keys().cloned().collect()
    }

    /// Report every change to the Curator's own doc as `(collection, rkey, kind)` —
    /// the repo's change feed, and the mirror of pin-core's `subscribe_doc_changes`.
    /// See that function for the contract (faithful, not filtered; stream-level
    /// events carry empty strings; `pin_derive::parse_record_key` does the split on
    /// both sides).
    ///
    /// This is how the frontend learns about work the Curator did on its own —
    /// which, once the Curator runs the loops, is most of what changes.
    ///
    /// One pump per engine; a second call is a no-op. Ends when the doc's stream
    /// closes (engine shutdown).
    pub async fn subscribe_changes<F>(&self, on_change: F) -> Result<(), String>
    where
        F: Fn(&str, &str, &str) + Send + 'static,
    {
        if self.changes_subscribed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let mut events = self
            .doc
            .subscribe()
            .await
            .map_err(|e| format!("subscribe doc: {e}"))?;
        tokio::spawn(async move {
            while let Some(res) = events.next().await {
                let (kind, key) = match &res {
                    Ok(ev) => live_event_parts(ev),
                    Err(e) => (EV_ERROR, e.to_string()),
                };
                let (collection, rkey) = parse_record_key(&key).unwrap_or(("", ""));
                on_change(collection, rkey, kind);
            }
        });
        Ok(())
    }
}

/// Split a `LiveEvent` into its shared `kind` (`pin_derive`'s `EV_*`) and the entry key
/// it concerns, empty when the event isn't about one entry. The mirror of pin-core's
/// `live_event_parts` — the constants are shared so the two can't spell a kind
/// differently, which would silently break live updates on one platform.
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
