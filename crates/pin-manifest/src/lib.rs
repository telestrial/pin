//! The channel manifest and the pure rules for changing it.
//!
//! A channel IS its manifest: the name and images a reader sees, and the ordered list
//! of items, each naming the Sia object that holds its bytes. Publishing, editing,
//! retracting and repacking are all transforms over this one structure — so this is
//! the Curator's data model, held here rather than borrowed back from a webview.
//!
//! Everything is pure. A transform takes the current manifest and returns the next one
//! together with the object IDs that fell out of reference; the caller supplies the
//! network (read the current manifest, commit the next one, journal the cleanup). That
//! split is what lets a browser tab and a desktop Curator run the same rules.
//!
//! ## Two properties the JSON has to keep
//!
//! **Absent, not null.** Optional fields skip serialization when empty, because the
//! JavaScript that wrote every manifest on the wire omits `undefined` keys rather than
//! emitting `null`. A manifest is compared for change by stringify-equality in the feed
//! and in the pull loop, so emitting `"summary": null` where the other side emits
//! nothing would read as "this changed" on every pass.
//!
//! **Field names are not derivable.** `itemURL` and `objectID` carry acronyms that
//! `rename_all = "camelCase"` gets wrong (`itemUrl`, `objectId`), and a name that
//! disagrees across the boundary is invisible to both compilers — it already shipped
//! once as an upload with no share URL. Every such field is renamed explicitly and the
//! full key set is asserted in the tests below.
//!
//! ## Deliberately strict
//!
//! Pre-schema manifests could carry attachments as bare strings, and the TypeScript
//! this replaces skipped them defensively. That tolerance is not carried over: an
//! attachment is a typed struct, so a manifest holding one of those legacy shapes fails
//! to parse rather than being partially read. That is a deliberate scope call, not an
//! oversight — nothing in the live data predates the schema.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const CHANNEL_MANIFEST_VERSION: u32 = 1;

/// What kind of thing an item is. Drives the composer, the renderer, and which
/// read page a click lands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    Text,
    Image,
    Audio,
    Video,
    File,
    App,
}

/// Whether a channel is publicly followable. Set at creation and sticky: a public
/// channel can't later be obscured, because the follow edges pointing at it would
/// become orphan pointers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelVisibility {
    Obscure,
    Public,
}

/// A file carried alongside an item's body. Its bytes are their own pinned Sia
/// object, which is why `object_id` matters: the reference-safe cleanup below can
/// only protect bytes it can name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachmentRef {
    pub url: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(rename = "byteSize")]
    pub byte_size: u64,
    /// CIDv1 of the plaintext bytes — the cache key, stable across a repack that
    /// rewrites the URL.
    #[serde(rename = "contentHash", skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// The publisher's Sia object ID. Without it an attachment can't be protected
    /// from, or enumerated for, byte cleanup.
    #[serde(rename = "objectID", skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

/// A mention of a person, anchored by DID because a non-unique @-name can't be
/// resolved back to anyone. The name a reader sees is the body text under the
/// facet's range — a snapshot of what the author picked, never re-resolved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MentionFeature {
    #[serde(rename = "$type")]
    pub type_: String,
    pub did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
}

/// UTF-8 byte offsets into an item's plaintext body — the Bluesky convention, so
/// multibyte bodies stay correct.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FacetIndex {
    #[serde(rename = "byteStart")]
    pub byte_start: u32,
    #[serde(rename = "byteEnd")]
    pub byte_end: u32,
}

/// A typed annotation over a byte range of the body. One feature type today;
/// clients ignore feature types they don't understand, so this grows without a
/// schema bump.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Facet {
    pub index: FacetIndex,
    pub features: Vec<MentionFeature>,
}

/// One published item. `id` is the Sia object holding its body; `published_at` is
/// its identity in time and is preserved across edits, so chronology doesn't move
/// when a post is corrected.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemRef {
    pub id: String,
    #[serde(rename = "itemURL")]
    pub item_url: String,
    #[serde(rename = "type")]
    pub type_: ItemType,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "byteSize")]
    pub byte_size: u64,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AttachmentRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facets: Option<Vec<Facet>>,
    #[serde(rename = "contentHash", skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// Set on edit. `published_at` is preserved across edits, so this is the honest
    /// signal that a post has drifted from whatever a reader pinned.
    #[serde(rename = "editedAt", skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
}

