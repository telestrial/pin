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
//! The manifest crosses this crate as an opaque JSON string. Nothing here reads a field
//! of it — not even the version, which the caller checks — so modelling the type would
//! mean a second definition of a rich nested shape with nothing to use it. JSON is not a
//! choice at this layer regardless: it is already the plaintext inside every manifest
//! sealed on Sia, so it is what must be produced to stay readable.

const POINTER_PREFIX: &str = "_c";

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

/// Seal a manifest under K, upload it, and sign a pointer to it under K's locator key.
///
/// Ordering is the correctness property: the bytes are on Sia before the pointer names
/// them, so a reader who resolves the new pointer always finds something behind it.
pub async fn publish(
    sia: &pin_sia::Session,
    channel_key: &[u8; 32],
    manifest_json: &str,
) -> Result<Published, String> {
    let sealed = pin_crypto::encrypt(channel_key, manifest_json.as_bytes())?;
    let uploaded = sia.upload_item(sealed.into_bytes(), None).await?;

    let seed = pin_derive::channel_locator_seed(channel_key);
    let locator_key = pin_pkarr::public_key_from_seed(&seed)?;
    pin_pkarr::publish(
        &seed,
        &pin_pkarr::chunk_txt(POINTER_PREFIX, &uploaded.item_url),
    )
    .await?;

    Ok(Published {
        locator_key,
        object_id: uploaded.id,
        item_url: uploaded.item_url,
    })
}

/// Re-sign a channel's CURRENT pointer to refresh its TTL, without minting a new object.
///
/// The URL is passed in rather than resolved first, and that is deliberate: resolving
/// could read a stale value back from a lagging relay, and re-signing THAT with a fresh
/// timestamp would bury the real current pointer. The author already knows their own
/// pointer; a keep-alive should never learn it from the network.
pub async fn republish_pointer(channel_key: &[u8; 32], item_url: &str) -> Result<(), String> {
    let seed = pin_derive::channel_locator_seed(channel_key);
    pin_pkarr::publish(&seed, &pin_pkarr::chunk_txt(POINTER_PREFIX, item_url)).await
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
    let seed = pin_derive::channel_locator_seed(channel_key);
    let locator_key = pin_pkarr::public_key_from_seed(&seed)?;
    let records = pin_pkarr::resolve(&locator_key).await?;

    let item_url = pin_pkarr::rejoin_txt(&records, POINTER_PREFIX);
    if item_url.is_empty() {
        return Ok(None);
    }

    let ciphertext = sia.download_item(&item_url).await?;
    let blob = String::from_utf8(ciphertext).map_err(|_| "manifest blob is not UTF-8")?;
    Ok(Some(Resolved {
        manifest_json: open_blob(channel_key, &blob)?,
        blob,
    }))
}

/// Open a sealed manifest blob with K, returning its JSON.
///
/// Public because a subscribed channel's CACHED copy is the same blob, and it has to
/// decode through this exact path rather than a parallel one.
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
