//! Publishing and resolving a channel through its K-derived pkarr locator.
//!
//! The shape, and why it is this shape: a channel's manifest is sealed into an object
//! (see `object`: a head under K, a body under the content key C) and uploaded to Sia,
//! and a pointer to that object is signed onto the DHT under a key derived from K. So K
//! locates, and decrypts whatever the head lets it — hand someone K and they can find the
//! channel and read what its head allows; hand them nothing and they cannot even discover
//! it exists, because the locator key is unreachable without K.
//!
//! That last property is what makes obscure channels obscure, and it is why the locator
//! is per-channel rather than a single index per author: iroh-docs' read capability is
//! whole-namespace, so one shared index would leak every channel a person has.
//!
//! A channel publishes TWO artifacts this way, each with its own K-derived key: the
//! manifest (what the author wrote) and the tallies (what its readers endorsed). Same
//! shape for the same reason — a count should be exactly as reachable as the channel it
//! counts, no more and no less — so an unlisted channel's engagement stays unlisted
//! with no special case anywhere.
//!
//! Both payloads cross this crate as an opaque JSON string. Nothing here reads a field
//! of either — not even the version, which the caller checks — so modelling the types
//! would mean a second definition of a rich nested shape with nothing to use it. JSON is
//! not a choice at this layer regardless: it is already the plaintext inside every blob
//! sealed on Sia, so it is what must be produced to stay readable.

pub mod band;
pub mod invite;
mod object;
pub mod tree;

pub use object::{
    content_key, fingerprint, head_epoch, open, open_members, open_with, seal, seal_members,
    ContentKey, Kind, Opened, Sealing, Signer,
};

/// How an author seals a channel anyone holding K may read: C derived from the AppKey at
/// the initial epoch, and carried in the head.
///
/// Derived rather than stored, so every device holding the recovery phrase seals under the
/// same C with nothing to keep in step.
pub fn author_sealing<'a>(app_key: &[u8; 32], channel_key: &'a [u8; 32]) -> Sealing<'a> {
    author_sealing_at(app_key, channel_key, pin_derive::INITIAL_EPOCH, false)
}

/// How an author seals their own channel at an epoch: C derived for that epoch, and carried
/// in the head unless only the channel's members may read it.
///
/// A members-only channel's epoch is its member tree's, which moves with every removal, so
/// it is the caller's to supply; a channel anyone holding K may read has no tree and stays
/// at the initial epoch.
pub fn author_sealing_at<'a>(
    app_key: &[u8; 32],
    channel_key: &'a [u8; 32],
    epoch: u32,
    members_only: bool,
) -> Sealing<'a> {
    let channel_id = pin_crypto::channel_id(channel_key);
    Sealing {
        channel_key,
        content: ContentKey {
            epoch,
            key: pin_derive::channel_content_key(app_key, &channel_id, epoch),
        },
        publish_read_key: !members_only,
        signer: pin_derive::did_dht_seed(app_key),
    }
}

/// Open an object of the author's own channel, whatever epoch it was sealed at, answering
/// with its payload and the content key it opened with.
///
/// The author derives every epoch's content key, so an object sealed before a rotation
/// opens as readily as one sealed after, read key in its head or not. Verified against the
/// author's own did like any other read.
pub fn open_as_author(
    app_key: &[u8; 32],
    channel_key: &[u8; 32],
    blob: &str,
    kind: Kind,
) -> Result<(Vec<u8>, ContentKey), String> {
    let did = format!(
        "did:dht:{}",
        pin_pkarr::public_key_from_seed(&pin_derive::did_dht_seed(app_key))?
    );
    let signer = Signer::Author(&did);
    let epoch = object::head_epoch(channel_key, blob, kind, signer)?;
    let content = ContentKey {
        epoch,
        key: pin_derive::channel_content_key(app_key, &pin_crypto::channel_id(channel_key), epoch),
    };
    let payload = object::open_with(channel_key, blob, &content, kind, signer)?;
    Ok((payload, content))
}

