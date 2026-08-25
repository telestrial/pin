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

/// A portal to a post published somewhere else, circulated in one of this identity's
/// channels.
///
/// A reference, never a copy. The item a reader sees is whatever the source author
/// currently publishes, so an edit shows through — and a retraction shows through as a
/// gap. That asymmetry is deliberate: continuing to KEEP something its author pulled is
/// what a library is for, and continuing to BROADCAST it is not.
///
/// Addressed by `(did_dht, channel_id, published_at)`, which is this codebase's
/// logical-post identity — `edit_item` preserves `published_at` while rewriting every
/// byte-level field, so the address survives an edit for the same reason drift detection,
/// pin dedup and the engagement subject all key on the same pair.
///
/// Carries no key and no object ID, because it carries no bytes: the read capability
/// comes from the source author's own directory, which is what makes a repost revocable
/// by the person reposted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RepostRef {
    /// The source author's did:dht — the identity whose directory holds the channel's key.
    #[serde(rename = "didDht")]
    pub did_dht: String,
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The source item's publish time, which is its identity within that channel.
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    /// When it was circulated here. What it sorts by in this channel, and distinct from
    /// the original's own `published_at`, which is what it sorts by in its own.
    #[serde(rename = "repostedAt")]
    pub reposted_at: String,
    /// The source channel's name as it read when this was made. A display cache so a row
    /// renders before the portal resolves, never preferred over what a resolve returns.
    #[serde(rename = "cachedName", skip_serializing_if = "Option::is_none")]
    pub cached_name: Option<String>,
    /// Which COMMENT on that post this circulates, when it circulates a comment rather than
    /// the post itself.
    ///
    /// A struct rather than two loose optional fields, so "names a comment" stays one fact
    /// the type can hold rather than two that could disagree — the same reason a repost is
    /// its own array instead of a `type` on `ItemRef`.
    ///
    /// Absent on every portal already published, and omitted when absent, so nothing in
    /// anyone's manifest serializes differently than it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<CommentPortal>,
}

/// Which comment a portal circulates, by the pair that IS its identity.
///
/// Not by any coordinate the host assigns. A comment's subject is derived from who wrote it
/// and when, precisely so nobody can reassign it — re-including a removed comment therefore
/// restores it at the same address, which is what makes a portal to one retryable where a
/// portal to a retracted POST is permanent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentPortal {
    /// The commenter's did:dht.
    pub actor: String,
    /// When they say they wrote it — signed, and half of the comment's identity.
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Everything that says WHICH thing a portal points at, with nothing about this copy of it.
///
/// Its own type because two places have to agree on it exactly: what makes two portals the
/// same, and what removing one names. They disagreed for a while by construction — removal
/// took the post triple as loose arguments — and a comment portal is where that would first
/// have bitten, since removing a comment's portal would have taken the post's with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortalAddress {
    #[serde(rename = "didDht")]
    pub did_dht: String,
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<CommentPortal>,
}

impl RepostRef {
    /// What this portal points at, dropping what is about this copy of it.
    pub fn address(&self) -> PortalAddress {
        PortalAddress {
            did_dht: self.did_dht.clone(),
            channel_id: self.channel_id.clone(),
            published_at: self.published_at.clone(),
            comment: self.comment.clone(),
        }
    }
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
    /// Whether this channel takes comments.
    ///
    /// Here rather than in settings because a READER needs it: it decides whether a post
    /// offers somewhere to reply, and a reader holds the manifest and nothing else of the
    /// author's. It also means turning comments on is an ordinary channel edit, published
    /// the way a name change is.
    ///
    /// Absent reads as OFF, which is what keeps the design principles honest rather than
    /// contradicted: a calm channel is one with comments off, and every channel that
    /// existed before this field is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comments: Option<bool>,
    pub items: Vec<ItemRef>,
    /// Posts from elsewhere this channel circulates. A sibling array rather than a
    /// variant of `ItemRef`, because a portal has none of what an item is made of — no
    /// `item_url`, no type, no bytes — and widening `ItemRef` to hold it would loosen the
    /// one type every transform here depends on being complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reposts: Option<Vec<RepostRef>>,
}

// --- making and changing a channel ----------------------------------------------
//
// Both take images that are ALREADY stored, as `ChannelImage` references. Storing bytes
// is the caller's job, and deliberately so: it needs a connected Sia session, and which
// session that is differs by where the code runs. Keeping it out means these two stay
// pure — no session, no network, nothing to fork by platform — and a caller composes
// "store the bytes, then build the manifest" in the two steps it actually is.

