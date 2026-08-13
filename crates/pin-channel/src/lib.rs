//! Publishing and resolving a channel through its K-derived pkarr locator.
//!
//! The shape, and why it is this shape: a channel's manifest is sealed under K and
//! uploaded to Sia as its own object, and a pointer to that object is signed onto the
//! DHT under a key ALSO derived from K. So K both locates and decrypts, which is the
//! same capability shape as a Sia share URL — hand someone K and they can read the
//! channel; hand them nothing and they cannot even discover it exists, because the
//! locator key is unreachable without K.
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

/// The manifest pointer's TXT prefix.
const POINTER_PREFIX: &str = "_c";
/// The tallies pointer's TXT prefix. The two artifacts live under different pkarr keys,
/// so a shared name would be safe — distinct anyway, because a record that says what it
/// holds is worth more than one byte saved.
const TALLIES_PREFIX: &str = "_e";

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
}

/// Where a channel's manifest is advertised.
fn manifest_pointer(channel_key: &[u8; 32]) -> Pointer {
    Pointer {
        seed: pin_derive::channel_locator_seed(channel_key),
        prefix: POINTER_PREFIX,
    }
}

/// Where a channel's tallies are advertised.
fn tallies_pointer(channel_key: &[u8; 32]) -> Pointer {
    Pointer {
        seed: pin_derive::engagement_locator_seed(channel_key),
        prefix: TALLIES_PREFIX,
    }
}

/// Seal a payload under K, upload it, and sign a pointer to it.
///
/// Ordering is the correctness property: the bytes are on Sia before the pointer names
/// them, so a reader who resolves the new pointer always finds something behind it. It
/// lives here once rather than per artifact, so a second published thing cannot get
/// that ordering wrong in its own way.
async fn seal_and_point(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    pointer: Pointer,
    payload_json: &str,
) -> Result<Published, String> {
    let sealed = pin_crypto::encrypt(channel_key, payload_json.as_bytes())?;
    let uploaded = sia.upload_item(sealed.into_bytes(), None).await?;

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

/// Seal a manifest under K, upload it, and sign a pointer to it under K's locator key.
pub async fn publish(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    manifest_json: &str,
) -> Result<Published, String> {
    seal_and_point(
        sia,
        channel_key,
        manifest_pointer(channel_key),
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
) -> Result<Option<Resolved>, String> {
    let Some(item_url) = resolve_url(channel_key).await? else {
        return Ok(None);
    };
    fetch(sia, channel_key, &item_url).await.map(Some)
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
) -> Result<Resolved, String> {
    let ciphertext = sia.download_item(item_url).await?;
    let blob = String::from_utf8(ciphertext).map_err(|_| "manifest blob is not UTF-8")?;
    Ok(Resolved {
        manifest_json: open_blob(channel_key, &blob)?,
        blob,
    })
}

// --- tallies: the same shape, for what a channel's readers endorsed --------------

/// Seal a channel's tallies under K, upload them, and point the engagement key at them.
///
/// This is engagement's FLOOR rung. A tally also lives in the channel's iroh-docs
/// replica, which reaches live subscribers in seconds — but everyone who can read a
/// channel holds K and most of them hold no replica: a pasted subscribe URL, a public
/// channel opened from a directory, a subscriber whose author is asleep. Derived state
/// has to travel the same road as authored state or it reaches a fraction of its
/// audience.
pub async fn publish_tallies(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    tallies_json: &str,
) -> Result<Published, String> {
    seal_and_point(sia, channel_key, tallies_pointer(channel_key), tallies_json).await
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
) -> Result<String, String> {
    let ciphertext = sia.download_item(item_url).await?;
    let blob = String::from_utf8(ciphertext).map_err(|_| "tallies blob is not UTF-8")?;
    open_blob(channel_key, &blob)
}

/// Read a channel's tallies from K alone.
///
/// `Ok(None)` means nothing is published there, which is ordinary and common: a channel
/// nobody has endorsed yet has no tallies object at all. A reader shows no counts, which
/// is the same thing it shows for a count of zero.
pub async fn resolve_tallies(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
) -> Result<Option<String>, String> {
    let Some(item_url) = resolve_tallies_url(channel_key).await? else {
        return Ok(None);
    };
    fetch_tallies(sia, channel_key, &item_url).await.map(Some)
}

/// Open a sealed blob with K, returning its JSON.
///
/// Public because a subscribed channel's CACHED manifest is the same blob, and it has
/// to decode through this exact path rather than a parallel one. Shared with the
/// tallies fetch for the same reason: one seal, one open.
pub fn open_blob(channel_key: &[u8; 32], blob: &str) -> Result<String, String> {
    let plaintext = pin_crypto::decrypt(channel_key, blob)?;
    String::from_utf8(plaintext).map_err(|_| "decrypted manifest is not UTF-8".to_string())
}

#[cfg(test)]
mod tests {
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
        })
        .unwrap();
        assert_eq!(keys(published), ["itemURL", "locatorKey", "objectId"]);

        let resolved = serde_json::to_value(Resolved {
            manifest_json: "{}".into(),
            blob: "b".into(),
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
        let sealed = pin_crypto::encrypt(&key, manifest.as_bytes()).unwrap();
        assert_eq!(open_blob(&key, &sealed).unwrap(), manifest);

        let mut wrong = key;
        wrong[0] ^= 1;
        assert!(open_blob(&wrong, &sealed).is_err());
    }
}
