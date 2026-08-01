//! Pin's Sia layer: connect, byte I/O, and the pinned-objects walk.
//!
//! See Cargo.toml for why this is one crate rather than two implementations. The
//! short version: `sia_storage` already handles the per-target transport, so nothing
//! here branches on target; what this removes is a hand-maintained duplication
//! between the TypeScript client and the desktop backend, and it gives the connect
//! typestate a home outside React.
//!
//! Everything is coarse and handle-free — plain data in, plain data out. A live
//! `Object` never leaves a method, because the desktop's copy of this surface has to
//! survive an IPC hop where handles cannot travel. That constraint is what let the
//! metering / repack / reset / slab-inspector sites collapse onto plain descriptors.

use std::io::Cursor;
use std::sync::Arc;

use sia_storage::{
    app_id, AppKey, AppMetadata, ApprovedState, Builder, DateTime, DownloadOptions, Hash256,
    Object, ObjectEvent, ObjectsCursor, RequestingApprovalState, Sdk, Slab, UploadOptions, Utc,
};
use tokio::sync::Mutex;

/// Recovery-phrase helpers, re-exported so callers need not depend on `sia_storage`
/// directly. These are pure — no session, no network.
pub use sia_storage::{generate_recovery_phrase, validate_recovery_phrase};

/// The public key for an AppKey, rendered the way Sia renders it (`ed25519:<hex>`).
///
/// Pure, so a caller can have it before connecting — which matters because the app
/// stamps it into every channel manifest it publishes as `authorPubkey`, and the
/// accessor that reads it is synchronous.
pub fn public_key(app_key: &[u8; 32]) -> String {
    AppKey::import(*app_key).public_key().to_string()
}

/// Must match the frontend's `APP_META` (src/lib.rs constants) exactly. The AppID
/// derives the object-encryption scope, so a mismatch silently reads and writes a
/// DIFFERENT scope rather than failing — which is why it is pinned here as the one
/// definition both targets compile against.
fn app_meta() -> AppMetadata {
    AppMetadata {
        id: app_id!("f6b7539e181e45ee750a491a58aa8392830a17c402115cf47c6e7dfe9f7ffcb0"),
        name: "Pin",
        description: "A Sia storage app",
        service_url: "https://sia.storage",
        logo_url: None,
        callback_url: None,
    }
}

/// Year-9999, which makes an item's share URL effectively permanent. Verified as
/// accepted by the indexer in the project's day-0 probe, and mirrored from the
/// TypeScript `FAR_FUTURE`.
fn far_future() -> DateTime<Utc> {
    "9999-12-31T00:00:00Z".parse().expect("valid timestamp")
}

/// Fired once per uploaded shard, so a caller can drive a progress bar.
///
/// Nullary on purpose: the app only ever counts shards, and keeping the SDK's
/// `ShardProgress` out of the signature means neither binding layer has to depend on
/// `sia_storage` just to pass a callback through. The `Send + Sync` bound is present
/// natively and absent on wasm, matching what the SDK itself requires per target.
#[cfg(not(target_arch = "wasm32"))]
pub type ShardCallback = Arc<dyn Fn() + Send + Sync + 'static>;
#[cfg(target_arch = "wasm32")]
pub type ShardCallback = Arc<dyn Fn() + 'static>;

fn upload_options(on_shard: Option<ShardCallback>) -> UploadOptions {
    match on_shard {
        Some(cb) => UploadOptions::default().on_shard_uploaded(move |_| cb()),
        None => UploadOptions::default(),
    }
}

/// Run an SDK future somewhere it is allowed to spawn.
///
/// `sia_storage` spawns background work — the periodic host refresh, connection
/// pre-warming — and on wasm it does so with `tokio::task::spawn_local`, which
/// PANICS outside a `LocalSet`. A panic inside a future driven by
/// `wasm_bindgen_futures` doesn't reject the JS promise, it leaves it pending
/// forever, so the symptom is a hang rather than an error. Every call that can reach
/// `Sdk::new` or an upload has to go through here.
///
/// Natively there is a real runtime with a real `spawn`, so this is just the future.
#[cfg(target_arch = "wasm32")]
async fn drive<F: std::future::Future>(fut: F) -> F::Output {
    // Scoped to the call: work spawned inside stops when it returns. That costs the
    // 10-minute host-refresh loop its continuity — hosts are still fetched up front
    // by `Sdk::new`, so a session starts correct and only goes stale — and it costs
    // connection pre-warming, which is an optimization. Both are worth more than a
    // hang, and a longer-lived home for them wants a driver this layer doesn't have.
    tokio::task::LocalSet::new().run_until(fut).await
}