/// Everything a new channel is made of. Images arrive already stored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct NewChannel {
    pub name: String,
    pub description: String,
    /// Whether the channel takes comments. Absent means the default a new channel gets,
    /// which is ON — a channel created now is created in a product that has them.
    pub comments: Option<bool>,
    /// Sticky at creation, defaulting to public. A public channel can't later be
    /// obscured: the follow edges pointing at it would become orphan pointers.
    pub visibility: Option<ChannelVisibility>,
    /// The author's Sia identity, as `ed25519:<hex>`.
    #[serde(rename = "authorPubkey")]
    pub author_pubkey: String,
    /// The author's self-sovereign did:dht, so a reader can reach their directory with
    /// no atproto in the path.
    #[serde(rename = "authorDidDht")]
    pub author_did_dht: Option<String>,
    pub avatar: Option<ChannelImage>,
    pub cover: Option<ChannelImage>,
}

/// Build the manifest a new channel starts life as: its identity, and no items yet.
///
/// The channel's key isn't here, because the manifest never holds it — the key is the
/// capability that finds and opens this, and it travels separately by design.
pub fn create_channel(new: NewChannel, now: &str) -> ChannelManifest {
    ChannelManifest {
        version: CHANNEL_MANIFEST_VERSION,
        name: new.name,
        description: new.description,
        author_pubkey: new.author_pubkey,
        author_did_dht: new.author_did_dht,
        published_at: now.to_string(),
        visibility: Some(new.visibility.unwrap_or(ChannelVisibility::Public)),
        avatar: new.avatar,
        cover: new.cover,
        language: None,
        comments: Some(new.comments.unwrap_or(true)),
        items: Vec::new(),
        reposts: None,
    }
}

/// What's changing about a channel. An absent field is left alone; the `remove_*` flags
/// are how a caller says "none" rather than "unchanged", which an absent field can't
/// distinguish.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChannelPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    /// A replacement image, already stored. Ignored when the matching `remove_*` is set.
    pub avatar: Option<ChannelImage>,
    pub cover: Option<ChannelImage>,
    pub remove_avatar: bool,
    pub remove_cover: bool,
    /// Whether the channel takes comments. Absent leaves it as it stands, like every other
    /// field here — an author editing a name is not deciding anything about comments.
    pub comments: Option<bool>,
}

/// An edited channel, plus the images the edit left behind.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditedChannel {
    pub manifest: ChannelManifest,
    /// URLs of images a replace or a remove orphaned. Reference-safe with no refcount
    /// check needed: per-object Sia encryption gives every upload its own object, so an
    /// old avatar is never the same bytes as anything else.
    #[serde(rename = "reclaimURLs")]
    pub reclaim_urls: Vec<String>,
}

/// Apply a patch to a channel's details.
pub fn edit_channel(current: &ChannelManifest, patch: ChannelPatch, now: &str) -> EditedChannel {
    let mut reclaim_urls = Vec::new();
    let mut settle = |remove: bool,
                      replacement: Option<ChannelImage>,
                      existing: Option<ChannelImage>|
     -> Option<ChannelImage> {
        if remove {
            if let Some(old) = &existing {
                reclaim_urls.push(old.item_url.clone());
            }
            return None;
        }
        match replacement {
            Some(new) => {
                if let Some(old) = &existing {
                    reclaim_urls.push(old.item_url.clone());
                }
                Some(new)
            }
            None => existing,
        }
    };

    let avatar = settle(patch.remove_avatar, patch.avatar, current.avatar.clone());
    let cover = settle(patch.remove_cover, patch.cover, current.cover.clone());

    EditedChannel {
        manifest: ChannelManifest {
            name: patch.name.unwrap_or_else(|| current.name.clone()),
            description: patch
                .description
                .unwrap_or_else(|| current.description.clone()),
            avatar,
            cover,
            published_at: now.to_string(),
            comments: patch.comments.or(current.comments),
            ..current.clone()
        },
        reclaim_urls,
    }
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

// The three result shapes below serialize straight across the boundary to the caller
// that journals the cleanup, so their field names are the names that caller reads —
// `orphanedObjectIDs`, not the `orphanedObjectIds` a camelCase derivation would give.

/// A transform that removed something: the next manifest, plus the object IDs whose
/// bytes nothing surviving still references.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pruned {
    pub manifest: ChannelManifest,
    #[serde(rename = "orphanedObjectIDs")]
    pub orphaned_object_ids: Vec<String>,
}

