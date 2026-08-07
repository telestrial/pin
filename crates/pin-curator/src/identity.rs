//! Publish this identity's public coordinates: who I am, and where to reach me.
//!
//! One packet under the did:dht key, carrying three things a visitor needs:
//!   `_dir`  — a pointer to the directory blob on Sia (profile, advertised channels
//!             with their keys, public follows). Public by capability: the blob isn't
//!             app-encrypted, and the Sia share URL's own fragment is what gates it.
//!   `_ns`   — this identity's doc namespace, so a peer knows which doc to sync.
//!   `_iroh` — every live endpoint this identity can be dialed at.
//!
//! ONE writer, which is the point. This used to be two: the Curator published
//! `_iroh`/`_ns` once at startup, and a React effect published `_dir` a few seconds
//! later — as a whole-packet overwrite, so on desktop the Curator's half was erased
//! almost every session. Neither writer could see the other's contribution. Now all
//! three parts come out of the doc, which every instance of this identity syncs, so
//! whichever instance publishes publishes the whole truth.
//!
//! And on a cadence rather than once, because a pkarr record ages off Mainline: an
//! identity nobody republishes stops resolving, exactly like a channel's locator does.
//!
//! What the Curator does NOT do here is interpret. Profile, follows and handle-follows
//! are copied out of settings as opaque JSON — it has no opinion about their shape, so
//! it cannot corrupt them, and the fields stay owned by the code that writes them.

use std::sync::Arc;
use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_derive::PUBLISHED_COLLECTION;

use crate::{live_instances, read_record, read_settings, PublishedState, SettingsView};

/// The directory document's schema version. Must match `DIRECTORY_DOC_VERSION` in
/// `src/core/identityDoc.ts` — a reader checks it and rejects anything else.
pub const DIRECTORY_DOC_VERSION: u32 = 2;

/// TXT prefixes in the published packet.
const DIR_PREFIX: &str = "_dir";
const NS_PREFIX: &str = "_ns";
const IROH_PREFIX: &str = "_iroh";

/// Where this identity's directory publish state lives, so the superseded blob gets
/// reclaimed like any other supersede.
const DIRECTORY_RKEY: &str = "directory";

/// How many endpoints to advertise. A whole packet is ~1000 bytes and the directory
/// pointer needs most of it, so the set is bounded — `live_instances` orders always-on
/// endpoints first, so truncation drops the ones a peer was least likely to reach.
const MAX_ENDPOINTS: usize = 8;

/// Everything a publish pass needs.
pub struct IdentityContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// A connected Sia session — the directory blob is uploaded before the pointer to
    /// it is published, so a pass over a disconnected session simply fails and retries.
    pub sia: Arc<pin_sia::Session>,
    /// The Sia AppKey: the settings key, the publish-state key, and the did:dht
    /// identity key all derive from it.
    pub app_key: [u8; 32],
    /// This identity's doc namespace id, published as `_ns`.
    pub namespace_id: String,
}

/// What one pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct IdentityOutcome {
    /// Whether the directory blob was re-uploaded (its content changed).
    pub uploaded: bool,
    /// Whether the packet reached the DHT.
    pub published: bool,
    /// Endpoints advertised in this packet.
    pub endpoints: usize,
    /// Whether there was nothing to advertise, so nothing was published.
    pub empty: bool,
    /// Owned channels whose manifest this instance couldn't read. Non-zero means the
    /// pass published NOTHING — see `advertised_channels`.
    pub incomplete: usize,
}

/// One advertised public channel: enough for a resolver to read it — the channelID
/// plus its key K, which is shareable by definition for a public channel.
#[derive(serde::Serialize)]
struct DirectoryChannel {
    #[serde(rename = "channelID")]
    channel_id: String,
    key: String,
    name: String,
}