/// A channel's avatar or cover banner. `mime_type` is stored because Sia's
/// metadata-via-share is publisher-private, so a reader can't ask what these bytes
/// are — the manifest has to say.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelImage {
    #[serde(rename = "itemURL")]
    pub item_url: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "contentHash", skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(rename = "byteSize", skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<u64>,
}

/// The channel itself. `published_at` here is the manifest's own version marker —
/// it bumps on every mutation, which is what lets a reader tell a newer manifest
/// from an older one when two arrive by different routes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelManifest {
    pub version: u32,
    pub name: String,
    pub description: String,
    #[serde(rename = "authorPubkey")]
    pub author_pubkey: String,
    /// The author's self-sovereign did:dht — the identity a viewer resolves to reach
    /// their directory and build a follow edge, with no atproto in the path.
    #[serde(rename = "authorDidDht", skip_serializing_if = "Option::is_none")]
    pub author_did_dht: Option<String>,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<ChannelVisibility>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<ChannelImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<ChannelImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub items: Vec<ItemRef>,
}

// --- reference-safe cleanup ----------------------------------------------------
//
// Sia objects are content-addressed and shared: the same bytes can be reached from
// two of your posts, or from a post AND a standalone library pin. So a retract can
// only delete an object once nothing surviving still names it. Every transform below
// that removes something returns the objects that fell out of reference rather than
// deleting them, because deletion is a durable, retried action the caller journals.

/// Every object ID still reachable after a change: the manifest's own items and their
/// attachments, unioned with `external` — the caller's other-scope references (their
/// other channels' manifests and their pins). Anything outside this set is genuinely
/// unreferenced.
pub fn surviving_object_ids(
    manifest: &ChannelManifest,
    external: &HashSet<String>,
) -> HashSet<String> {
    let mut set = external.clone();
    for item in &manifest.items {
        set.insert(item.id.clone());
        for att in item.attachments.iter().flatten() {
            if let Some(id) = &att.object_id {
                set.insert(id.clone());
            }
        }
    }
    set
}

/// A transform that removed something: the next manifest, plus the object IDs whose
/// bytes nothing surviving still references.
#[derive(Debug, Clone, PartialEq)]
pub struct Pruned {
    pub manifest: ChannelManifest,
    pub orphaned_object_ids: Vec<String>,
}

/// A transform that rewrote one item in place.
#[derive(Debug, Clone, PartialEq)]
pub struct Rewritten {
    pub manifest: ChannelManifest,
    pub item: ItemRef,
    pub orphaned_object_ids: Vec<String>,
}

/// Everything a retracted channel leaves behind: byte objects to delete, and the
/// image URLs whose objects the caller resolves and deletes alongside them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Retracted {
    pub object_ids: Vec<String>,
    pub urls: Vec<String>,
}

// --- transforms ----------------------------------------------------------------
//
// Each takes `now` (an ISO 8601 timestamp) rather than reading the clock, for two
// reasons: `SystemTime::now()` panics on wasm32-unknown-unknown, and a transform that
// can't tell the time is one a test can pin exactly.

/// Add a newly published item to the front of the channel.
pub fn append_item(current: &ChannelManifest, item: ItemRef, now: &str) -> ChannelManifest {
    let mut manifest = current.clone();
    manifest.published_at = now.to_string();
    manifest.items.insert(0, item);
    manifest
}

/// Retract one published item. Its body and any attachments nothing else references
/// come back for cleanup; a file shared with another of your posts, or held by a
/// standalone library pin, is left alone. Subscribers who pinned it keep their copies
/// — those live in their own scope and this never reaches them.
pub fn delete_item(
    current: &ChannelManifest,
    item_id: &str,
    protected_object_ids: &HashSet<String>,
    now: &str,
) -> Pruned {
    let removed = current.items.iter().find(|i| i.id == item_id).cloned();

    let mut manifest = current.clone();
    manifest.published_at = now.to_string();
    manifest.items.retain(|i| i.id != item_id);

    let surviving = surviving_object_ids(&manifest, protected_object_ids);
    let mut orphaned_object_ids = Vec::new();
    if !surviving.contains(item_id) {
        orphaned_object_ids.push(item_id.to_string());
    }
    if let Some(removed) = &removed {
        for att in removed.attachments.iter().flatten() {
            if let Some(id) = &att.object_id {
                if !surviving.contains(id) {
                    orphaned_object_ids.push(id.clone());
                }
            }
        }
    }

    Pruned {
        manifest,
        orphaned_object_ids,
    }
}

