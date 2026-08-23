//! Publish this identity's public coordinates: who I am, and where to reach me.
//!
//! One packet under the did:dht key, carrying three things a visitor needs:
//!   `_dir`  — a pointer to the directory blob on Sia (profile, advertised channels
//!             with their keys, public follows). Public by capability: the blob isn't
//!             app-encrypted, and the Sia share URL's own fragment is what gates it.
//!   `_ns`   — this identity's doc namespace, so a peer knows which doc to sync.
//!   `_iroh` — every live endpoint this identity can be dialed at.
//!
//! The directory also points at a second blob holding this identity's comments. They live
//! apart from it because of size: an endorsement is a few hundred bytes and stays there,
//! while a comment carries its words inline, and this blob is fetched to draw a display
//! name in a feed row. One extra Sia read buys it, and it lands on the crawl rather than on
//! anything a screen waits for.
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
/// 3 added `endorsements`; 4 added `commentsURL`. A reader is strict about this, so old
/// published directories stop resolving until their author republishes — which every
/// identity's own loop does within one cadence.
pub const DIRECTORY_DOC_VERSION: u32 = 4;

/// The comments blob's schema version, checked by whoever downloads it.
pub const COMMENTS_DOC_VERSION: u32 = 1;

/// TXT prefixes in the published packet.
pub(crate) const DIR_PREFIX: &str = "_dir";
const NS_PREFIX: &str = "_ns";
pub(crate) const IROH_PREFIX: &str = "_iroh";

/// Where this identity's directory publish state lives, so the superseded blob gets
/// reclaimed like any other supersede.
const DIRECTORY_RKEY: &str = "directory";

/// Where the comments blob's publish state lives. Its own rkey, so the two blobs supersede
/// independently: a comment written while the profile stands still replaces one object.
const COMMENTS_RKEY: &str = "comments";

/// How many endpoints to advertise.
///
/// A whole packet is ~1000 bytes and the directory pointer needs most of it, so the set is
/// bounded. Lower than it was, because an endpoint now carries its relay URL as well as
/// its id and costs roughly three times as much room — a worthwhile trade, since an id
/// alone names an endpoint without locating it and dialing it would fall through to a
/// discovery service we'd rather not depend on.
///
/// Three is generous for what an identity actually runs at once: a desktop, a phone, a
/// tab. `live_instances` orders always-on endpoints first, so truncation drops the ones a
/// peer was least likely to reach anyway.
///
/// Measured, not estimated: against the longest realistic directory pointer this comes to
/// 821 bytes, four still fits, and five does not. The one spare slot is deliberate — the
/// worst case below is the worst case we know of, and a packet that stops signing takes an
/// identity's whole coordinate set off the DHT rather than just its last endpoint.
const MAX_ENDPOINTS: usize = 3;

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
    /// Of those, how many say WHERE they are rather than only who they are.
    ///
    /// A peer skips an endpoint with no address — dialing a bare id is the fall-through to
    /// a discovery service we don't want to depend on — so a packet advertising endpoints
    /// but none of them dialable is one nobody can knock at. Reported because the two look
    /// identical from outside, and the difference is whether anyone can reach this
    /// identity at all.
    pub dialable: usize,
    /// Whether there was nothing to advertise, so nothing was published.
    pub empty: bool,
    /// Whether the comments blob was re-uploaded. Its own flag because it supersedes on its
    /// own schedule: a comment written while the profile stands still moves this and not
    /// `uploaded`, and vice versa.
    pub comments_uploaded: bool,
    /// What minting comment bodies into objects of their own did.
    pub bodies: crate::comments::MintOutcome,
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
    /// Where this identity's comments are, when there are any.
    ///
    /// A pointer rather than the records, on the size argument in the module docs. Absent
    /// while nothing has been commented, which is also what makes the extra read
    /// conditional: a crawl fetches this blob for everyone and the comments blob only for
    /// identities that have written some.
    #[serde(
        rename = "commentsURL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    comments_url: Option<String>,
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

/// This identity's comments, as published.
///
/// Versioned like the directory and for the same reason: a reader that guessed at the shape
/// would fail as a parse error somewhere further along.
#[derive(serde::Serialize, serde::Deserialize)]
struct CommentsDoc {
    version: u32,
    /// Signed records, verbatim and opaque — the same posture the directory takes with
    /// endorsements. Each verifies on its own, so a partial or reordered read still holds.
    comments: Vec<serde_json::Value>,
}