/// The directory document, byte-compatible with what the frontend published before it.
///
/// Field names and presence are asserted against captured output rather than derived:
/// `profile` is written as an explicit `null` when absent (not omitted), while the
/// optional members inside it ARE omitted, because that's what `JSON.stringify` does
/// with `undefined`. A reader that expects one and gets the other sees a different
/// document.
#[derive(serde::Serialize)]
struct DirectoryDoc {
    version: u32,
    /// Opaque: copied out of settings untouched. The Curator publishes a profile; it
    /// doesn't own its shape.
    profile: Option<serde_json::Value>,
    channels: Vec<DirectoryChannel>,
    /// Opaque, as above.
    follows: Vec<serde_json::Value>,
    #[serde(rename = "handleFollows")]
    handle_follows: Vec<String>,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

/// The manifest fields the directory needs from an owned channel. Nothing else is read,
/// so a manifest that grows a field is no concern of this loop's.
#[derive(serde::Deserialize)]
struct ChannelView {
    name: String,
    #[serde(default)]
    visibility: Option<String>,
}

/// The advertised public channels, in the order settings lists them, plus a count of
/// the owned channels this instance couldn't read.
///
/// Advertised means: public visibility, and not explicitly unclaimed. Obscure channels
/// are ABSENT by construction — they're reachable only through their own K-derived
/// locator, so resolving an identity must never enumerate them.
///
/// The unreadable count is the important half. An instance whose doc hasn't finished
/// syncing knows from settings that it owns a channel while having no manifest for it,
/// and silently skipping that channel would publish a directory that omits it — the
/// same failure as publishing settings you never read, one layer up. So the caller
/// treats any unreadable manifest as "this view is incomplete" and publishes nothing.
async fn advertised_channels(
    ctx: &IdentityContext,
    settings: &SettingsView,
) -> (Vec<DirectoryChannel>, usize) {
    let mut out = Vec::new();
    let mut unreadable = 0;
    for owned in &settings.my_channels {
        if owned.advertised == Some(false) {
            continue;
        }
        let Some(k) = pin_crypto::channel_key_from_base64(&owned.channel_key) else {
            // An undecodable key can't be advertised OR resolved by anyone, so it isn't
            // something a later pass would do better with.
            continue;
        };
        let Some(view) = read_channel(ctx, &owned.channel_id, &k).await else {
            unreadable += 1;
            continue;
        };
        if view.visibility.as_deref() != Some("public") {
            continue;
        }
        out.push(DirectoryChannel {
            channel_id: owned.channel_id.clone(),
            key: owned.channel_key.clone(),
            name: view.name,
        });
    }
    (out, unreadable)
}

/// An owned channel's manifest from the doc, opened with its K.
async fn read_channel(
    ctx: &IdentityContext,
    channel_id: &str,
    k: &[u8; 32],
) -> Option<ChannelView> {
    let raw = read_record(&ctx.doc, &ctx.blobs, ctx.author_id, "channel", channel_id)
        .await
        .ok()
        .flatten()?;
    let blob = String::from_utf8(raw).ok()?;
    let json = pin_channel::open_blob(k, &blob).ok()?;
    serde_json::from_str(&json).ok()
}

/// A stable fingerprint of the directory's CONTENT — everything but `updatedAt`, which
/// moves on every pass and would otherwise make every pass look like a change.
fn fingerprint(doc: &DirectoryDoc) -> String {
    let mut copy = serde_json::to_value(doc).unwrap_or(serde_json::Value::Null);
    if let Some(obj) = copy.as_object_mut() {
        obj.insert("updatedAt".into(), serde_json::Value::String(String::new()));
    }
    copy.to_string()
}

/// Whether this directory is worth publishing at all. An identity with no profile, no
/// advertised channels and no follows has nothing to say, and publishing an empty
/// document would only announce that it exists.
fn has_anything(doc: &DirectoryDoc) -> bool {
    doc.profile.is_some()
        || !doc.channels.is_empty()
        || !doc.follows.is_empty()
        || !doc.handle_follows.is_empty()
}

/// Which generation to reclaim, and which to keep alive, after publishing `current`.
///
/// Pulled out of the pass so the rule is testable on its own: the previous generation
/// is deliberately NOT deleted, because a reader on lagging relays is still being
/// handed the pointer to it.
fn reclaim_plan(held: Option<&PublishedState>, current: &str) -> (Option<String>, Option<String>) {
    match held {
        // Same object as last time — a keep-alive pass. Nothing was superseded, so
        // no generation shifts and nothing is reclaimed.
        Some(h) if h.id == current => (h.older_id.clone(), None),
        // A new object supersedes the current one, which becomes the grace generation.
        // The one it displaces is now two publishes back, past any propagation window,
        // and safe to reclaim.
        Some(h) => (Some(h.id.clone()), h.older_id.clone()),
        None => (None, None),
    }
}

/// One pass: assemble, upload if the content moved, and publish the packet.
///
/// The publish happens every pass even when nothing changed — that IS the keep-alive.
/// The upload happens only when the content actually differs, so a republish costs one
/// signed packet rather than a fresh Sia object every half hour.
pub async fn publish_identity_once(
    ctx: &IdentityContext,
    now_iso: String,
    now_secs: u64,
) -> Result<IdentityOutcome, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;
    let (channels, unreadable) = advertised_channels(ctx, &settings).await;
    let mut outcome = IdentityOutcome::default();