/// Retract a single attachment from a published item — the file-level analog of
/// [`delete_item`]. The body and the other attachments are untouched, `published_at`
/// stays put so the item keeps its place, and `edited_at` records the drift.
pub fn remove_attachment(
    current: &ChannelManifest,
    item_id: &str,
    attachment_url: &str,
    protected_object_ids: &HashSet<String>,
    now: &str,
) -> Result<Rewritten, String> {
    let index = current
        .items
        .iter()
        .position(|i| i.id == item_id)
        .ok_or_else(|| "Item not found in channel".to_string())?;

    let removed = current.items[index]
        .attachments
        .iter()
        .flatten()
        .find(|a| a.url == attachment_url)
        .cloned();

    let mut item = current.items[index].clone();
    if let Some(attachments) = &mut item.attachments {
        attachments.retain(|a| a.url != attachment_url);
    }
    item.edited_at = Some(now.to_string());

    let mut manifest = current.clone();
    manifest.published_at = now.to_string();
    manifest.items[index] = item.clone();

    let surviving = surviving_object_ids(&manifest, protected_object_ids);
    let mut orphaned_object_ids = Vec::new();
    if let Some(id) = removed.as_ref().and_then(|a| a.object_id.as_ref()) {
        if !surviving.contains(id) {
            orphaned_object_ids.push(id.clone());
        }
    }

    Ok(Rewritten {
        manifest,
        item,
        orphaned_object_ids,
    })
}

/// Replace an item's content in place. The original `published_at` is carried over so
/// an edit doesn't move the post in the feed; the caller stamps `edited_at` on the
/// incoming item.
///
/// The old body and any removed attachments come back for cleanup **unfiltered** —
/// an edit uploads fresh bytes, so the outgoing object is this item's alone and can't
/// be shared with the item replacing it.
pub fn edit_item(
    current: &ChannelManifest,
    old_item_id: &str,
    new_item: ItemRef,
    removed_attachment_object_ids: &[String],
    now: &str,
) -> Result<Rewritten, String> {
    let index = current
        .items
        .iter()
        .position(|i| i.id == old_item_id)
        .ok_or_else(|| "Item not found in channel".to_string())?;

    let mut item = new_item;
    item.published_at = current.items[index].published_at.clone();

    let mut manifest = current.clone();
    manifest.published_at = now.to_string();
    manifest.items[index] = item.clone();

    let mut orphaned_object_ids = vec![old_item_id.to_string()];
    orphaned_object_ids.extend(removed_attachment_object_ids.iter().cloned());

    Ok(Rewritten {
        manifest,
        item,
        orphaned_object_ids,
    })
}

/// Enumerate everything a whole-channel retract leaves behind. Takes the channel's
/// current manifest, or `None` when the locator no longer resolves — a retract whose
/// target is already gone enumerates nothing and still succeeds, because the goal
/// ("this channel is gone") is met either way.
pub fn enumerate_retract(
    current: Option<&ChannelManifest>,
    protected_object_ids: &HashSet<String>,
) -> Retracted {
    let Some(current) = current else {
        return Retracted::default();
    };

    let mut object_ids = Vec::new();
    for item in &current.items {
        if !protected_object_ids.contains(&item.id) {
            object_ids.push(item.id.clone());
        }
        for att in item.attachments.iter().flatten() {
            if let Some(id) = &att.object_id {
                if !protected_object_ids.contains(id) {
                    object_ids.push(id.clone());
                }
            }
        }
    }

    let urls = [&current.avatar, &current.cover]
        .into_iter()
        .flatten()
        .map(|image| image.item_url.clone())
        .collect();

    Retracted { object_ids, urls }
}