/// The manifest pointer's TXT prefix.
const POINTER_PREFIX: &str = "_c";
/// The tallies pointer's TXT prefix. The two artifacts live under different pkarr keys,
/// so a shared name would be safe — distinct anyway, because a record that says what it
/// holds is worth more than one byte saved.
const TALLIES_PREFIX: &str = "_e";
/// The TXT prefix a channel's conversations pointer is chunked under.
///
/// Distinct from every other prefix even though each pointer lives under its own pkarr key,
/// so a packet's records name one thing whichever key it was found beneath.
const CONVERSATIONS_PREFIX: &str = "_v";
/// The TXT prefix the pointer to a channel's member tree is chunked under.
const MEMBERS_PREFIX: &str = "_m";

/// Where a published manifest ended up.
///
/// `object_id` is what the caller reclaims when superseding a generation — the pointer
/// takes seconds to propagate, so the previous object has to outlive the publish.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub locator_key: String,
    pub object_id: String,
    /// Named explicitly: `camelCase` would emit `itemUrl`, and the frontend spells
    /// acronyms in full. Same reason pin-sia's descriptor says so.
    #[serde(rename = "itemURL")]
    pub item_url: String,
    /// The sealed object exactly as uploaded, so a caller recording a copy records these
    /// bytes rather than sealing a second time under a fresh nonce.
    pub blob: String,
}

/// A resolved channel: the manifest, plus the exact blob it was sealed in.
///
/// The blob comes back so a caller can cache it VERBATIM. Re-sealing would produce a
/// different nonce and so a different blob for identical content, and a cached copy has
/// to decrypt through the same path as a fresh resolve — one decode, not two.
///
/// It is a String rather than bytes because that is what it is: the Sia object holds the
/// base64 envelope as text.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub manifest_json: String,
    pub blob: String,
    /// The content key the manifest was sealed under — what opens the channel's other
    /// artifacts too.
    #[serde(skip)]
    pub content: ContentKey,
}

/// Which of a channel's published artifacts a pointer names: the pkarr key it is signed
/// under, and the TXT prefix it is written at.
///
/// The two travel together because they are only ever used together, and a mismatched
/// pair is the quiet failure mode — publishing under the manifest's key with the
/// tallies' prefix would sign a perfectly valid record that no reader ever looks for.
struct Pointer {
    seed: [u8; 32],
    prefix: &'static str,
    /// What the object behind it is, which the object's signature covers.
    kind: Kind,
}

/// Where a channel's manifest is advertised.
fn manifest_pointer(channel_key: &[u8; 32]) -> Pointer {
    Pointer {
        seed: pin_derive::channel_locator_seed(channel_key),
        prefix: POINTER_PREFIX,
        kind: Kind::Manifest,
    }
}

/// Where a channel's tallies are advertised.
fn tallies_pointer(channel_key: &[u8; 32]) -> Pointer {
    Pointer {
        seed: pin_derive::engagement_locator_seed(channel_key),
        prefix: TALLIES_PREFIX,
        kind: Kind::Tallies,
    }
}

fn conversations_pointer(channel_key: &[u8; 32]) -> Pointer {
    Pointer {
        seed: pin_derive::conversation_locator_seed(channel_key),
        prefix: CONVERSATIONS_PREFIX,
        kind: Kind::Conversations,
    }
}

/// Where the top of a channel's member tree is advertised.
fn members_pointer(channel_key: &[u8; 32]) -> Pointer {
    Pointer {
        seed: pin_derive::members_locator_seed(channel_key),
        prefix: MEMBERS_PREFIX,
        kind: Kind::Members,
    }
}

