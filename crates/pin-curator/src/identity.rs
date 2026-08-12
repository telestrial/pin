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
///
/// 3 added `endorsements`. A reader is strict about this, so old published directories
/// stop resolving until their author republishes — which every identity's own loop does
/// within one cadence.
pub const DIRECTORY_DOC_VERSION: u32 = 3;

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
    /// What this identity has endorsed — one signed record each, verbatim.
    ///
    /// World-readable, which auditability requires rather than merely permits: a third
    /// party cannot check a count whose backing records they are not allowed to read. And
    /// it rides in the directory because a crawl fetches that blob anyway, so endorsements
    /// cost no extra round trip; a separate object would double the crawl's Sia reads,
    /// which are the slow part.
    ///
    /// CURRENT endorsements only. Withdrawing removes the record rather than appending a
    /// tombstone, so this stays bounded — a lifetime's history would sit in a blob that
    /// gets fetched to draw a display name in a feed row. The cost is that the backing set
    /// is provably the live one and never the historical one, which is what a count shows
    /// anyway.
    #[serde(default)]
    endorsements: Vec<serde_json::Value>,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

/// The advertised public channels, in the order settings lists them.
///
/// Advertised means: public visibility, and not explicitly unclaimed. Obscure channels
/// are ABSENT by construction — they're reachable only through their own K-derived
/// locator, so resolving an identity must never enumerate them. A channel whose
/// visibility settings doesn't record is treated the same way: unknown is not public.
///
/// Everything this needs is in the settings record. It used to open each owned
/// channel's manifest out of a `channel/<id>` doc record to read two fields, but
/// visibility is sticky at creation and the name is kept in step by the edit path, so
/// both are facts settings already holds — and that record existed for no other reader.
fn advertised_channels(settings: &SettingsView) -> Vec<DirectoryChannel> {
    settings
        .my_channels
        .iter()
        .filter(|owned| owned.advertised != Some(false))
        .filter(|owned| owned.visibility.as_deref() == Some("public"))
        .map(|owned| DirectoryChannel {
            channel_id: owned.channel_id.clone(),
            key: owned.channel_key.clone(),
            name: owned.name.clone(),
        })
        .collect()
}