/// A transform that rewrote one item in place.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rewritten {
    pub manifest: ChannelManifest,
    pub item: ItemRef,
    #[serde(rename = "orphanedObjectIDs")]
    pub orphaned_object_ids: Vec<String>,
}

/// Everything a retracted channel leaves behind: byte objects to delete, and the
/// image URLs whose objects the caller resolves and deletes alongside them.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Retracted {
    #[serde(rename = "objectIDs")]
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

/// Circulate somebody else's post in this channel.
///
/// Idempotent in the way the gesture is: a channel already carrying this portal keeps the
/// one it has, `reposted_at` included, so a repeated click can't quietly move the post in
/// the channel's ordering. Same reason an endorsement keeps the moment it was made.
pub fn add_repost(current: &ChannelManifest, repost: RepostRef, now: &str) -> ChannelManifest {
    let mut manifest = current.clone();
    manifest.published_at = now.to_string();
    let reposts = manifest.reposts.get_or_insert_with(Vec::new);
    if !reposts.iter().any(|r| same_repost(r, &repost)) {
        reposts.insert(0, repost);
    }
    manifest
}

/// Stop circulating something here. Nothing to reclaim: a portal never held bytes.
///
/// Takes the whole address, comment included, so removing a comment's portal leaves the
/// post's alone and the other way round. The two can legitimately sit side by side — you can
/// circulate a post and something somebody said under it.
pub fn remove_repost(
    current: &ChannelManifest,
    address: &PortalAddress,
    now: &str,
) -> ChannelManifest {
    let mut manifest = current.clone();
    manifest.published_at = now.to_string();
    if let Some(reposts) = manifest.reposts.as_mut() {
        reposts.retain(|r| &r.address() != address);
        // Absent rather than empty, so a channel that never reposted and one that stopped
        // serialize the same. A manifest is compared for change by stringify-equality.
        if reposts.is_empty() {
            manifest.reposts = None;
        }
    }
    manifest
}