/// Seal a payload into an object, upload it, and sign a pointer to it.
///
/// Ordering is the correctness property: the bytes are on Sia before the pointer names
/// them, so a reader who resolves the new pointer always finds something behind it. It
/// lives here once rather than per artifact, so a second published thing cannot get
/// that ordering wrong in its own way.
async fn seal_and_point(
    sia: &pin_sia::Session,
    sealing: &Sealing<'_>,
    pointer: Pointer,
    payload_json: &str,
) -> Result<Published, String> {
    let sealed = object::seal(sealing, pointer.kind, payload_json.as_bytes())?;
    let uploaded = sia
        .upload_item(sealed.clone().into_bytes(), None, None)
        .await?;

    let locator_key = pin_pkarr::public_key_from_seed(&pointer.seed)?;
    pin_pkarr::publish(
        &pointer.seed,
        &pin_pkarr::chunk_txt(pointer.prefix, &uploaded.item_url),
    )
    .await?;

    Ok(Published {
        locator_key,
        object_id: uploaded.id,
        item_url: uploaded.item_url,
        blob: sealed,
    })
}

/// Re-sign a pointer at its current value, refreshing its TTL without minting an object.
async fn repoint(pointer: Pointer, item_url: &str) -> Result<(), String> {
    pin_pkarr::publish(
        &pointer.seed,
        &pin_pkarr::chunk_txt(pointer.prefix, item_url),
    )
    .await
}

/// The URL a pointer currently names, or `None` when nothing is published under it.
async fn resolve_pointer(pointer: Pointer) -> Result<Option<String>, String> {
    let locator_key = pin_pkarr::public_key_from_seed(&pointer.seed)?;
    let records = pin_pkarr::resolve(&locator_key).await?;

    let item_url = pin_pkarr::rejoin_txt(&records, pointer.prefix);
    if item_url.is_empty() {
        return Ok(None);
    }
    Ok(Some(item_url))
}

/// Seal a manifest, upload it, and sign a pointer to it under K's locator key.
pub async fn publish(
    sia: &pin_sia::Session,
    sealing: &Sealing<'_>,
    manifest_json: &str,
) -> Result<Published, String> {
    seal_and_point(
        sia,
        sealing,
        manifest_pointer(sealing.channel_key),
        manifest_json,
    )
    .await
}

/// Re-sign a channel's CURRENT pointer to refresh its TTL, without minting a new object.
///
/// The URL is passed in rather than resolved first, and that is deliberate: resolving
/// could read a stale value back from a lagging relay, and re-signing THAT with a fresh
/// timestamp would bury the real current pointer. The author already knows their own
/// pointer; a keep-alive should never learn it from the network.
pub async fn republish_pointer(channel_key: &[u8; 32], item_url: &str) -> Result<(), String> {
    repoint(manifest_pointer(channel_key), item_url).await
}

/// Read a channel from K alone — no author handle, no index, nothing but the key.
///
/// `Ok(None)` means the locator resolved to nothing, which is ordinary: the channel may
/// never have been published, or the record may have aged off the DHT. A failure to
/// decrypt or to reach Sia is an error, because those mean the pointer exists and
/// something behind it is wrong.
pub async fn resolve(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    signer: Signer<'_>,
) -> Result<Option<Resolved>, String> {
    let Some(item_url) = resolve_url(channel_key).await? else {
        return Ok(None);
    };
    fetch(sia, channel_key, &item_url, signer).await.map(Some)
}

/// Where a channel's manifest currently is, without fetching it.
///
/// Split out because the URL is a content address, so a caller holding the one it last
/// fetched can tell from this alone that nothing has moved — and skip the download, which
/// is the heavy half and the flaky one. `resolve` is the two composed, for callers with
/// nothing to compare against.
pub async fn resolve_url(channel_key: &[u8; 32]) -> Result<Option<String>, String> {
    resolve_pointer(manifest_pointer(channel_key)).await
}