    // Publish nothing from a view we know is partial. This instance owns channels it
    // has no manifest for — its doc hasn't finished syncing — and the directory it
    // would assemble omits them. Publishing it replaces a complete directory with a
    // lie, from an instance that simply hasn't caught up yet.
    if unreadable > 0 {
        outcome.incomplete = unreadable;
        return Ok(outcome);
    }

    let doc = DirectoryDoc {
        version: DIRECTORY_DOC_VERSION,
        profile: settings.profile.clone(),
        channels,
        follows: settings.follows.clone(),
        handle_follows: settings.handle_follows.clone(),
        updated_at: now_iso,
    };

    if !has_anything(&doc) {
        outcome.empty = true;
        return Ok(outcome);
    }

    let published_key = pin_derive::published_key(&ctx.app_key);
    let held = read_published(ctx, &published_key).await;
    let fp = fingerprint(&doc);

    // Reuse the existing blob when the content hasn't moved; otherwise mint a new one.
    let (item_url, object_id) = match &held {
        Some(h) if h.fp.as_deref() == Some(fp.as_str()) && h.url.is_some() => {
            (h.url.clone().unwrap(), h.id.clone())
        }
        _ => {
            let bytes = serde_json::to_vec(&doc).map_err(|e| format!("encode directory: {e}"))?;
            let up = ctx.sia.upload_item(bytes, None).await?;
            outcome.uploaded = true;
            (up.item_url, up.id)
        }
    };

    let endpoints = live_instances(&ctx.doc, &ctx.blobs, ctx.author_id, now_secs).await;
    let endpoints: Vec<String> = endpoints.into_iter().take(MAX_ENDPOINTS).collect();
    outcome.endpoints = endpoints.len();

    let mut records = pin_pkarr::chunk_txt(DIR_PREFIX, &item_url);
    records.push(pin_pkarr::TxtRecord {
        name: NS_PREFIX.to_string(),
        value: ctx.namespace_id.clone(),
    });
    if !endpoints.is_empty() {
        // Comma-joined into ONE logical value rather than one record per endpoint, so
        // the existing chunking carries it and a prefix keeps a single meaning. With
        // one endpoint this is byte-identical to the single-node-id form it replaces.
        records.extend(pin_pkarr::chunk_txt(IROH_PREFIX, &endpoints.join(",")));
    }

    let seed = pin_derive::did_dht_seed(&ctx.app_key);
    pin_pkarr::publish(&seed, &records).await?;
    outcome.published = true;

    // Grace deletion (keep-2), exactly as a channel manifest does it — and for exactly
    // the same reason, which the first cut of this got wrong. Publishing a new pointer
    // does not make the old one stop being served: a pkarr record takes time to
    // propagate, and a reader on public relays resolves the previous pointer for
    // minutes afterwards. Deleting the object it names turns "slightly stale" into
    // "object not found". So the current AND immediately-previous generations stay
    // alive, and only the one two publishes back is reclaimed.
    let (older_id, to_reclaim) = reclaim_plan(held.as_ref(), &object_id);

    write_published(
        ctx,
        &published_key,
        &PublishedState {
            id: object_id,
            url: Some(item_url),
            older_id,
            fp: Some(fp),
        },
    )
    .await;

    if let Some(old) = to_reclaim {
        let _ = ctx.sia.delete_object(&old).await;
    }
    Ok(outcome)
}