/// This identity's own comment records, read out of the doc in key order.
///
/// Sorted so the fingerprint below is stable, exactly as `own_endorsements` is: unordered
/// iteration would make every pass look like a change and re-upload the blob.
async fn own_comments(ctx: &IdentityContext) -> Vec<serde_json::Value> {
    let mut rkeys = crate::list_rkeys(&ctx.doc, ctx.author_id, pin_derive::COMMENT_COLLECTION)
        .await
        .unwrap_or_default();
    rkeys.sort();

    let mut out = Vec::with_capacity(rkeys.len());
    for rkey in rkeys {
        let Ok(Some(raw)) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            pin_derive::COMMENT_COLLECTION,
            &rkey,
        )
        .await
        else {
            continue;
        };
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) {
            out.push(value);
        }
    }
    out
}

/// A stable fingerprint of a comments blob's content.
fn comments_fingerprint(doc: &CommentsDoc) -> String {
    serde_json::to_value(doc)
        .unwrap_or(serde_json::Value::Null)
        .to_string()
}

/// What a pass worked out about the comments blob, to be applied once the packet naming it
/// is live.
///
/// Split from the doing for ordering. The bytes go up FIRST, so a pointer never names an
/// object that failed to land; the state record and the reclaim go LAST, after the packet,
/// so a failed publish leaves the previous generation both alive and still accounted for. A
/// state record written early would strand the object it superseded — the next pass would
/// match the new fingerprint and never learn there was an older one.
#[derive(Default)]
struct CommentsPublish {
    /// The pointer for the directory to carry.
    url: Option<String>,
    /// What to record about the blob just uploaded.
    state: Option<PublishedState>,
    /// Whether to forget the state entirely, the last comment having gone.
    clear: bool,
    /// The object nothing will point at once the packet is published.
    superseded: Option<String>,
    uploaded: bool,
}

/// What one pass needs to do about the comments blob, decided before anything is uploaded.
///
/// Separated from the doing so it can be tested without a Sia session or a doc, the same
/// reason `accept_knock` is pure over its inbox. What it decides is small and easy to get
/// backwards — whether an object is given up, and which object.
#[derive(Debug, PartialEq, Eq)]
enum CommentsPlan {
    /// No comments and none published. Nothing to point at, nothing to reclaim.
    Nothing,
    /// What is published still matches. Carry the pointer as it stands.
    Keep(String),
    /// The last comment went. Publish no pointer and give up the object.
    Drop(String),
    /// Upload these bytes under this fingerprint, superseding whatever was held.
    Upload {
        bytes: Vec<u8>,
        fp: String,
        superseded: Option<String>,
    },
}

fn plan_comments(
    held: Option<PublishedState>,
    records: Vec<serde_json::Value>,
) -> Result<CommentsPlan, String> {
    if records.is_empty() {
        // A positive answer rather than an absence: the records were read and there are
        // none, which is exactly what deleting a last comment should do.
        return Ok(match held {
            Some(h) => CommentsPlan::Drop(h.id),
            None => CommentsPlan::Nothing,
        });
    }

    let doc = CommentsDoc {
        version: COMMENTS_DOC_VERSION,
        comments: records,
    };
    let fp = comments_fingerprint(&doc);
    // A matching fingerprint with no URL beside it cannot be pointed at, so it re-uploads.
    if let Some(h) = &held {
        if h.fp.as_deref() == Some(fp.as_str()) {
            if let Some(url) = &h.url {
                return Ok(CommentsPlan::Keep(url.clone()));
            }
        }
    }

    Ok(CommentsPlan::Upload {
        bytes: serde_json::to_vec(&doc).map_err(|e| format!("encode comments: {e}"))?,
        fp,
        superseded: held.map(|h| h.id),
    })
}