/// This identity's own endorsement records, as published.
///
/// Read as opaque JSON and passed through untouched. The Curator does not need to parse an
/// endorsement to publish one, and not parsing it is what makes it unable to corrupt one —
/// the same posture it takes with the profile. Each record is independently signed, so a
/// reader verifies them one at a time and a partial or reordered read is still trustworthy.
///
/// Sorted by record key so the fingerprint below is stable: unordered iteration would make
/// every pass look like a change and re-upload the blob.
async fn own_endorsements(ctx: &IdentityContext) -> Vec<serde_json::Value> {
    let mut rkeys = crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::ENDORSE_COLLECTION)
        .await
        .unwrap_or_default();
    rkeys.sort();

    let mut out = Vec::with_capacity(rkeys.len());
    for rkey in rkeys {
        let Ok(Some(raw)) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            pin_derive::ENDORSE_COLLECTION,
            &rkey,
        )
        .await
        else {
            continue;
        };
        // Skip anything unreadable rather than failing the publish: one bad record must not
        // cost an identity its whole directory.
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) {
            out.push(value);
        }
    }
    out
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
        // An identity that has only ever endorsed things still has something to publish:
        // without it, nobody could ever count what they endorsed.
        || !doc.endorsements.is_empty()
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
    let doc = DirectoryDoc {
        version: DIRECTORY_DOC_VERSION,
        profile: settings.profile.clone(),
        channels: advertised_channels(&settings),
        follows: settings.follows.clone(),
        handle_follows: settings.handle_follows.clone(),
        endorsements: own_endorsements(ctx).await,
        updated_at: now_iso,
    };

    let mut outcome = IdentityOutcome::default();
    if !has_anything(&doc) {
        outcome.empty = true;
        return Ok(outcome);
    }

    let published_key = pin_derive::published_key(&ctx.app_key);
    let held = read_published(ctx, &published_key).await;
    let fp = fingerprint(&doc);

    // Reuse the existing blob when the content hasn't moved; otherwise mint a new one
    // and hand the superseded id to the reclaim below.
    let (item_url, object_id, superseded) = match &held {
        Some(h) if h.fp.as_deref() == Some(fp.as_str()) && h.url.is_some() => {
            (h.url.clone().unwrap(), h.id.clone(), None)
        }
        _ => {
            let bytes = serde_json::to_vec(&doc).map_err(|e| format!("encode directory: {e}"))?;
            let up = ctx.sia.upload_item(bytes, None).await?;
            outcome.uploaded = true;
            (up.item_url, up.id, held.as_ref().map(|h| h.id.clone()))
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

    crate::write_published(
        &ctx.doc,
        ctx.author_id,
        &published_key,
        DIRECTORY_RKEY,
        &PublishedState {
            id: object_id,
            url: Some(item_url),
            older_id: None,
            fp: Some(fp),
        },
    )
    .await;

    // Reclaim the blob we just replaced. No grace window, unlike a channel manifest:
    // the directory is read on demand by a visitor rather than polled, and a reader
    // mid-resolve holds the URL they already fetched.
    if let Some(old) = superseded {
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
            endorsements: Vec::new(),
            updated_at: "2026-08-06T12:00:00.000Z".into(),
        }
    }

    // Captured from the TypeScript implementation this replaces, before it was
    // changed. Round-tripping our own output would pass while disagreeing with every
    // reader in the network about what a directory document looks like.
    const FULL: &str = r#"{"version":3,"profile":{"$type":"dev.sia.pin.profile","username":"john","displayName":"John Williams","bio":"builds things","avatarURL":"sia://avatar#encryption_key=a","coverURL":"sia://cover#encryption_key=b","updatedAt":"2026-08-06T12:00:00.000Z"},"channels":[{"channelID":"chan-one","key":"AAAA","name":"First"},{"channelID":"chan-two","key":"BBBB","name":"Second"}],"follows":[{"didDht":"did:dht:aaa","channelID":"c1","name":"Theirs"},{"didDht":"did:dht:bbb","channelID":"c2"}],"handleFollows":["did:dht:ccc","did:dht:ddd"],"endorsements":[],"updatedAt":"2026-08-06T12:00:00.000Z"}"#;
    const EMPTY_PROFILE: &str = r#"{"version":3,"profile":null,"channels":[],"follows":[],"handleFollows":[],"endorsements":[],"updatedAt":"2026-08-06T12:00:00.000Z"}"#;

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
            endorsements: Vec::new(),
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
    fn an_endorsement_travels_in_the_directory_verbatim() {
        // The published record has to be byte-for-byte what its signer wrote, because a
        // reader verifies the signature over it. Re-serializing through a type of our own
        // would risk changing what is verified — so it is carried as opaque JSON, and this
        // pins that it survives the round trip.
        let record = serde_json::json!({
            "kind": "pin",
            "actor": "did:dht:someone",
            "subject": "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a",
            "version": "bafkreisomething",
            "createdAt": "2026-08-11T12:00:00.000Z",
            "sig": "Zm9vYmFy",
        });
        let mut d = doc(None, Vec::new());
        d.endorsements = vec![record.clone()];

        let wire: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
        assert_eq!(wire["endorsements"][0], record);
        // And an identity that has only ever endorsed things still publishes: without
        // this, nobody could count what they endorsed.
        assert!(has_anything(&d));
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

    #[test]
    fn only_known_public_claimed_channels_are_advertised() {
        // Parsed from JSON rather than constructed, so this also pins the settings
        // field names the frontend writes — the class of mistake that has bitten this
        // codebase before, and one no compiler on either side can see.
        let settings: SettingsView = serde_json::from_str(
            r#"{"myChannels":[
                {"channelID":"pub","channelKey":"KP","name":"Public","visibility":"public"},
                {"channelID":"obs","channelKey":"KO","name":"Obscure","visibility":"obscure"},
                {"channelID":"unc","channelKey":"KU","name":"Unclaimed","visibility":"public","advertised":false},
                {"channelID":"old","channelKey":"KL","name":"Legacy"},
                {"channelID":"pub2","channelKey":"KP2","name":"Also public","visibility":"public"}
            ]}"#,
        )
        .unwrap();

        let got = advertised_channels(&settings);
        let ids: Vec<&str> = got.iter().map(|c| c.channel_id.as_str()).collect();
        // Order follows settings, and the name comes from settings too.
        assert_eq!(ids, vec!["pub", "pub2"]);
        assert_eq!(got[0].name, "Public");
        assert_eq!(got[0].key, "KP");

        // The one that matters: a channel whose visibility settings doesn't record is
        // UNKNOWN, and unknown is not published. Guessing 'public' for "old" would
        // enumerate a channel that may be obscure, which is the property obscurity is.
        assert!(!ids.contains(&"old"));
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