/// Whether two portals name the same thing. The address is what identifies it; `reposted_at`
/// and the cached name are about this copy of it.
fn same_repost(a: &RepostRef, b: &RepostRef) -> bool {
    a.address() == b.address()
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UploadedItem {
    pub id: String,
    #[serde(rename = "itemURL")]
    pub item_url: String,
    #[serde(rename = "byteSize")]
    pub byte_size: u64,
    #[serde(rename = "contentHash")]
    pub content_hash: String,
}

/// Everything about an item that isn't decided by the upload. Every field defaults, so
/// a caller sends only what it has — the composer's payload carries more than this
/// (the bytes themselves, the unresolved attachment sources) and none of that survives
/// to the manifest.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ItemDraft {
    #[serde(rename = "type")]
    pub type_: Option<ItemType>,
    pub title: String,
    pub summary: Option<String>,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "durationMs")]
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
            comments: None,
            items,
            reposts: None,
        }
    }

    fn repost_at(published_at: &str, reposted_at: &str) -> RepostRef {
        RepostRef {
            did_dht: "did:dht:source".to_string(),
            channel_id: "srcchan".to_string(),
            published_at: published_at.to_string(),
            reposted_at: reposted_at.to_string(),
            cached_name: Some("Their channel".to_string()),
            comment: None,
        }
    }

    /// The same portal, pointed at one comment on that post rather than the post.
    fn repost_of_comment(published_at: &str, actor: &str, created_at: &str) -> RepostRef {
        RepostRef {
            comment: Some(CommentPortal {
                actor: actor.to_string(),
                created_at: created_at.to_string(),
            }),
            ..repost_at(published_at, published_at)
        }
    }

    fn address_of(published_at: &str) -> PortalAddress {
        PortalAddress {
            did_dht: "did:dht:source".to_string(),
            channel_id: "srcchan".to_string(),
            published_at: published_at.to_string(),
            comment: None,
        }
    }

    fn repost(published_at: &str) -> RepostRef {
        repost_at(published_at, NOW)
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
    fn a_new_channel_takes_comments_and_an_old_one_does_not() {
        // Absent reads as off, so every channel that existed before the field is a channel
        // with comments off — which is what keeps the calm shape available rather than
        // contradicted. A channel created now is created in a product that has them.
        let fresh = create_channel(
            NewChannel {
                name: "New".into(),
                ..Default::default()
            },
            EARLIER,
        );
        assert_eq!(fresh.comments, Some(true));

        let legacy = manifest(Vec::new());
        assert_eq!(legacy.comments, None);

        // And a creator who says no gets no.
        let quiet = create_channel(
            NewChannel {
                name: "Quiet".into(),
                comments: Some(false),
                ..Default::default()
            },
            EARLIER,
        );
        assert_eq!(quiet.comments, Some(false));
    }

    #[test]
    fn editing_a_name_decides_nothing_about_comments() {
        // An absent patch field leaves what stands, like every other field here.
        let mut current = manifest(Vec::new());
        current.comments = Some(true);
        let renamed = edit_channel(
            &current,
            ChannelPatch {
                name: Some("Renamed".into()),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(renamed.manifest.comments, Some(true));

        let switched = edit_channel(
            &current,
            ChannelPatch {
                comments: Some(false),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(switched.manifest.comments, Some(false));
        // And the switch alone leaves the name alone.
        assert_eq!(switched.manifest.name, current.name);
    }

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
        m.comments = Some(true);
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
                "comments",
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
    fn transform_results_carry_the_names_the_caller_reads() {
        fn keys(v: &Value) -> Vec<&str> {
            let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
            k.sort_unstable();
            k
        }
        let base = manifest(vec![item("a", vec![])]);

        let pruned = delete_item(&base, "a", &HashSet::new(), NOW);
        assert_eq!(
            keys(&serde_json::to_value(&pruned).unwrap()),
            ["manifest", "orphanedObjectIDs"]
        );

        let rewritten = edit_item(&base, "a", item("b", vec![]), &[], NOW).unwrap();
        assert_eq!(
            keys(&serde_json::to_value(&rewritten).unwrap()),
            ["item", "manifest", "orphanedObjectIDs"]
        );

        let retracted = enumerate_retract(Some(&base), &HashSet::new());
        assert_eq!(
            keys(&serde_json::to_value(&retracted).unwrap()),
            ["objectIDs", "urls"]
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

    // --- making and changing a channel ------------------------------------------

    fn image(url: &str) -> ChannelImage {
        ChannelImage {
            item_url: url.to_string(),
            mime_type: "image/png".to_string(),
            content_hash: None,
            byte_size: None,
        }
    }

    #[test]
    fn a_new_channel_starts_public_with_no_items() {
        let m = create_channel(
            NewChannel {
                name: "Mine".into(),
                description: "Words".into(),
                author_pubkey: "ed25519:aa".into(),
                author_did_dht: Some("did:dht:abc".into()),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(m.version, CHANNEL_MANIFEST_VERSION);
        assert!(m.items.is_empty());
        assert_eq!(m.visibility, Some(ChannelVisibility::Public));
        assert_eq!(m.published_at, NOW);
        assert!(m.avatar.is_none());
    }

    #[test]
    fn a_new_channel_can_be_obscure() {
        let m = create_channel(
            NewChannel {
                visibility: Some(ChannelVisibility::Obscure),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(m.visibility, Some(ChannelVisibility::Obscure));
    }

    #[test]
    fn an_edit_changes_only_what_the_patch_names() {
        let before = manifest(vec![item("a", vec![])]);
        let out = edit_channel(
            &before,
            ChannelPatch {
                name: Some("After".into()),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(out.manifest.name, "After");
        // Untouched, not blanked — an absent field means "unchanged".
        assert_eq!(out.manifest.description, before.description);
        assert_eq!(out.manifest.author_did_dht, before.author_did_dht);
        assert_eq!(out.manifest.items.len(), 1);
        assert_eq!(out.manifest.published_at, NOW);
        assert!(out.reclaim_urls.is_empty());
    }

    #[test]
    fn replacing_an_image_reports_the_one_it_replaced() {
        let mut before = manifest(vec![]);
        before.avatar = Some(image("sia://old"));
        let out = edit_channel(
            &before,
            ChannelPatch {
                avatar: Some(image("sia://new")),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(out.manifest.avatar.unwrap().item_url, "sia://new");
        assert_eq!(out.reclaim_urls, ["sia://old"]);
    }

    #[test]
    fn removing_an_image_drops_it_and_reports_it() {
        let mut before = manifest(vec![]);
        before.avatar = Some(image("sia://old-avatar"));
        before.cover = Some(image("sia://keep-cover"));
        let out = edit_channel(
            &before,
            ChannelPatch {
                remove_avatar: true,
                ..Default::default()
            },
            NOW,
        );
        assert!(out.manifest.avatar.is_none());
        // The cover wasn't named, so it survives untouched and isn't reclaimed.
        assert_eq!(out.manifest.cover.unwrap().item_url, "sia://keep-cover");
        assert_eq!(out.reclaim_urls, ["sia://old-avatar"]);
    }

    #[test]
    fn a_remove_beats_a_replacement_for_the_same_image() {
        // Contradictory input, but it has to resolve one way: remove wins, and the old
        // image is still reported. The replacement's bytes are the caller's to deal with
        // — they stored them before asking for this.
        let mut before = manifest(vec![]);
        before.avatar = Some(image("sia://old"));
        let out = edit_channel(
            &before,
            ChannelPatch {
                avatar: Some(image("sia://new")),
                remove_avatar: true,
                ..Default::default()
            },
            NOW,
        );
        assert!(out.manifest.avatar.is_none());
        assert_eq!(out.reclaim_urls, ["sia://old"]);
    }

    #[test]
    fn removing_an_image_that_was_never_set_reports_nothing() {
        let out = edit_channel(
            &manifest(vec![]),
            ChannelPatch {
                remove_avatar: true,
                remove_cover: true,
                ..Default::default()
            },
            NOW,
        );
        assert!(out.reclaim_urls.is_empty());
    }

    #[test]
    fn the_edit_result_carries_the_name_the_caller_reads() {
        fn keys(v: &Value) -> Vec<&str> {
            let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
            k.sort_unstable();
            k
        }
        let out = edit_channel(&manifest(vec![]), ChannelPatch::default(), NOW);
        assert_eq!(
            keys(&serde_json::to_value(&out).unwrap()),
            ["manifest", "reclaimURLs"]
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

    // --- reposts ------------------------------------------------------------------

    #[test]
    fn a_portal_carries_the_names_the_frontend_reads() {
        let v: Value =
            serde_json::from_str(&serde_json::to_string(&repost(EARLIER)).unwrap()).unwrap();
        let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        k.sort_unstable();
        assert_eq!(
            k,
            [
                "cachedName",
                "channelID",
                "didDht",
                "publishedAt",
                "repostedAt"
            ]
        );
    }

    #[test]
    fn a_channel_with_no_reposts_omits_the_field() {
        // Absent, not null and not []: a manifest is compared for change by
        // stringify-equality, so an empty array where the other side wrote nothing
        // would read as a change on every pass.
        let json = serde_json::to_string(&manifest(vec![])).unwrap();
        assert!(!json.contains("reposts"));
    }

    #[test]
    fn a_portal_round_trips_through_json_unchanged() {
        let before = repost(EARLIER);
        let after: RepostRef =
            serde_json::from_str(&serde_json::to_string(&before).unwrap()).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn reposting_puts_the_portal_first_and_bumps_the_manifest() {
        let before = manifest(vec![]);
        let after = add_repost(&before, repost(EARLIER), NOW);
        let reposts = after.reposts.as_ref().unwrap();
        assert_eq!(reposts.len(), 1);
        assert_eq!(reposts[0].published_at, EARLIER);
        assert_eq!(after.published_at, NOW);
    }

    #[test]
    fn reposting_the_same_post_twice_keeps_the_first_one() {
        // The gesture is a checkbox, so a repeat is a no-op the user believes they made.
        // Replacing would move the post in this channel's ordering behind their back.
        let first = add_repost(&manifest(vec![]), repost_at(EARLIER, EARLIER), EARLIER);
        let mut again = repost_at(EARLIER, NOW);
        again.cached_name = Some("Renamed".to_string());
        let after = add_repost(&first, again, NOW);

        let reposts = after.reposts.as_ref().unwrap();
        assert_eq!(reposts.len(), 1);
        assert_eq!(reposts[0].reposted_at, EARLIER);
    }

    #[test]
    fn two_posts_from_one_channel_are_two_portals() {
        // The address is the whole triple, so the same source channel can be reposted
        // more than once.
        let first = add_repost(&manifest(vec![]), repost_at(EARLIER, EARLIER), EARLIER);
        let after = add_repost(&first, repost_at(NOW, NOW), NOW);
        assert_eq!(after.reposts.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn removing_a_portal_leaves_the_others() {
        let a = add_repost(&manifest(vec![]), repost_at(EARLIER, EARLIER), EARLIER);
        let b = add_repost(&a, repost_at(NOW, NOW), NOW);
        let after = remove_repost(&b, &address_of(EARLIER), NOW);

        let reposts = after.reposts.as_ref().unwrap();
        assert_eq!(reposts.len(), 1);
        assert_eq!(reposts[0].published_at, NOW);
    }

    #[test]
    fn removing_the_last_portal_leaves_the_field_absent() {
        let before = add_repost(&manifest(vec![]), repost_at(EARLIER, EARLIER), EARLIER);
        let after = remove_repost(&before, &address_of(EARLIER), NOW);
        assert!(after.reposts.is_none());
        assert!(!serde_json::to_string(&after).unwrap().contains("reposts"));
    }

    #[test]
    fn removing_a_portal_that_is_not_there_changes_nothing_but_the_stamp() {
        let before = add_repost(&manifest(vec![]), repost_at(EARLIER, EARLIER), EARLIER);
        let after = remove_repost(
            &before,
            &PortalAddress {
                did_dht: "did:dht:someone-else".into(),
                ..address_of(EARLIER)
            },
            NOW,
        );
        assert_eq!(after.reposts, before.reposts);
        assert_eq!(after.published_at, NOW);
    }

    #[test]
    fn a_post_and_a_comment_on_it_are_two_portals() {
        // The whole reason the address grew a field. Under the old triple these were the
        // same portal, so circulating something said under a post you had already reposted
        // would have been silently dropped as a duplicate.
        let with_post = add_repost(&manifest(vec![]), repost_at(NOW, NOW), NOW);
        let with_both = add_repost(
            &with_post,
            repost_of_comment(NOW, "did:dht:bob", "2026-08-24T09:00:00.000Z"),
            NOW,
        );
        assert_eq!(with_both.reposts.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn two_comments_on_one_post_are_two_portals() {
        let one = add_repost(
            &manifest(vec![]),
            repost_of_comment(NOW, "did:dht:bob", "2026-08-24T09:00:00.000Z"),
            NOW,
        );
        let two = add_repost(
            &one,
            repost_of_comment(NOW, "did:dht:bob", "2026-08-24T10:00:00.000Z"),
            NOW,
        );
        assert_eq!(two.reposts.as_ref().unwrap().len(), 2);

        // And re-circulating one already carried still changes nothing, comment or not.
        let again = add_repost(
            &two,
            repost_of_comment(NOW, "did:dht:bob", "2026-08-24T09:00:00.000Z"),
            NOW,
        );
        assert_eq!(again.reposts.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn removing_a_comments_portal_leaves_its_posts_alone() {
        // The failure the shared address type exists to prevent, in the direction that
        // loses something: stopping circulating a remark must not stop circulating the post
        // it was made under.
        let with_post = add_repost(&manifest(vec![]), repost_at(NOW, NOW), NOW);
        let both = add_repost(
            &with_post,
            repost_of_comment(NOW, "did:dht:bob", "2026-08-24T09:00:00.000Z"),
            NOW,
        );

        let after = remove_repost(
            &both,
            &PortalAddress {
                comment: Some(CommentPortal {
                    actor: "did:dht:bob".into(),
                    created_at: "2026-08-24T09:00:00.000Z".into(),
                }),
                ..address_of(NOW)
            },
            NOW,
        );
        let left = after.reposts.as_ref().unwrap();
        assert_eq!(left.len(), 1);
        assert!(left[0].comment.is_none());

        // And the other way: removing the post's portal leaves the comment's.
        let after = remove_repost(&both, &address_of(NOW), NOW);
        let left = after.reposts.as_ref().unwrap();
        assert_eq!(left.len(), 1);
        assert!(left[0].comment.is_some());
    }

    #[test]
    fn a_portal_naming_no_comment_serializes_as_it_always_did() {
        // Every portal already published carries no comment, and the field is omitted when
        // absent — so nothing in anybody's manifest reads differently than it did. A
        // manifest is compared for change by stringify-equality, so a field appearing as
        // null would read as an edit forever.
        let wire = serde_json::to_string(&repost_at(NOW, NOW)).unwrap();
        assert!(!wire.contains("comment"), "{wire}");

        let with = serde_json::to_string(&repost_of_comment(
            NOW,
            "did:dht:bob",
            "2026-08-24T09:00:00.000Z",
        ))
        .unwrap();
        assert!(
            with.contains(r#""comment":{"actor":"did:dht:bob","createdAt":"#),
            "{with}"
        );
    }

    #[test]
    fn a_portal_holds_no_bytes_to_reclaim() {
        // The property the whole reference model rests on. A retract enumerates what a
        // channel was paying to store, and a portal never paid for anything.
        let before = add_repost(&manifest(vec![]), repost_at(EARLIER, EARLIER), EARLIER);
        let out = enumerate_retract(Some(&before), &HashSet::new());
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