/// Download and open the manifest at a URL already resolved for this channel.
pub async fn fetch(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    item_url: &str,
    signer: Signer<'_>,
) -> Result<Resolved, String> {
    let ciphertext = sia.download_item(item_url).await?;
    let blob = String::from_utf8(ciphertext).map_err(|_| "manifest blob is not UTF-8")?;
    let (manifest_json, content) = open_payload(channel_key, &blob, Kind::Manifest, signer)?;
    Ok(Resolved {
        manifest_json,
        blob,
        content,
    })
}

// --- tallies: the same shape, for what a channel's readers endorsed --------------

/// Seal a channel's tallies, upload them, and point the engagement key at them.
///
/// This is engagement's FLOOR rung. A tally also lives in the channel's iroh-docs
/// replica, which reaches live subscribers in seconds — but everyone who can read a
/// channel holds K and most of them hold no replica: a pasted subscribe URL, a public
/// channel opened from a directory, a subscriber whose author is asleep. Derived state
/// has to travel the same road as authored state or it reaches a fraction of its
/// audience.
pub async fn publish_tallies(
    sia: &pin_sia::Session,
    sealing: &Sealing<'_>,
    tallies_json: &str,
) -> Result<Published, String> {
    seal_and_point(
        sia,
        sealing,
        tallies_pointer(sealing.channel_key),
        tallies_json,
    )
    .await
}

/// Seal a channel's conversations, upload them, and point at them.
///
/// The floor for the words, as `publish_tallies` is for the numbers: everyone who can read
/// a channel holds K, and most of them hold no replica of its doc.
pub async fn publish_conversations(
    sia: &pin_sia::Session,
    sealing: &Sealing<'_>,
    conversations_json: &str,
) -> Result<Published, String> {
    seal_and_point(
        sia,
        sealing,
        conversations_pointer(sealing.channel_key),
        conversations_json,
    )
    .await
}

/// Re-sign a channel's CURRENT conversations pointer to refresh its TTL.
pub async fn republish_conversations_pointer(
    channel_key: &[u8; 32],
    item_url: &str,
) -> Result<(), String> {
    repoint(conversations_pointer(channel_key), item_url).await
}

/// Where a channel's conversations currently are, without fetching them.
pub async fn resolve_conversations_url(channel_key: &[u8; 32]) -> Result<Option<String>, String> {
    resolve_pointer(conversations_pointer(channel_key)).await
}

/// Re-sign a channel's CURRENT tallies pointer to refresh its TTL.
///
/// Takes the URL rather than resolving it first, for the same reason
/// [`republish_pointer`] does: re-signing a value read back off a lagging relay would
/// bury the real current pointer under a fresher timestamp.
pub async fn republish_tallies_pointer(
    channel_key: &[u8; 32],
    item_url: &str,
) -> Result<(), String> {
    repoint(tallies_pointer(channel_key), item_url).await
}

/// Where a channel's tallies currently are, without fetching them.
///
/// Split from the fetch like the manifest's is, and for the same payoff: the URL is a
/// content address, so a caller holding the one it last read can tell from this alone
/// that nothing has moved.
pub async fn resolve_tallies_url(channel_key: &[u8; 32]) -> Result<Option<String>, String> {
    resolve_pointer(tallies_pointer(channel_key)).await
}

/// Download and open a channel's tallies at a URL already resolved for it.
pub async fn fetch_tallies(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    item_url: &str,
    signer: Signer<'_>,
) -> Result<String, String> {
    let ciphertext = sia.download_item(item_url).await?;
    let blob = String::from_utf8(ciphertext).map_err(|_| "tallies blob is not UTF-8")?;
    open_payload(channel_key, &blob, Kind::Tallies, signer).map(|(json, _)| json)
}

/// Download and open a channel's conversations at a URL already resolved for it.
pub async fn fetch_conversations(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    item_url: &str,
    signer: Signer<'_>,
) -> Result<String, String> {
    let ciphertext = sia.download_item(item_url).await?;
    let blob = String::from_utf8(ciphertext).map_err(|_| "conversations blob is not UTF-8")?;
    open_payload(channel_key, &blob, Kind::Conversations, signer).map(|(json, _)| json)
}