#[cfg(not(target_arch = "wasm32"))]
async fn drive<F: std::future::Future>(fut: F) -> F::Output {
    fut.await
}

// --- plain descriptors --------------------------------------------------------
//
// serde `camelCase` so these deserialize straight into the shapes the frontend
// already reads, whether they arrive over wasm-bindgen or over Tauri IPC.

/// One uploaded object.
///
/// `content_hash` is a CIDv1 of the PLAINTEXT (see `pin_crypto::content_hash`), which
/// is not really a Sia concept — but this is the one place that holds the plaintext,
/// and stamping it here is what lets both hops report it from a single implementation.
/// It used to be added by each caller instead, and the two callers promptly diverged:
/// the desktop client hashed the bytes in TypeScript while the browser client did not,
/// so the same bytes carried a cache key on one platform and none on the other.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uploaded {
    pub id: String,
    /// Named explicitly because `camelCase` would emit `itemUrl`, and the frontend
    /// spells acronyms in full (`itemURL`). Serde's rename_all only knows word
    /// boundaries, not which words are acronyms, so any field ending in one has to say
    /// so — the alternative is each caller re-mapping the name, which is how the
    /// browser came to read `itemURL` off a payload that carried `itemUrl`.
    #[serde(rename = "itemURL")]
    pub item_url: String,
    pub byte_size: u64,
    pub content_hash: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    pub pinned_data: u64,
    pub pinned_size: u64,
    /// Actual content bytes across every pinned object in this AppKey's scope,
    /// summed from slab lengths. This is what the storage meter shows, because
    /// `pinned_data` counts whole 40 MiB slab allocations and so overstates what the
    /// user would recognise as "what I am storing".
    pub raw_content_bytes: u64,
    pub max_pinned_data: u64,
    pub remaining_storage: u64,
    pub fetched_at: String,
}

/// A pinned object reduced to the plain data its consumers actually read.
///
/// `slabs` reuses the SDK's own `Slab`, whose serde already produces byte-for-byte
/// the TypeScript `Slab` interface, so repack and the slab inspector read it
/// unchanged.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedObjectInfo {
    pub id: String,
    /// ISO 8601.
    pub created_at: String,
    pub slabs: Vec<Slab>,
}

// --- the pinned-objects walk --------------------------------------------------

const EVENTS_PAGE_LIMIT: usize = 200;
/// Defensive cap — 200 x 50 = 10000 events covers any plausible scope.
const EVENTS_MAX_PAGES: usize = 50;

/// One current (non-deleted) object, owned so it outlives the event that carried it.
struct CurrentObject {
    id: String,
    created_at: DateTime<Utc>,
    slabs: Vec<Slab>,
}

/// Page through `object_events`, keep the latest event per id, drop the deleted ones.
///
/// This is the single home for the walk that the storage meter, the repack scope, the
/// full-reset enumeration and the slab inspector all need. It is a walk rather than a
/// listing because the indexer exposes the scope as an event log; "what do I currently
/// have" is a fold over it.
async fn walk_current(sdk: &Sdk) -> Result<Vec<CurrentObject>, String> {
    use std::collections::HashMap;

    let mut latest: HashMap<String, ObjectEvent> = HashMap::new();
    let mut cursor: Option<ObjectsCursor> = None;

    for _ in 0..EVENTS_MAX_PAGES {
        let events = sdk
            .object_events(cursor.take(), Some(EVENTS_PAGE_LIMIT))
            .await
            .map_err(|e| format!("object_events: {e}"))?;
        let n = events.len();
        if n == 0 {
            break;
        }
        let last_after = events[n - 1].updated_at;
        let last_id = events[n - 1].id.clone();
        for ev in events {
            let key = ev.id.to_string();
            match latest.get(&key) {
                Some(prev) if prev.updated_at >= ev.updated_at => {}
                _ => {
                    latest.insert(key, ev);
                }
            }
        }
        // A short page is the last page.
        if n < EVENTS_PAGE_LIMIT {
            break;
        }
        cursor = Some(ObjectsCursor {
            after: last_after,
            id: last_id,
        });
    }

    let mut out = Vec::new();
    for ev in latest.into_values() {
        if ev.deleted {
            continue;
        }
        if let Some(obj) = ev.object {
            out.push(CurrentObject {
                id: ev.id.to_string(),
                created_at: *obj.created_at(),
                slabs: obj.slabs().to_vec(),
            });
        }
    }
    Ok(out)
}