/// What an upload hands back about the bytes it just stored.
#[derive(Debug, Clone, PartialEq)]
pub struct UploadedItem {
    pub id: String,
    pub item_url: String,
    pub byte_size: u64,
    pub content_hash: String,
}

/// Everything about an item that isn't decided by the upload.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ItemDraft {
    pub type_: Option<ItemType>,
    pub title: String,
    pub summary: Option<String>,
    pub mime_type: String,
    pub duration_ms: Option<u64>,
    pub filename: Option<String>,
    pub attachments: Option<Vec<AttachmentRef>>,
    pub facets: Option<Vec<Facet>>,
}

/// Shape an upload result and a draft into the item that goes in the manifest.
pub fn build_item_ref(uploaded: &UploadedItem, draft: ItemDraft, now: &str) -> ItemRef {
    ItemRef {
        id: uploaded.id.clone(),
        item_url: uploaded.item_url.clone(),
        type_: draft.type_.unwrap_or(ItemType::Text),
        title: draft.title,
        summary: draft.summary,
        published_at: now.to_string(),
        mime_type: draft.mime_type,
        byte_size: uploaded.byte_size,
        duration_ms: draft.duration_ms,
        filename: draft.filename,
        attachments: draft.attachments,
        facets: draft.facets,
        content_hash: Some(uploaded.content_hash.clone()),
        edited_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const NOW: &str = "2026-08-01T12:00:00.000Z";
    const EARLIER: &str = "2026-07-01T09:00:00.000Z";

    fn attachment(url: &str, object_id: Option<&str>) -> AttachmentRef {
        AttachmentRef {
            url: url.to_string(),
            mime_type: "image/png".to_string(),
            filename: Some("pic.png".to_string()),
            byte_size: 10,
            content_hash: Some("bafy-att".to_string()),
            object_id: object_id.map(str::to_string),
        }
    }

    fn item(id: &str, attachments: Vec<AttachmentRef>) -> ItemRef {
        ItemRef {
            id: id.to_string(),
            item_url: format!("sia://{id}"),
            type_: ItemType::Text,
            title: String::new(),
            summary: Some("body".to_string()),
            published_at: EARLIER.to_string(),
            mime_type: "text/markdown".to_string(),
            byte_size: 4,
            duration_ms: None,
            filename: None,
            attachments: if attachments.is_empty() {
                None
            } else {
                Some(attachments)
            },
            facets: None,
            content_hash: Some(format!("bafy-{id}")),
            edited_at: None,
        }
    }

    fn manifest(items: Vec<ItemRef>) -> ChannelManifest {
        ChannelManifest {
            version: CHANNEL_MANIFEST_VERSION,
            name: "Test".to_string(),
            description: "A channel".to_string(),
            author_pubkey: "ed25519:aa".to_string(),
            author_did_dht: Some("did:dht:abc".to_string()),
            published_at: EARLIER.to_string(),
            visibility: Some(ChannelVisibility::Public),
            avatar: None,
            cover: None,
            language: None,
            items,
        }
    }

    fn protect(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    // --- the wire shape ---------------------------------------------------------
    //
    // The one class of bug neither compiler can see: a field whose name disagrees
    // across the boundary. `itemURL` and `objectID` are the acronym-bearing names
    // camelCase derivation gets wrong, and this repo has already shipped an upload
    // whose share URL arrived under a name nothing read.

    #[test]
    fn field_names_match_what_the_frontend_reads() {
        let mut m = manifest(vec![item(
            "obj1",
            vec![attachment("sia://att", Some("att1"))],
        )]);
        m.avatar = Some(ChannelImage {
            item_url: "sia://avatar".to_string(),
            mime_type: "image/png".to_string(),
            content_hash: Some("bafy-avatar".to_string()),
            byte_size: Some(99),
        });
        let v: Value = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();

        // Sorted so the assertion states the key SET, independent of field order.
        fn keys(v: &Value) -> Vec<&str> {
            let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
            k.sort_unstable();
            k
        }

        assert_eq!(
            keys(&v),
            [
                "authorDidDht",
                "authorPubkey",
                "avatar",
                "description",
                "items",
                "name",
                "publishedAt",
                "version",
                "visibility",
            ]
        );
        assert_eq!(
            keys(&v["items"][0]),
            [
                "attachments",
                "byteSize",
                "contentHash",
                "id",
                "itemURL",
                "mimeType",
                "publishedAt",
                "summary",
                "title",
                "type",
            ]
        );
        assert_eq!(
            keys(&v["items"][0]["attachments"][0]),
            [
                "byteSize",
                "contentHash",
                "filename",
                "mimeType",
                "objectID",
                "url",
            ]
        );
        assert_eq!(
            keys(&v["avatar"]),
            ["byteSize", "contentHash", "itemURL", "mimeType"]
        );
    }

    #[test]
    fn absent_optional_fields_are_omitted_not_nulled() {
        // JavaScript's stringify drops undefined keys. A manifest is compared for
        // change by stringify-equality, so emitting an explicit null here would read
        // as "this changed" on every pass.
        let json = serde_json::to_string(&manifest(vec![item("obj1", vec![])])).unwrap();
        assert!(!json.contains("null"));
        assert!(!json.contains("cover"));
        assert!(!json.contains("language"));
        assert!(!json.contains("editedAt"));
    }

    #[test]
    fn an_item_round_trips_through_json_unchanged() {
        let before = item("obj1", vec![attachment("sia://att", Some("att1"))]);
        let after: ItemRef =
            serde_json::from_str(&serde_json::to_string(&before).unwrap()).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn item_type_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(ItemType::Image).unwrap(),
            json!("image")
        );
        assert_eq!(
            serde_json::from_value::<ItemType>(json!("app")).unwrap(),
            ItemType::App
        );
    }

    // --- append -----------------------------------------------------------------

    #[test]
    fn append_puts_the_new_item_first_and_bumps_the_manifest() {
        let before = manifest(vec![item("old", vec![])]);
        let after = append_item(&before, item("new", vec![]), NOW);
        assert_eq!(
            after.items.iter().map(|i| &i.id).collect::<Vec<_>>(),
            vec!["new", "old"]
        );
        assert_eq!(after.published_at, NOW);
        assert_eq!(after.name, before.name);
    }

    // --- delete -----------------------------------------------------------------

    #[test]
    fn deleting_an_item_frees_its_body_and_attachments() {
        let before = manifest(vec![
            item("keep", vec![]),
            item("drop", vec![attachment("sia://a", Some("att1"))]),
        ]);
        let out = delete_item(&before, "drop", &HashSet::new(), NOW);
        assert_eq!(
            out.manifest.items.iter().map(|i| &i.id).collect::<Vec<_>>(),
            vec!["keep"]
        );
        assert_eq!(out.orphaned_object_ids, vec!["drop", "att1"]);
        assert_eq!(out.manifest.published_at, NOW);
    }

    #[test]
    fn an_attachment_another_post_still_uses_is_not_freed() {
        // The same bytes reached from two posts: retracting one must not pull the
        // file out from under the other.
        let shared = attachment("sia://shared", Some("shared1"));
        let before = manifest(vec![
            item("keep", vec![shared.clone()]),
            item("drop", vec![shared]),
        ]);
        let out = delete_item(&before, "drop", &HashSet::new(), NOW);
        assert_eq!(out.orphaned_object_ids, vec!["drop"]);
    }

    #[test]
    fn an_object_referenced_outside_this_channel_is_not_freed() {
        // `protected` is the caller's other-scope references — their other channels
        // and their pins. A library pin on the same file keeps it alive.
        let before = manifest(vec![item(
            "drop",
            vec![attachment("sia://a", Some("att1"))],
        )]);
        let out = delete_item(&before, "drop", &protect(&["att1"]), NOW);
        assert_eq!(out.orphaned_object_ids, vec!["drop"]);
    }

    #[test]
    fn deleting_an_item_that_is_not_there_changes_nothing_but_the_stamp() {
        let before = manifest(vec![item("keep", vec![])]);
        let out = delete_item(&before, "ghost", &HashSet::new(), NOW);
        assert_eq!(out.manifest.items.len(), 1);
        // Nothing surviving names it, so it is reported — the caller's delete is
        // idempotent, and a stale id costs one no-op rather than a stuck retract.
        assert_eq!(out.orphaned_object_ids, vec!["ghost"]);
    }

    #[test]
    fn an_attachment_without_an_object_id_cannot_be_freed() {
        let before = manifest(vec![item("drop", vec![attachment("sia://a", None)])]);
        let out = delete_item(&before, "drop", &HashSet::new(), NOW);
        assert_eq!(out.orphaned_object_ids, vec!["drop"]);
    }

    // --- remove one attachment ---------------------------------------------------

    #[test]
    fn removing_an_attachment_keeps_the_post_in_place() {
        let before = manifest(vec![item(
            "post",
            vec![
                attachment("sia://a", Some("att1")),
                attachment("sia://b", Some("att2")),
            ],
        )]);
        let out = remove_attachment(&before, "post", "sia://a", &HashSet::new(), NOW).unwrap();
        assert_eq!(
            out.item
                .attachments
                .as_ref()
                .unwrap()
                .iter()
                .map(|a| &a.url)
                .collect::<Vec<_>>(),
            vec!["sia://b"]
        );
        assert_eq!(out.orphaned_object_ids, vec!["att1"]);
        // Chronology doesn't move; the edit is recorded separately.
        assert_eq!(out.item.published_at, EARLIER);
        assert_eq!(out.item.edited_at.as_deref(), Some(NOW));
        assert_eq!(out.manifest.published_at, NOW);
    }

    #[test]
    fn removing_an_attachment_a_sibling_post_shares_frees_nothing() {
        let shared = attachment("sia://shared", Some("shared1"));
        let before = manifest(vec![
            item("other", vec![shared.clone()]),
            item("post", vec![shared]),
        ]);
        let out = remove_attachment(&before, "post", "sia://shared", &HashSet::new(), NOW).unwrap();
        assert!(out.orphaned_object_ids.is_empty());
    }

    #[test]
    fn removing_an_attachment_from_a_missing_item_is_an_error() {
        let before = manifest(vec![item("post", vec![])]);
        assert!(remove_attachment(&before, "ghost", "sia://a", &HashSet::new(), NOW).is_err());
    }

    // --- edit --------------------------------------------------------------------

    #[test]
    fn editing_preserves_the_original_publish_time() {
        let before = manifest(vec![item("v1", vec![])]);
        let mut replacement = item("v2", vec![]);
        replacement.published_at = NOW.to_string(); // caller's value is overridden
        replacement.edited_at = Some(NOW.to_string());

        let out = edit_item(&before, "v1", replacement, &[], NOW).unwrap();
        assert_eq!(out.item.published_at, EARLIER);
        assert_eq!(out.item.id, "v2");
        assert_eq!(out.manifest.items.len(), 1);
        assert_eq!(out.manifest.published_at, NOW);
    }

    #[test]
    fn editing_frees_the_old_body_and_any_dropped_attachments() {
        let before = manifest(vec![item("v1", vec![])]);
        let out = edit_item(
            &before,
            "v1",
            item("v2", vec![]),
            &["gone1".to_string(), "gone2".to_string()],
            NOW,
        )
        .unwrap();
        assert_eq!(out.orphaned_object_ids, vec!["v1", "gone1", "gone2"]);
    }

    #[test]
    fn editing_an_item_that_is_not_there_is_an_error() {
        let before = manifest(vec![item("post", vec![])]);
        assert!(edit_item(&before, "ghost", item("v2", vec![]), &[], NOW).is_err());
    }

    // --- retract the channel ------------------------------------------------------

    #[test]
    fn retracting_enumerates_every_body_attachment_and_image() {
        let mut before = manifest(vec![
            item("a", vec![attachment("sia://x", Some("attx"))]),
            item("b", vec![]),
        ]);
        before.avatar = Some(ChannelImage {
            item_url: "sia://avatar".to_string(),
            mime_type: "image/png".to_string(),
            content_hash: None,
            byte_size: None,
        });
        before.cover = Some(ChannelImage {
            item_url: "sia://cover".to_string(),
            mime_type: "image/png".to_string(),
            content_hash: None,
            byte_size: None,
        });

        let out = enumerate_retract(Some(&before), &HashSet::new());
        assert_eq!(out.object_ids, vec!["a", "attx", "b"]);
        assert_eq!(out.urls, vec!["sia://avatar", "sia://cover"]);
    }

    #[test]
    fn retracting_skips_objects_referenced_elsewhere() {
        let before = manifest(vec![item("a", vec![attachment("sia://x", Some("attx"))])]);
        let out = enumerate_retract(Some(&before), &protect(&["attx"]));
        assert_eq!(out.object_ids, vec!["a"]);
    }

    #[test]
    fn retracting_a_channel_that_is_already_gone_enumerates_nothing() {
        let out = enumerate_retract(None, &HashSet::new());
        assert!(out.object_ids.is_empty());
        assert!(out.urls.is_empty());
    }

    // --- build --------------------------------------------------------------------

    // --- against the implementation this replaces -----------------------------------
    //
    // The vectors below are the literal output of the TypeScript transforms, captured by
    // running them under a frozen clock. Round-tripping our own output would pass while
    // disagreeing with the code actually in production about key order, about which
    // absent fields are omitted, and about exactly which objects a retract frees — and
    // manifests are compared for change by stringify-equality, so any of those would read
    // as a spurious edit forever after.

    const V_BASE: &str = r#"{"version":1,"name":"Test","description":"A channel","authorPubkey":"ed25519:aa","authorDidDht":"did:dht:abc","publishedAt":"2026-07-01T09:00:00.000Z","visibility":"public","items":[{"id":"keep","itemURL":"sia://keep","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"attachments":[{"url":"sia://shared","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"shared1"}],"contentHash":"bafy-keep"},{"id":"drop","itemURL":"sia://drop","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"attachments":[{"url":"sia://shared","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"shared1"},{"url":"sia://a","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"att1"}],"contentHash":"bafy-drop"}]}"#;

    const V_APPEND: &str = r#"{"version":1,"name":"Test","description":"A channel","authorPubkey":"ed25519:aa","authorDidDht":"did:dht:abc","publishedAt":"2026-08-01T12:00:00.000Z","visibility":"public","items":[{"id":"new","itemURL":"sia://new","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"contentHash":"bafy-new"},{"id":"keep","itemURL":"sia://keep","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"attachments":[{"url":"sia://shared","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"shared1"}],"contentHash":"bafy-keep"},{"id":"drop","itemURL":"sia://drop","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"attachments":[{"url":"sia://shared","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"shared1"},{"url":"sia://a","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"att1"}],"contentHash":"bafy-drop"}]}"#;

    const V_DELETE: &str = r#"{"version":1,"name":"Test","description":"A channel","authorPubkey":"ed25519:aa","authorDidDht":"did:dht:abc","publishedAt":"2026-08-01T12:00:00.000Z","visibility":"public","items":[{"id":"keep","itemURL":"sia://keep","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"attachments":[{"url":"sia://shared","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"shared1"}],"contentHash":"bafy-keep"}]}"#;

    const V_REMOVE_ATT: &str = r#"{"version":1,"name":"Test","description":"A channel","authorPubkey":"ed25519:aa","authorDidDht":"did:dht:abc","publishedAt":"2026-08-01T12:00:00.000Z","visibility":"public","items":[{"id":"keep","itemURL":"sia://keep","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"attachments":[{"url":"sia://shared","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"shared1"}],"contentHash":"bafy-keep"},{"id":"drop","itemURL":"sia://drop","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"attachments":[{"url":"sia://shared","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"shared1"}],"contentHash":"bafy-drop","editedAt":"2026-08-01T12:00:00.000Z"}]}"#;

    const V_EDIT: &str = r#"{"version":1,"name":"Test","description":"A channel","authorPubkey":"ed25519:aa","authorDidDht":"did:dht:abc","publishedAt":"2026-08-01T12:00:00.000Z","visibility":"public","items":[{"id":"keep","itemURL":"sia://keep","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"attachments":[{"url":"sia://shared","mimeType":"image/png","filename":"pic.png","byteSize":10,"contentHash":"bafy-att","objectID":"shared1"}],"contentHash":"bafy-keep"},{"id":"v2","itemURL":"sia://v2","type":"text","title":"","summary":"body","publishedAt":"2026-07-01T09:00:00.000Z","mimeType":"text/markdown","byteSize":4,"contentHash":"bafy-v2"}]}"#;

    const V_BUILT: &str = r#"{"id":"obj","itemURL":"sia://obj","type":"image","title":"A picture","publishedAt":"2026-08-01T12:00:00.000Z","mimeType":"image/png","byteSize":42,"contentHash":"bafy"}"#;

    fn ts_base() -> ChannelManifest {
        serde_json::from_str(V_BASE).unwrap()
    }

    #[test]
    fn a_manifest_written_by_the_typescript_round_trips_byte_for_byte() {
        assert_eq!(serde_json::to_string(&ts_base()).unwrap(), V_BASE);
    }

    #[test]
    fn append_matches_the_typescript_output() {
        let out = append_item(&ts_base(), item("new", vec![]), NOW);
        assert_eq!(serde_json::to_string(&out).unwrap(), V_APPEND);
    }

    #[test]
    fn delete_matches_the_typescript_output() {
        let out = delete_item(&ts_base(), "drop", &protect(&["keep"]), NOW);
        assert_eq!(serde_json::to_string(&out.manifest).unwrap(), V_DELETE);
        assert_eq!(out.orphaned_object_ids, vec!["drop", "att1"]);
    }

    #[test]
    fn remove_attachment_matches_the_typescript_output() {
        let out = remove_attachment(&ts_base(), "drop", "sia://a", &HashSet::new(), NOW).unwrap();
        assert_eq!(serde_json::to_string(&out.manifest).unwrap(), V_REMOVE_ATT);
        assert_eq!(out.orphaned_object_ids, vec!["att1"]);
    }

    #[test]
    fn edit_matches_the_typescript_output() {
        let out = edit_item(
            &ts_base(),
            "drop",
            item("v2", vec![]),
            &["gone1".to_string()],
            NOW,
        )
        .unwrap();
        assert_eq!(serde_json::to_string(&out.manifest).unwrap(), V_EDIT);
        assert_eq!(out.orphaned_object_ids, vec!["drop", "gone1"]);
    }

    #[test]
    fn retract_matches_the_typescript_output_including_its_duplicates() {
        // Two quirks captured from the original, both reproduced deliberately: an
        // attachment shared by two items is listed once per item, and `protected` is
        // checked against attachment IDs but only ever populated by the caller with
        // whole-item IDs. Neither is harmful — the caller's delete is idempotent and a
        // protected id is still skipped — but they are behaviour, not accident, and a
        // "tidier" port would silently change what gets freed.
        let out = enumerate_retract(Some(&ts_base()), &protect(&["keep"]));
        assert_eq!(out.object_ids, vec!["shared1", "drop", "shared1", "att1"]);
        assert!(out.urls.is_empty());
    }

    #[test]
    fn a_built_item_matches_the_typescript_output() {
        let uploaded = UploadedItem {
            id: "obj".to_string(),
            item_url: "sia://obj".to_string(),
            byte_size: 42,
            content_hash: "bafy".to_string(),
        };
        let draft = ItemDraft {
            type_: Some(ItemType::Image),
            title: "A picture".to_string(),
            mime_type: "image/png".to_string(),
            ..Default::default()
        };
        let built = build_item_ref(&uploaded, draft, NOW);
        assert_eq!(serde_json::to_string(&built).unwrap(), V_BUILT);
    }

    #[test]
    fn a_built_item_takes_its_bytes_from_the_upload_and_the_rest_from_the_draft() {
        let uploaded = UploadedItem {
            id: "obj".to_string(),
            item_url: "sia://obj".to_string(),
            byte_size: 42,
            content_hash: "bafy".to_string(),
        };
        let draft = ItemDraft {
            type_: Some(ItemType::Image),
            title: "A picture".to_string(),
            mime_type: "image/png".to_string(),
            ..Default::default()
        };
        let built = build_item_ref(&uploaded, draft, NOW);
        assert_eq!(built.id, "obj");
        assert_eq!(built.item_url, "sia://obj");
        assert_eq!(built.byte_size, 42);
        assert_eq!(built.content_hash.as_deref(), Some("bafy"));
        assert_eq!(built.type_, ItemType::Image);
        assert_eq!(built.published_at, NOW);
        assert!(built.edited_at.is_none());
    }
}