// --- the member tree: how members of a channel only they may read find C ------------

/// Point a channel's member-tree key at its top band, already uploaded.
///
/// Takes the URL rather than uploading anything, unlike the other artifacts: the tree is
/// many objects, uploaded bottom tier first so each band can name the ones beneath it, and
/// only the top's URL goes in the pointer. Also the keep-alive, re-signing the URL the
/// author last published, for the reason [`republish_pointer`] takes its URL rather than
/// resolving it.
pub async fn point_members(channel_key: &[u8; 32], top_url: &str) -> Result<(), String> {
    pin_pkarr::publish(
        &members_pointer(channel_key).seed,
        &members_records(top_url),
    )
    .await
}

/// Where the top of a channel's member tree currently is, without fetching it.
pub async fn resolve_members_url(channel_key: &[u8; 32]) -> Result<Option<String>, String> {
    resolve_pointer(members_pointer(channel_key)).await
}

/// The pkarr key a channel's member-tree pointer is published under, for a caller that
/// resolves it by its own route.
pub fn members_locator_key(channel_key: &[u8; 32]) -> Result<String, String> {
    pin_pkarr::public_key_from_seed(&members_pointer(channel_key).seed)
}

/// The records a member-tree pointer to `top_url` publishes: what a test serving the
/// pointer by another route has to answer with, chunked exactly as the publish chunks it.
pub fn members_records(top_url: &str) -> Vec<pin_pkarr::TxtRecord> {
    pin_pkarr::chunk_txt(MEMBERS_PREFIX, top_url)
}

/// The top band's URL in a resolved member-tree packet, or `None` when it names none.
pub fn members_url_in(records: &[pin_pkarr::TxtRecord]) -> Option<String> {
    let url = pin_pkarr::rejoin_txt(records, MEMBERS_PREFIX);
    (!url.is_empty()).then_some(url)
}

/// Download and open one band of a channel's member tree, answering with the epoch it was
/// published at and the band.
pub async fn fetch_band(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    item_url: &str,
    signer: Signer<'_>,
) -> Result<(u32, band::Band), String> {
    let ciphertext = sia.download_item(item_url).await?;
    let blob = String::from_utf8(ciphertext).map_err(|_| "band blob is not UTF-8")?;
    band::Band::open(channel_key, &blob, signer)
}

/// Read a channel's tallies from K alone.
///
/// `Ok(None)` means nothing is published there, which is ordinary and common: a channel
/// nobody has endorsed yet has no tallies object at all. A reader shows no counts, which
/// is the same thing it shows for a count of zero.
pub async fn resolve_tallies(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    signer: Signer<'_>,
) -> Result<Option<String>, String> {
    let Some(item_url) = resolve_tallies_url(channel_key).await? else {
        return Ok(None);
    };
    fetch_tallies(sia, channel_key, &item_url, signer)
        .await
        .map(Some)
}

/// Open a sealed blob with K, returning its JSON.
///
/// Public because a subscribed channel's CACHED manifest is the same blob, and it has
/// to decode through this exact path rather than a parallel one. Shared with the
/// tallies fetch for the same reason: one seal, one open.
pub fn open_blob(channel_key: &[u8; 32], blob: &str, signer: Signer) -> Result<String, String> {
    open_payload(channel_key, blob, Kind::Manifest, signer).map(|(json, _)| json)
}