// --- session ------------------------------------------------------------------

/// The connect flow's in-progress builder.
///
/// `Builder` is a typestate: `request_connection`, `wait_for_approval` and `register`
/// each CONSUME `self` and return the next state. So a transition cannot borrow the
/// slot — it has to take the value out, consume it, and put the successor back. That
/// is also why a failed transition leaves the slot empty: the builder was moved into
/// the call and is gone. Restarting from `request_connection` is the only recovery,
/// which is a real behavioural difference from the JS SDK's builder.
enum Pending {
    AwaitingApproval(Builder<RequestingApprovalState>),
    Approved(Builder<ApprovedState>),
}

/// Holds the connect flow's progress and, once registered or restored, the `Sdk`.
///
/// Both binding layers own exactly one of these. Deliberately runtime-agnostic: every
/// method is a plain `async fn`, so the caller decides how it is driven — the desktop
/// dispatches onto a dedicated multi-thread runtime with the full driver set, while
/// the browser awaits on the event loop.
pub struct Session {
    pending: Mutex<Option<Pending>>,
    sdk: Mutex<Option<Arc<Sdk>>>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Session {
            pending: Mutex::new(None),
            sdk: Mutex::new(None),
        }
    }

    /// The connected `Sdk`, or an error naming the reason rather than panicking —
    /// every I/O op below funnels through here.
    ///
    /// Clones the `Arc` and releases the lock immediately, so no guard is ever held
    /// across the network await that follows.
    async fn sdk(&self) -> Result<Arc<Sdk>, String> {
        self.sdk
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Sia is not connected".to_string())
    }

    pub async fn is_connected(&self) -> bool {
        self.sdk.lock().await.is_some()
    }

    /// Hex of the connected AppKey — what the app persists to restore this session,
    /// and what it hands to the other derivations as the one root secret.
    pub async fn app_key_hex(&self) -> Option<String> {
        let sdk = self.sdk.lock().await.clone()?;
        Some(pin_derive::encode_hex32(&sdk.app_key().export()))
    }

    // -- connect flow ----------------------------------------------------------

    /// Restore a session from a previously stored AppKey.
    ///
    /// `Ok(false)` means the indexer does not recognise the key — a normal outcome
    /// (approval was revoked, or the account was never registered), distinct from
    /// `Err`, which means the attempt itself failed. The caller sends the user back
    /// to the welcome screen either way, but only one of the two is worth reporting.
    pub async fn connect(&self, app_key_hex: &str, indexer_url: &str) -> Result<bool, String> {
        let bytes = pin_derive::decode_hex32(app_key_hex)
            .ok_or("app key must be 32-byte hex (64 chars)")?;
        let app_key = AppKey::import(bytes);
        let builder = Builder::new(indexer_url, app_meta()).map_err(|e| format!("builder: {e}"))?;
        match drive(builder.connected(&app_key))
            .await
            .map_err(|e| format!("connect: {e}"))?
        {
            Some(sdk) => {
                *self.sdk.lock().await = Some(Arc::new(sdk));
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Begin a new connection and return the URL the user must approve at.
    ///
    /// Overwrites any connect flow already in progress, so re-entering the welcome
    /// screen starts cleanly rather than inheriting a stale, possibly expired request.
    pub async fn request_connection(&self, indexer_url: &str) -> Result<String, String> {
        let builder = Builder::new(indexer_url, app_meta()).map_err(|e| format!("builder: {e}"))?;
        let builder = drive(builder.request_connection())
            .await
            .map_err(|e| format!("request connection: {e}"))?;
        let url = builder.response_url().to_string();
        *self.pending.lock().await = Some(Pending::AwaitingApproval(builder));
        Ok(url)
    }

    /// Block until the user approves at the indexer.
    ///
    /// This polls internally until approval or expiry, so it is one long call rather
    /// than something to re-drive from a timer. Already-approved is a no-op, which
    /// makes it safe against a double-invoke (React strict mode mounts effects twice).
    pub async fn wait_for_approval(&self) -> Result<(), String> {
        let pending = self.pending.lock().await.take();
        match pending {
            Some(Pending::AwaitingApproval(builder)) => {
                let approved = drive(builder.wait_for_approval())
                    .await
                    .map_err(|e| format!("approval: {e}"))?;
                *self.pending.lock().await = Some(Pending::Approved(approved));
                Ok(())
            }
            // Idempotent: put it back untouched.
            Some(already @ Pending::Approved(_)) => {
                *self.pending.lock().await = Some(already);
                Ok(())
            }
            None => Err("no connection request in progress".to_string()),
        }
    }

    /// Finish registration with the user's recovery phrase and hold the resulting
    /// `Sdk`. Returns the AppKey hex for the caller to persist.
    ///
    /// The phrase is validated first so an obvious typo fails locally, before the
    /// approved builder is consumed and made unrecoverable.
    pub async fn register(&self, mnemonic: &str) -> Result<String, String> {
        validate_recovery_phrase(mnemonic).map_err(|e| format!("recovery phrase: {e}"))?;

        let pending = self.pending.lock().await.take();
        let builder = match pending {
            Some(Pending::Approved(builder)) => builder,
            Some(waiting @ Pending::AwaitingApproval(_)) => {
                *self.pending.lock().await = Some(waiting);
                return Err("connection has not been approved yet".to_string());
            }
            None => return Err("no approved connection to register".to_string()),
        };

        let sdk = drive(builder.register(mnemonic))
            .await
            .map_err(|e| format!("register: {e}"))?;
        let key_hex = pin_derive::encode_hex32(&sdk.app_key().export());
        *self.sdk.lock().await = Some(Arc::new(sdk));
        Ok(key_hex)
    }

    // -- byte I/O --------------------------------------------------------------

    pub async fn upload_item(
        &self,
        bytes: Vec<u8>,
        on_shard: Option<ShardCallback>,
    ) -> Result<Uploaded, String> {
        let sdk = self.sdk().await?;
        drive(async move {
            let byte_size = bytes.len() as u64;
            // Before the bytes are moved into the upload cursor.
            let content_hash = pin_crypto::content_hash(&bytes);
            let obj = sdk
                .upload(
                    Object::default(),
                    Cursor::new(bytes),
                    upload_options(on_shard),
                )
                .await
                .map_err(|e| format!("upload: {e}"))?;
            sdk.pin_object(&obj)
                .await
                .map_err(|e| format!("pin: {e}"))?;
            Ok(Uploaded {
                id: obj.id().to_string(),
                item_url: sdk
                    .share_object(&obj, far_future())
                    .map_err(|e| format!("share: {e}"))?
                    .to_string(),
                byte_size,
                content_hash,
            })
        })
        .await
    }

    /// Bin-pack several objects into shared slabs.
    ///
    /// Each input still gets its own object and share URL, so callers can address them
    /// independently; they merely share slab capacity. That matters because a slab is
    /// allocated whole, so a post plus three small attachments would otherwise burn
    /// four of them. Results come back in input order.
    pub async fn upload_items_packed(
        &self,
        items: Vec<Vec<u8>>,
        on_shard: Option<ShardCallback>,
    ) -> Result<Vec<Uploaded>, String> {
        let sdk = self.sdk().await?;
        drive(async move {
            // Both taken before the buffers are moved into the packed upload, and
            // both indexed by input position — `finalize` preserves input order.
            let sizes: Vec<u64> = items.iter().map(|b| b.len() as u64).collect();
            let hashes: Vec<String> = items.iter().map(|b| pin_crypto::content_hash(b)).collect();

            let mut packed = sdk
                .upload_packed(upload_options(on_shard))
                .map_err(|e| format!("packed upload: {e}"))?;
            for bytes in items {
                packed
                    .add(Cursor::new(bytes))
                    .await
                    .map_err(|e| format!("packed add: {e}"))?;
            }
            let objects = packed
                .finalize()
                .await
                .map_err(|e| format!("packed finalize: {e}"))?;

            let mut out = Vec::with_capacity(objects.len());
            for (i, obj) in objects.iter().enumerate() {
                sdk.pin_object(obj).await.map_err(|e| format!("pin: {e}"))?;
                out.push(Uploaded {
                    id: obj.id().to_string(),
                    item_url: sdk
                        .share_object(obj, far_future())
                        .map_err(|e| format!("share: {e}"))?
                        .to_string(),
                    byte_size: sizes.get(i).copied().unwrap_or(0),
                    content_hash: hashes.get(i).cloned().unwrap_or_default(),
                });
            }
            Ok(out)
        })
        .await
    }

    /// Read a share URL's bytes in full.
    ///
    /// Drains via `read_chunk` rather than an `AsyncRead` adapter, which keeps this
    /// free of a tokio io dependency and so identical on both targets. This is also
    /// the path that fails outright under the browser SDK inside WebView2 ("readable
    /// byte streams not supported") — running it here is what fixes that.
    pub async fn download_item(&self, url: &str) -> Result<Vec<u8>, String> {
        let sdk = self.sdk().await?;
        drive(async move {
            let obj = sdk
                .shared_object(url)
                .await
                .map_err(|e| format!("shared_object: {e}"))?;
            let mut download = sdk
                .download(&obj, DownloadOptions::default())
                .map_err(|e| format!("download start: {e}"))?;
            let mut out = Vec::new();
            loop {
                let chunk = download
                    .read_chunk()
                    .await
                    .map_err(|e| format!("download read: {e}"))?;
                if chunk.is_empty() {
                    break;
                }
                out.extend_from_slice(&chunk);
            }
            Ok(out)
        })
        .await
    }

    // -- custody ---------------------------------------------------------------

    /// Mirror a share URL's bytes into this scope, returning the object id.
    pub async fn pin_from_share_url(&self, url: &str) -> Result<String, String> {
        let sdk = self.sdk().await?;
        drive(async move {
            let obj = sdk
                .shared_object(url)
                .await
                .map_err(|e| format!("shared_object: {e}"))?;
            sdk.pin_object(&obj)
                .await
                .map_err(|e| format!("pin: {e}"))?;
            Ok(obj.id().to_string())
        })
        .await
    }

    /// Resolve a share URL to its object id without taking custody.
    pub async fn resolve_object_id(&self, url: &str) -> Result<String, String> {
        let sdk = self.sdk().await?;
        drive(async move {
            let obj = sdk
                .shared_object(url)
                .await
                .map_err(|e| format!("shared_object: {e}"))?;
            Ok(obj.id().to_string())
        })
        .await
    }

    pub async fn delete_object(&self, id: &str) -> Result<(), String> {
        let hash: Hash256 = id.parse().map_err(|e| format!("bad object id: {e:?}"))?;
        let sdk = self.sdk().await?;
        drive(async move {
            sdk.delete_object(&hash)
                .await
                .map_err(|e| format!("delete: {e}"))
        })
        .await
    }

    /// Release slabs left empty by deletes. The indexer does not drop them on its
    /// own, so without this a delete frees nothing the user can see.
    pub async fn prune_slabs(&self) -> Result<(), String> {
        let sdk = self.sdk().await?;
        drive(async move { sdk.prune_slabs().await.map_err(|e| format!("prune: {e}")) }).await
    }

    // -- accounting ------------------------------------------------------------

    pub async fn account_snapshot(&self) -> Result<AccountSnapshot, String> {
        let sdk = self.sdk().await?;
        drive(async move {
            let account = sdk.account().await.map_err(|e| format!("account: {e}"))?;
            let objects = walk_current(&sdk).await?;
            let raw_content_bytes = objects
                .iter()
                .flat_map(|o| o.slabs.iter())
                .map(|s| s.length as u64)
                .sum();
            Ok(AccountSnapshot {
                pinned_data: account.pinned_data,
                pinned_size: account.pinned_size,
                raw_content_bytes,
                max_pinned_data: account.max_pinned_data,
                remaining_storage: account.remaining_storage,
                fetched_at: Utc::now().to_rfc3339(),
            })
        })
        .await
    }

    pub async fn list_pinned_objects(&self) -> Result<Vec<PinnedObjectInfo>, String> {
        let sdk = self.sdk().await?;
        drive(async move {
            Ok(walk_current(&sdk)
                .await?
                .into_iter()
                .map(|o| PinnedObjectInfo {
                    id: o.id,
                    created_at: o.created_at.to_rfc3339(),
                    slabs: o.slabs,
                })
                .collect())
        })
        .await
    }

    /// One object's slabs by id. `None` when it is not in scope — a normal answer
    /// (repack asks about references that may already be gone), not an error.
    pub async fn get_object_slabs(&self, id: &str) -> Result<Option<PinnedObjectInfo>, String> {
        let hash: Hash256 = id.parse().map_err(|e| format!("bad object id: {e:?}"))?;
        let sdk = self.sdk().await?;
        drive(async move {
            Ok(sdk.object(&hash).await.ok().map(|obj| PinnedObjectInfo {
                id: hash.to_string(),
                created_at: obj.created_at().to_rfc3339(),
                slabs: obj.slabs().to_vec(),
            }))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // A bare executor rather than a tokio runtime: none of these reach the network, and
    // `tokio::sync::Mutex` is runtime-agnostic, so there is nothing here that needs a
    // reactor. Keeps the dev-dependency to one tiny crate already in the tree.
    use futures_lite::future::block_on;

    // The AppID derives the object-encryption scope, so changing it silently moves
    // every user's data instead of failing loudly. Pin it to the frontend's APP_KEY.
    #[test]
    fn app_id_matches_the_frontend() {
        assert_eq!(
            app_meta().id.to_string(),
            "f6b7539e181e45ee750a491a58aa8392830a17c402115cf47c6e7dfe9f7ffcb0"
        );
    }

    #[test]
    fn share_horizon_is_effectively_permanent() {
        assert_eq!(far_future().to_rfc3339(), "9999-12-31T00:00:00+00:00");
    }

    // These descriptors ARE the wire format on both hops, and the frontend consumes
    // them by deserializing straight into its own types — so a field name is as
    // load-bearing as a field value, and getting one wrong is invisible to both
    // compilers. It is how the browser came to read an undefined `itemURL` off a
    // payload that spelled it `itemUrl`: TypeScript cannot see through `JSON.parse`,
    // and Rust has no idea what the other side expects to find.
    //
    // So: assert the exact key set. If a field is renamed or added, this fails here
    // rather than surfacing as a manifest full of undefined URLs.
    #[test]
    fn descriptor_field_names_match_what_the_frontend_reads() {
        let keys = |v: serde_json::Value| {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };

        let uploaded = serde_json::to_value(Uploaded {
            id: "id".into(),
            item_url: "url".into(),
            byte_size: 1,
            content_hash: "b".into(),
        })
        .unwrap();
        // itemURL, not itemUrl — see the field's own note.
        assert_eq!(keys(uploaded), ["byteSize", "contentHash", "id", "itemURL"]);

        let snapshot = serde_json::to_value(AccountSnapshot {
            pinned_data: 1,
            pinned_size: 2,
            raw_content_bytes: 3,
            max_pinned_data: 4,
            remaining_storage: 5,
            fetched_at: "t".into(),
        })
        .unwrap();
        assert_eq!(
            keys(snapshot),
            [
                "fetchedAt",
                "maxPinnedData",
                "pinnedData",
                "pinnedSize",
                "rawContentBytes",
                "remainingStorage",
            ]
        );

        let object = serde_json::to_value(PinnedObjectInfo {
            id: "id".into(),
            created_at: "t".into(),
            slabs: vec![],
        })
        .unwrap();
        assert_eq!(keys(object), ["createdAt", "id", "slabs"]);
    }

    #[test]
    fn io_before_connect_reports_rather_than_panics() {
        block_on(async {
            let session = Session::new();
            assert!(!session.is_connected().await);
            assert!(session.app_key_hex().await.is_none());
            assert_eq!(
                session.download_item("sia://whatever").await.unwrap_err(),
                "Sia is not connected"
            );
        });
    }

    #[test]
    fn connect_rejects_a_malformed_app_key_before_any_network_call() {
        block_on(async {
            let session = Session::new();
            let err = session
                .connect("not-hex", "https://sia.storage")
                .await
                .unwrap_err();
            assert!(err.contains("32-byte hex"), "unexpected: {err}");
        });
    }

    // The typestate makes an out-of-order call unrepresentable at the type level; the
    // session turns that into a reported error rather than a panic when the frontend
    // drives the screens out of sequence.
    #[test]
    fn approval_and_registration_require_a_request_first() {
        block_on(async {
            let session = Session::new();
            assert_eq!(
                session.wait_for_approval().await.unwrap_err(),
                "no connection request in progress"
            );
            let phrase = generate_recovery_phrase();
            assert_eq!(
                session.register(&phrase).await.unwrap_err(),
                "no approved connection to register"
            );
        });
    }

    // Validate locally first, so an obvious typo does not consume the approved builder
    // — which cannot be rebuilt, only re-requested.
    #[test]
    fn register_validates_the_phrase_before_consuming_the_builder() {
        block_on(async {
            let session = Session::new();
            let err = session
                .register("clearly not a recovery phrase")
                .await
                .unwrap_err();
            assert!(err.starts_with("recovery phrase:"), "unexpected: {err}");
        });
    }

    #[test]
    fn generated_phrases_validate() {
        let phrase = generate_recovery_phrase();
        assert_eq!(phrase.split_whitespace().count(), 12);
        assert!(validate_recovery_phrase(&phrase).is_ok());
    }
}