/// Carry out the plan as far as the bytes go, leaving the record and the reclaim to the
/// caller — see `CommentsPublish` for why those wait.
async fn publish_comments(
    ctx: &IdentityContext,
    published_key: &[u8; 32],
    records: Vec<serde_json::Value>,
) -> Result<CommentsPublish, String> {
    let held = read_published(ctx, published_key, COMMENTS_RKEY).await;
    match plan_comments(held, records)? {
        CommentsPlan::Nothing => Ok(CommentsPublish::default()),
        CommentsPlan::Keep(url) => Ok(CommentsPublish {
            url: Some(url),
            ..Default::default()
        }),
        CommentsPlan::Drop(id) => Ok(CommentsPublish {
            clear: true,
            superseded: Some(id),
            ..Default::default()
        }),
        CommentsPlan::Upload {
            bytes,
            fp,
            superseded,
        } => {
            let up = ctx.sia.upload_item(bytes, None).await?;
            Ok(CommentsPublish {
                url: Some(up.item_url.clone()),
                state: Some(PublishedState {
                    id: up.id,
                    url: Some(up.item_url),
                    older_id: None,
                    fp: Some(fp),
                }),
                clear: false,
                superseded,
                uploaded: true,
            })
        }
    }
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
        // without it, nobody could ever count what they endorsed. Same for one that has
        // only ever commented — an unpublished pointer is a comment no crawl can confirm.
        || !doc.endorsements.is_empty()
        || doc.comments_url.is_some()
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
    let published_key = pin_derive::published_key(&ctx.app_key);

    let mut outcome = IdentityOutcome::default();
    // Bodies get their objects before the blob that carries them is assembled, so a comment
    // reaches a reader already pinnable rather than becoming so a pass later.
    outcome.bodies =
        crate::comments::mint_bodies(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.sia).await;
    let comments = publish_comments(ctx, &published_key, own_comments(ctx).await).await?;
    outcome.comments_uploaded = comments.uploaded;

    let doc = DirectoryDoc {
        version: DIRECTORY_DOC_VERSION,
        profile: settings.profile.clone(),
        channels: advertised_channels(&settings),
        follows: settings.follows.clone(),
        handle_follows: settings.handle_follows.clone(),
        endorsements: own_endorsements(ctx).await,
        comments_url: comments.url.clone(),
        updated_at: now_iso,
    };

    if !has_anything(&doc) {
        outcome.empty = true;
        return Ok(outcome);
    }

    let held = read_published(ctx, &published_key, DIRECTORY_RKEY).await;
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
    let endpoints: Vec<crate::InstanceAddr> = endpoints.into_iter().take(MAX_ENDPOINTS).collect();
    outcome.endpoints = endpoints.len();
    outcome.dialable = endpoints.iter().filter(|e| e.relay.is_some()).count();

    let mut records = pin_pkarr::chunk_txt(DIR_PREFIX, &item_url);
    records.push(pin_pkarr::TxtRecord {
        name: NS_PREFIX.to_string(),
        value: ctx.namespace_id.clone(),
    });
    if !endpoints.is_empty() {
        // ONE logical value rather than a record per endpoint, so the existing chunking
        // carries it and a prefix keeps a single meaning. Each entry names an endpoint
        // AND says where to reach it, so a peer dials from what it resolved here instead
        // of asking a discovery service — see the module docs on `instance`.
        records.extend(pin_pkarr::chunk_txt(
            IROH_PREFIX,
            &crate::encode_endpoints(&endpoints),
        ));
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

    if let Some(state) = &comments.state {
        crate::write_published(
            &ctx.doc,
            ctx.author_id,
            &published_key,
            COMMENTS_RKEY,
            state,
        )
        .await;
    }
    if comments.clear {
        let _ = crate::delete_record(
            &ctx.doc,
            ctx.author_id,
            pin_derive::PUBLISHED_COLLECTION,
            COMMENTS_RKEY,
        )
        .await;
    }

    // Reclaim the blobs nothing points at any more. No grace window, unlike a channel
    // manifest: these are read on demand by a visitor rather than polled, and a reader
    // mid-resolve holds the URL they already fetched.
    for old in [superseded, comments.superseded].into_iter().flatten() {
        let _ = ctx.sia.delete_object(&old).await;
    }
    Ok(outcome)
}

/// Whether this identity is now published in a state a peer can act on, and so whether the
/// loop may settle onto its slow cadence.
///
/// Only a publish that carried at least one dialable endpoint counts. Every other outcome —
/// an error, nothing to advertise, a packet with no addresses in it — leaves this identity
/// unreachable, and being unreachable is not a state to sit in for half an hour.
fn settled(outcome: &Result<IdentityOutcome, String>) -> bool {
    matches!(outcome, Ok(o) if o.published && o.dialable > 0)
}

async fn read_published(
    ctx: &IdentityContext,
    key: &[u8; 32],
    rkey: &str,
) -> Option<PublishedState> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        PUBLISHED_COLLECTION,
        rkey,
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
/// Two cadences, and the loop settles onto the slow one ONLY once it has published
/// something a peer could actually dial.
///
/// Anything short of that retries promptly, and the three ways to fall short all happen on
/// an ordinary first run:
///
/// - **The pass failed.** The commonest is `no settings record yet`: this loop's first pass
///   fires as soon as the engine is up, which is before the frontend has written settings.
///   Treating that like a settled success meant a fresh identity published NOTHING for half
///   an hour — no directory, no namespace, no endpoints — so nobody could resolve it, dial
///   it, or knock at it. It is the whole reason a first-run knock never landed.
/// - **Nothing to advertise yet.** Then the moment a channel is created, it should be
///   findable in seconds rather than at the next half-hour boundary.
/// - **Published, but nothing dialable.** An instance registers its address only once its
///   endpoint has reached a relay, some seconds after binding; a packet built before that
///   names endpoints without saying where they are, and a peer skips those.
///
/// The retry costs a local doc read, so an identity that stays in one of those states is
/// polling its own doc rather than the network.
pub async fn run_identity_loop(
    ctx: IdentityContext,
    cadence: Duration,
    retry: Duration,
    now_iso: impl Fn() -> String,
    now_secs: impl Fn() -> u64,
    on_pass: impl Fn(Result<IdentityOutcome, String>),
) -> ! {
    loop {
        let outcome = publish_identity_once(&ctx, now_iso(), now_secs()).await;
        let reachable = settled(&outcome);
        on_pass(outcome);
        n0_future::time::sleep(if reachable { cadence } else { retry }).await;
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
            comments_url: None,
            updated_at: "2026-08-06T12:00:00.000Z".into(),
        }
    }

    // Captured from the TypeScript implementation this replaces, before it was
    // changed. Round-tripping our own output would pass while disagreeing with every
    // reader in the network about what a directory document looks like.
    //
    // Still the v3 strings, compared against with only the version number substituted. That
    // is the claim worth pinning about v4: the schema gained one OPTIONAL field and nothing
    // else moved, so every other key, its order and its form are byte-identical to what the
    // frontend wrote. Editing these literals would assert far less.
    const FULL: &str = r#"{"version":3,"profile":{"$type":"dev.sia.pin.profile","username":"john","displayName":"John Williams","bio":"builds things","avatarURL":"sia://avatar#encryption_key=a","coverURL":"sia://cover#encryption_key=b","updatedAt":"2026-08-06T12:00:00.000Z"},"channels":[{"channelID":"chan-one","key":"AAAA","name":"First"},{"channelID":"chan-two","key":"BBBB","name":"Second"}],"follows":[{"didDht":"did:dht:aaa","channelID":"c1","name":"Theirs"},{"didDht":"did:dht:bbb","channelID":"c2"}],"handleFollows":["did:dht:ccc","did:dht:ddd"],"endorsements":[],"updatedAt":"2026-08-06T12:00:00.000Z"}"#;
    const EMPTY_PROFILE: &str = r#"{"version":3,"profile":null,"channels":[],"follows":[],"handleFollows":[],"endorsements":[],"updatedAt":"2026-08-06T12:00:00.000Z"}"#;

    /// The captured v3 form at the current version, for the reason above.
    fn at_current_version(captured: &str) -> String {
        captured.replace(
            r#""version":3"#,
            &format!(r#""version":{DIRECTORY_DOC_VERSION}"#),
        )
    }

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
            comments_url: None,
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
        let want: serde_json::Value = serde_json::from_str(&at_current_version(FULL)).unwrap();
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
            at_current_version(EMPTY_PROFILE)
        );
    }

    #[test]
    fn a_comments_pointer_is_absent_until_there_is_one() {
        // Absent rather than null, so a directory from an identity that has never commented
        // is byte-identical to the v3 form it grew out of — which is what the two captured
        // vectors above are then still able to check.
        let none = serde_json::to_string(&doc(None, Vec::new())).unwrap();
        assert!(!none.contains("commentsURL"));

        let mut with = doc(None, Vec::new());
        with.comments_url = Some("sia://comments#encryption_key=k".into());
        let json = serde_json::to_string(&with).unwrap();
        // Named exactly, and placed after the endorsements it sits beside. A field name is a
        // contract no compiler checks, and this codebase has shipped a URL under a name
        // nothing read.
        assert!(json.contains(
            r#""endorsements":[],"commentsURL":"sia://comments#encryption_key=k","updatedAt""#
        ));
    }

    #[test]
    fn a_comment_alone_is_worth_publishing() {
        // An identity with no profile, no channels and no follows still has to publish once
        // it has commented: an unpublished pointer is a comment no crawl can confirm, and
        // retention checking reads absence as withdrawal.
        let mut d = doc(None, Vec::new());
        assert!(!has_anything(&d));
        d.comments_url = Some("sia://comments#encryption_key=k".into());
        assert!(has_anything(&d));
    }

    fn state(id: &str, url: Option<&str>, fp: Option<&str>) -> PublishedState {
        PublishedState {
            id: id.into(),
            url: url.map(str::to_string),
            older_id: None,
            fp: fp.map(str::to_string),
        }
    }

    fn one_comment() -> Vec<serde_json::Value> {
        vec![serde_json::json!({"kind": "comment", "body": "hi"})]
    }

    #[test]
    fn a_last_comment_going_gives_up_the_object() {
        // The pointer has to come out of the directory before the bytes go, so the object is
        // handed back for the caller to reclaim AFTER the packet is published rather than
        // deleted here. A reader resolving in between would otherwise find the pointer alive
        // and the object gone.
        assert_eq!(
            plan_comments(
                Some(state("obj-1", Some("sia://a"), Some("fp"))),
                Vec::new()
            )
            .unwrap(),
            CommentsPlan::Drop("obj-1".into())
        );
    }

    #[test]
    fn no_comments_and_nothing_published_does_nothing() {
        assert_eq!(
            plan_comments(None, Vec::new()).unwrap(),
            CommentsPlan::Nothing
        );
    }

    #[test]
    fn an_unchanged_blob_is_pointed_at_where_it_is() {
        // The whole reason a fingerprint is stored: a pass that changed nothing costs one
        // signed packet, never a fresh Sia object.
        let doc = CommentsDoc {
            version: COMMENTS_DOC_VERSION,
            comments: one_comment(),
        };
        let fp = comments_fingerprint(&doc);
        assert_eq!(
            plan_comments(
                Some(state("obj-1", Some("sia://a"), Some(&fp))),
                one_comment()
            )
            .unwrap(),
            CommentsPlan::Keep("sia://a".into())
        );
    }

    #[test]
    fn a_changed_blob_supersedes_the_one_held() {
        let plan = plan_comments(
            Some(state("obj-1", Some("sia://a"), Some("stale"))),
            one_comment(),
        )
        .unwrap();
        match plan {
            CommentsPlan::Upload {
                superseded, bytes, ..
            } => {
                assert_eq!(superseded, Some("obj-1".into()));
                assert!(String::from_utf8(bytes).unwrap().contains(r#""version":1"#));
            }
            other => panic!("expected an upload, got {other:?}"),
        }
    }

    #[test]
    fn a_matching_fingerprint_with_no_url_re_uploads() {
        // State from a pass that recorded an id and never a URL. Pointing at nothing would
        // publish a directory whose comments pointer is absent while the records exist, so
        // the blob is uploaded again rather than trusted.
        let doc = CommentsDoc {
            version: COMMENTS_DOC_VERSION,
            comments: one_comment(),
        };
        let fp = comments_fingerprint(&doc);
        assert!(matches!(
            plan_comments(Some(state("obj-1", None, Some(&fp))), one_comment()).unwrap(),
            CommentsPlan::Upload { .. }
        ));
    }

    #[test]
    fn the_two_blobs_this_module_publishes_supersede_independently() {
        // They share the publish-state collection with the settings snapshot, and a shared
        // rkey would make two blobs reclaim each other's object.
        let keys = [
            DIRECTORY_RKEY,
            COMMENTS_RKEY,
            pin_derive::PUBLISHED_SETTINGS_RKEY,
        ];
        let unique: std::collections::HashSet<&str> = keys.iter().copied().collect();
        assert_eq!(unique.len(), keys.len());
    }

    #[test]
    fn a_comments_blob_fingerprints_on_its_records() {
        // What decides whether a pass re-uploads. Two records in one order and the other
        // must differ, or a comment could be added and the blob left alone.
        let one = CommentsDoc {
            version: COMMENTS_DOC_VERSION,
            comments: vec![serde_json::json!({"a": 1}), serde_json::json!({"b": 2})],
        };
        let same = CommentsDoc {
            version: COMMENTS_DOC_VERSION,
            comments: vec![serde_json::json!({"a": 1}), serde_json::json!({"b": 2})],
        };
        let fewer = CommentsDoc {
            version: COMMENTS_DOC_VERSION,
            comments: vec![serde_json::json!({"a": 1})],
        };
        assert_eq!(comments_fingerprint(&one), comments_fingerprint(&same));
        assert_ne!(comments_fingerprint(&one), comments_fingerprint(&fewer));
    }

    #[test]
    fn a_comments_blob_carries_its_version_and_its_records_verbatim() {
        let record = serde_json::json!({
            "kind": "comment",
            "actor": "did:dht:someone",
            "subject": "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a",
            "version": "bafkreiabc",
            "createdAt": "2026-08-22T12:00:00.000Z",
            "body": "worth saying",
            "sig": "AAAA",
        });
        let json = serde_json::to_string(&CommentsDoc {
            version: COMMENTS_DOC_VERSION,
            comments: vec![record.clone()],
        })
        .unwrap();
        let back: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(back["version"], COMMENTS_DOC_VERSION);
        assert_eq!(back["comments"][0], record);
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

    /// A packet as large as a real one gets: a chunked Sia share URL, a namespace id, and
    /// a full complement of endpoints each carrying a relay URL.
    fn worst_case_records(endpoints: usize) -> Vec<pin_pkarr::TxtRecord> {
        // A Sia share URL with its encryption-key fragment — the longest thing published.
        let item_url = format!(
            "sia://sia.storage/objects/{}/shared?sv=253402214400&sig={}#encryption_key={}",
            "a".repeat(64),
            "b".repeat(96),
            "c".repeat(64)
        );
        let set: Vec<crate::InstanceAddr> = (0..endpoints)
            .map(|i| crate::InstanceAddr {
                node_id: format!("{i:0>64}"),
                relay: Some("https://use1-1.relay.n0.iroh.link./".into()),
            })
            .collect();

        let mut records = pin_pkarr::chunk_txt(DIR_PREFIX, &item_url);
        records.push(pin_pkarr::TxtRecord {
            name: NS_PREFIX.to_string(),
            value: "d".repeat(64),
        });
        records.extend(pin_pkarr::chunk_txt(
            IROH_PREFIX,
            &crate::encode_endpoints(&set),
        ));
        records
    }

    #[test]
    fn a_full_packet_fits_inside_the_dht_record_limit() {
        // THE constraint on `MAX_ENDPOINTS`, measured rather than estimated. A BEP44
        // value is capped at 1000 bytes and `build_packet` refuses to sign past it, so
        // getting this wrong means an identity silently stops publishing its coordinates
        // the moment it has one device too many.
        let packet = pin_pkarr::build_packet(&[7u8; 32], &worst_case_records(MAX_ENDPOINTS))
            .expect("a full packet must still sign");
        let size = packet.encoded_packet().len();
        assert!(size <= 1000, "packet is {size} bytes");
    }

    #[test]
    fn the_endpoint_cap_is_what_keeps_it_fitting() {
        // Paired with the test above so the cap reads as a measured limit rather than a
        // number someone picked: enough more endpoints and the packet genuinely stops
        // signing, which is what `MAX_ENDPOINTS` exists to stay under.
        let over = pin_pkarr::build_packet(&[7u8; 32], &worst_case_records(MAX_ENDPOINTS + 6));
        assert!(over.is_err(), "the cap should be the binding constraint");
    }

    fn outcome(published: bool, dialable: usize, empty: bool) -> Result<IdentityOutcome, String> {
        Ok(IdentityOutcome {
            uploaded: false,
            published,
            endpoints: if dialable > 0 { dialable } else { 1 },
            dialable,
            empty,
            comments_uploaded: false,
            bodies: Default::default(),
        })
    }

    #[test]
    fn a_pass_that_published_something_dialable_settles() {
        assert!(settled(&outcome(true, 1, false)));
    }

    #[test]
    fn a_failed_pass_retries_rather_than_settling() {
        // THE one that cost a first-run knock. This loop's first pass fires before the
        // frontend has written settings, so `no settings record yet` is the ordinary
        // opening state — and settling on it meant a fresh identity published nothing at
        // all for half an hour, so nobody could resolve it, dial it, or knock at it.
        assert!(!settled(&Err("no settings record yet".to_string())));
    }

    #[test]
    fn an_identity_with_nothing_to_advertise_yet_retries() {
        // Otherwise creating your first channel would leave you unfindable until the next
        // half-hour boundary.
        assert!(!settled(&outcome(false, 0, true)));
    }

    #[test]
    fn a_packet_with_no_dialable_endpoint_retries() {
        // Published, but every endpoint names itself without saying where it is — which a
        // peer skips, so this identity is advertised and unreachable at the same time.
        assert!(!settled(&outcome(true, 0, false)));
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