/// Open a sealed blob with K, returning its JSON and the content key it was sealed under.
fn open_payload(
    channel_key: &[u8; 32],
    blob: &str,
    kind: Kind,
    signer: Signer,
) -> Result<(String, ContentKey), String> {
    let opened = object::open(channel_key, blob, kind, signer)?;
    let json = String::from_utf8(opened.payload)
        .map_err(|_| "decrypted payload is not UTF-8".to_string())?;
    Ok((json, opened.content))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_members_only_channel_seals_without_a_read_key_at_its_epoch() {
        let app_key = [1u8; 32];
        let k = [7u8; 32];
        let sealing = super::author_sealing_at(&app_key, &k, 3, true);
        assert!(!sealing.publish_read_key);
        assert_eq!(sealing.content.epoch, 3);
        assert_eq!(
            sealing.content.key,
            pin_derive::channel_content_key(&app_key, &pin_crypto::channel_id(&k), 3)
        );
        let blob = super::seal(&sealing, super::Kind::Manifest, b"{}").unwrap();
        let did = format!(
            "did:dht:{}",
            pin_pkarr::public_key_from_seed(&pin_derive::did_dht_seed(&app_key)).unwrap()
        );
        // K alone opens nothing.
        assert!(super::open(
            &k,
            &blob,
            super::Kind::Manifest,
            super::Signer::Author(&did)
        )
        .is_err());
        // The public case is the initial epoch with the key in the head.
        let public = super::author_sealing(&app_key, &k);
        assert!(public.publish_read_key);
        assert_eq!(public.content.epoch, pin_derive::INITIAL_EPOCH);
    }

    #[test]
    fn the_author_opens_their_own_object_at_whatever_epoch_it_was_sealed() {
        let app_key = [1u8; 32];
        let k = [7u8; 32];
        for (epoch, members_only) in [(0, false), (0, true), (5, true)] {
            let sealing = super::author_sealing_at(&app_key, &k, epoch, members_only);
            let blob = super::seal(&sealing, super::Kind::Tallies, b"payload").unwrap();
            let (payload, content) =
                super::open_as_author(&app_key, &k, &blob, super::Kind::Tallies).unwrap();
            assert_eq!(payload, b"payload");
            assert_eq!(content, sealing.content);
        }
        // Somebody else's object, sealed under the same K, is not the author's.
        let theirs = super::author_sealing_at(&[2u8; 32], &k, 0, true);
        let blob = super::seal(&theirs, super::Kind::Tallies, b"payload").unwrap();
        assert!(super::open_as_author(&app_key, &k, &blob, super::Kind::Tallies).is_err());
    }

    #[test]
    fn a_members_pointer_reads_back_the_url_it_was_published_with() {
        let url = format!(
            "sia://sia.storage/objects/{}/shared#k={}",
            "a".repeat(64),
            "b".repeat(44)
        );
        assert_eq!(
            super::members_url_in(&super::members_records(&url)).as_deref(),
            Some(url.as_str())
        );
        assert_eq!(super::members_url_in(&[]), None);
        // Another artifact's records under the same key name no tree.
        assert_eq!(
            super::members_url_in(&pin_pkarr::chunk_txt(super::TALLIES_PREFIX, &url)),
            None
        );
    }

    #[test]
    fn a_channels_three_pointers_are_separate_records() {
        // Each is a pkarr record of its own, and a shared key would make publishing one
        // overwrite another: a conversation publish would take the manifest pointer with it,
        // and the channel would stop resolving for everybody.
        let k = [3u8; 32];
        let all = [
            super::manifest_pointer(&k),
            super::tallies_pointer(&k),
            super::conversations_pointer(&k),
        ];
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i].seed, all[j].seed, "pointers {i} and {j} share a key");
                assert_ne!(
                    all[i].prefix, all[j].prefix,
                    "pointers {i} and {j} share a prefix"
                );
            }
        }
    }

    use super::*;

    // These descriptors cross to the frontend as JSON and are deserialized straight into
    // its own types, so a field NAME is load-bearing and invisible to both compilers —
    // the same hazard that had the browser reading an undefined `itemURL` off pin-sia's
    // upload descriptor. Assert the key set rather than trust rename_all with an acronym.
    #[test]
    fn descriptor_field_names_match_what_the_frontend_reads() {
        let keys = |v: serde_json::Value| {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };

        let published = serde_json::to_value(Published {
            locator_key: "k".into(),
            object_id: "id".into(),
            item_url: "url".into(),
            blob: "b".into(),
        })
        .unwrap();
        assert_eq!(
            keys(published),
            ["blob", "itemURL", "locatorKey", "objectId"]
        );

        let resolved = serde_json::to_value(Resolved {
            manifest_json: "{}".into(),
            blob: "b".into(),
            content: ContentKey {
                epoch: 0,
                key: [0u8; 32],
            },
        })
        .unwrap();
        assert_eq!(keys(resolved), ["blob", "manifestJson"]);
    }

    // A channel advertises two artifacts, and getting the pair wrong fails QUIETLY:
    // one shared key would have each publish bury the other, and the right key with
    // the wrong prefix signs a perfectly valid record no reader ever looks for.
    // Asserted through the same constructors the publish and resolve paths call, so
    // this catches a mis-wiring here rather than restating pin-derive's own test.
    #[test]
    fn a_channels_two_artifacts_are_advertised_separately() {
        let key = [7u8; 32];
        let manifest = manifest_pointer(&key);
        let tallies = tallies_pointer(&key);
        assert_ne!(manifest.seed, tallies.seed);
        assert_ne!(manifest.prefix, tallies.prefix);
        // And the keys a reader actually resolves, not only the seeds behind them.
        assert_ne!(
            pin_pkarr::public_key_from_seed(&manifest.seed).unwrap(),
            pin_pkarr::public_key_from_seed(&tallies.seed).unwrap()
        );
    }

    // The seal and the open are one round trip through pin-crypto, and `open_blob` is
    // the path BOTH a fresh resolve and a cached blob take.
    #[test]
    fn open_blob_reads_what_publish_would_have_sealed() {
        let key = [7u8; 32];
        let manifest = r#"{"version":1,"name":"Test","items":[]}"#;
        let sealing = Sealing {
            channel_key: &key,
            content: ContentKey {
                epoch: 0,
                key: [9u8; 32],
            },
            publish_read_key: true,
            signer: [1u8; 32],
        };
        let author = pin_pkarr::public_key_from_seed(&[1u8; 32]).unwrap();
        let sealed = object::seal(&sealing, Kind::Manifest, manifest.as_bytes()).unwrap();
        assert_eq!(
            open_blob(&key, &sealed, Signer::Author(&author)).unwrap(),
            manifest
        );
        assert_eq!(
            open_payload(&key, &sealed, Kind::Manifest, Signer::Author(&author))
                .unwrap()
                .1,
            sealing.content
        );

        let mut wrong = key;
        wrong[0] ^= 1;
        assert!(open_blob(&wrong, &sealed, Signer::Author(&author)).is_err());
    }

    #[test]
    fn an_author_seals_under_the_content_key_derived_from_their_app_key() {
        // Not under K: a channel whose body opened with K could never stop a finder from
        // reading it, which is the whole of what the split is for.
        let app_key = [1u8; 32];
        let k = [7u8; 32];
        let sealing = author_sealing(&app_key, &k);
        let channel_id = pin_crypto::channel_id(&k);
        assert_eq!(
            sealing.content,
            ContentKey {
                epoch: pin_derive::INITIAL_EPOCH,
                key: pin_derive::channel_content_key(
                    &app_key,
                    &channel_id,
                    pin_derive::INITIAL_EPOCH
                ),
            }
        );
        assert_ne!(sealing.content.key, k);
        assert!(sealing.publish_read_key);

        // And what it seals opens with K alone, through the head.
        let blob = seal(&sealing, Kind::Manifest, b"{}").unwrap();
        let author = pin_pkarr::public_key_from_seed(&pin_derive::did_dht_seed(&app_key)).unwrap();
        assert_eq!(
            open_payload(&k, &blob, Kind::Manifest, Signer::Author(&author))
                .unwrap()
                .1,
            sealing.content
        );
    }
}