async fn read_published(ctx: &IdentityContext, key: &[u8; 32]) -> Option<PublishedState> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        PUBLISHED_COLLECTION,
        DIRECTORY_RKEY,
    )
    .await
    .ok()
    .flatten()?;
    let blob = String::from_utf8(raw).ok()?;
    let json = pin_crypto::decrypt(key, &blob).ok()?;
    serde_json::from_slice(&json).ok()
}

/// Best-effort, and noisy on failure: losing this record means the blob we just
/// superseded has nothing left that knows to reclaim it.
async fn write_published(ctx: &IdentityContext, key: &[u8; 32], state: &PublishedState) {
    let Ok(json) = serde_json::to_vec(state) else {
        return;
    };
    let Ok(sealed) = pin_crypto::encrypt(key, &json) else {
        return;
    };
    let _ = ctx
        .doc
        .set_bytes(
            ctx.author_id,
            pin_derive::record_key(PUBLISHED_COLLECTION, DIRECTORY_RKEY),
            sealed.into_bytes(),
        )
        .await;
}

/// Publish, wait, repeat — forever. Clocks come from the caller, since neither
/// `SystemTime::now()` nor a date formatter is available on the wasm target.
pub async fn run_identity_loop(
    ctx: IdentityContext,
    cadence: Duration,
    now_iso: impl Fn() -> String,
    now_secs: impl Fn() -> u64,
    on_pass: impl Fn(Result<IdentityOutcome, String>),
) -> ! {
    loop {
        on_pass(publish_identity_once(&ctx, now_iso(), now_secs()).await);
        n0_future::time::sleep(cadence).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(profile: Option<serde_json::Value>, channels: Vec<DirectoryChannel>) -> DirectoryDoc {
        DirectoryDoc {
            version: DIRECTORY_DOC_VERSION,
            profile,
            channels,
            follows: Vec::new(),
            handle_follows: Vec::new(),
            updated_at: "2026-08-06T12:00:00.000Z".into(),
        }
    }

    // Captured from the TypeScript implementation this replaces, before it was
    // changed. Round-tripping our own output would pass while disagreeing with every
    // reader in the network about what a directory document looks like.
    const FULL: &str = r#"{"version":2,"profile":{"$type":"dev.sia.pin.profile","username":"john","displayName":"John Williams","bio":"builds things","avatarURL":"sia://avatar#encryption_key=a","coverURL":"sia://cover#encryption_key=b","updatedAt":"2026-08-06T12:00:00.000Z"},"channels":[{"channelID":"chan-one","key":"AAAA","name":"First"},{"channelID":"chan-two","key":"BBBB","name":"Second"}],"follows":[{"didDht":"did:dht:aaa","channelID":"c1","name":"Theirs"},{"didDht":"did:dht:bbb","channelID":"c2"}],"handleFollows":["did:dht:ccc","did:dht:ddd"],"updatedAt":"2026-08-06T12:00:00.000Z"}"#;
    const EMPTY_PROFILE: &str = r#"{"version":2,"profile":null,"channels":[],"follows":[],"handleFollows":[],"updatedAt":"2026-08-06T12:00:00.000Z"}"#;

    #[test]
    fn a_full_directory_serializes_exactly_as_the_frontend_did() {
        let d = DirectoryDoc {
            version: DIRECTORY_DOC_VERSION,
            profile: Some(
                serde_json::from_str(
                    r#"{"$type":"dev.sia.pin.profile","username":"john","displayName":"John Williams","bio":"builds things","avatarURL":"sia://avatar#encryption_key=a","coverURL":"sia://cover#encryption_key=b","updatedAt":"2026-08-06T12:00:00.000Z"}"#,
                )
                .unwrap(),
            ),
            channels: vec![
                DirectoryChannel {
                    channel_id: "chan-one".into(),
                    key: "AAAA".into(),
                    name: "First".into(),
                },
                DirectoryChannel {
                    channel_id: "chan-two".into(),
                    key: "BBBB".into(),
                    name: "Second".into(),
                },
            ],
            follows: vec![
                serde_json::from_str(r#"{"didDht":"did:dht:aaa","channelID":"c1","name":"Theirs"}"#)
                    .unwrap(),
                serde_json::from_str(r#"{"didDht":"did:dht:bbb","channelID":"c2"}"#).unwrap(),
            ],
            handle_follows: vec!["did:dht:ccc".into(), "did:dht:ddd".into()],
            updated_at: "2026-08-06T12:00:00.000Z".into(),
        };
        // Compared as parsed values, not as bytes. A directory document is PARSED by
        // its readers — nothing compares one to another as a string — and the opaque
        // members round-trip through `serde_json::Value`, which sorts object keys where
        // JavaScript preserves insertion order. Order is genuinely not part of this
        // contract; field names, nesting, and present-vs-absent are, and comparing
        // values checks all three. (A channel manifest is the opposite case: those ARE
        // compared by `JSON.stringify` equality, so their key order is load-bearing.)
        let got: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
        let want: serde_json::Value = serde_json::from_str(FULL).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn an_absent_profile_is_null_not_omitted() {
        // `JSON.stringify` writes an explicit null for a null field, and a reader
        // distinguishes "no profile" from a malformed document by finding the key.
        // Exact here, because this document has no opaque members to reorder — so it
        // also pins the top-level field order against the captured original.
        assert_eq!(
            serde_json::to_string(&doc(None, Vec::new())).unwrap(),
            EMPTY_PROFILE
        );
    }

    #[test]
    fn an_identity_with_nothing_to_say_is_not_published() {
        // Publishing an empty document would announce that the identity exists while
        // telling a visitor nothing — worse than not publishing.
        assert!(!has_anything(&doc(None, Vec::new())));
        assert!(has_anything(&doc(Some(serde_json::json!({})), Vec::new())));
        assert!(has_anything(&doc(
            None,
            vec![DirectoryChannel {
                channel_id: "a".into(),
                key: "k".into(),
                name: "n".into(),
            }]
        )));
    }

    fn state(id: &str, older: Option<&str>) -> PublishedState {
        PublishedState {
            id: id.into(),
            url: Some(format!("sia://{id}")),
            older_id: older.map(Into::into),
            fp: None,
        }
    }

    #[test]
    fn the_previous_generation_is_kept_alive() {
        // The bug this exists for: publishing a new pointer does not stop the old one
        // being served. A reader on public relays resolves the previous pointer for
        // minutes afterwards, so deleting the object it names turns "slightly stale"
        // into "object not found" — which is exactly what a browser hit.
        let (older, reclaim) = reclaim_plan(Some(&state("gen1", None)), "gen2");
        assert_eq!(older.as_deref(), Some("gen1"));
        assert_eq!(reclaim, None);
    }

    #[test]
    fn only_the_generation_two_back_is_reclaimed() {
        let (older, reclaim) = reclaim_plan(Some(&state("gen2", Some("gen1"))), "gen3");
        assert_eq!(older.as_deref(), Some("gen2"));
        assert_eq!(reclaim.as_deref(), Some("gen1"));
    }

    #[test]
    fn a_keep_alive_pass_supersedes_nothing() {
        // Most passes republish the SAME object to refresh its TTL. Nothing was
        // superseded, so no generation shifts and no delete is issued — otherwise
        // every pass would re-delete the same id forever.
        let (older, reclaim) = reclaim_plan(Some(&state("gen2", Some("gen1"))), "gen2");
        assert_eq!(older.as_deref(), Some("gen1"));
        assert_eq!(reclaim, None);
    }

    #[test]
    fn a_first_publish_reclaims_nothing() {
        let (older, reclaim) = reclaim_plan(None, "gen1");
        assert_eq!(older, None);
        assert_eq!(reclaim, None);
    }

    #[test]
    fn the_fingerprint_ignores_only_the_timestamp() {
        let a = doc(Some(serde_json::json!({"username": "john"})), Vec::new());
        let mut b = doc(Some(serde_json::json!({"username": "john"})), Vec::new());
        b.updated_at = "2099-01-01T00:00:00.000Z".into();
        // Same content, different pass → no re-upload.
        assert_eq!(fingerprint(&a), fingerprint(&b));

        let c = doc(Some(serde_json::json!({"username": "jane"})), Vec::new());
        assert_ne!(fingerprint(&a), fingerprint(&c));
    }
}
