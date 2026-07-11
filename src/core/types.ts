export const CHANNEL_MANIFEST_VERSION = 1
export const SUBSCRIPTIONS_VERSION = 1

// Visual theme — a named style bundle synced identity-wide via the settings
// record. 'rounded' is the gentle-radius default; 'corners' squares everything
// off. Lives in core so both the store and the settings serializer can name it.
export type ThemeMode = 'rounded' | 'corners'

export type ItemType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'app'

export type AttachmentRef = {
  url: string
  mimeType: string
  filename?: string
  byteSize: number
  // CIDv1 (raw codec, SHA-256) of the plaintext bytes. Optional for
  // back-compat with manifests written before this field existed; legacy
  // items still resolve via url.
  contentHash?: string
  // The publisher's Sia object ID. Each attachment is its own pinned
  // object; the orphan sweep needs this to keep the bytes alive in the
  // publisher's known set, and the repack runner uses it as the scope
  // ref. Optional for back-compat — legacy attachments resolve via
  // sharedObject(url).id().
  objectID?: string
}

// Pre-AttachmentRef-shape posts (slice 1, before url/mimeType were
// guaranteed) can arrive in manifests as bare strings or objects
// missing required fields. Anything that walks attachments has to
// gate on this — otherwise sharedObject(undefined) crashes the WASM
// bridge and the renderer / sweep / repack all bail.
export function isValidAttachment(a: unknown): a is AttachmentRef {
  return (
    typeof a === 'object' &&
    a !== null &&
    typeof (a as { url?: unknown }).url === 'string' &&
    typeof (a as { mimeType?: unknown }).mimeType === 'string'
  )
}

// A mention of a person, embedded in a facet feature. The DID is the canonical
// identity anchor (a non-unique @-name can't be resolved back to a person, so
// the DID has to travel with the mention). `handle` is a cached convenience for
// navigation/display fallback — same pattern as SubscriptionRef caching the
// handle beside the DID. The name the reader SEES is the literal body text under
// the facet's range (a snapshot of what the author picked), not re-resolved.
export type MentionFeature = {
  $type: 'pin.mention'
  did: string
  handle?: string
}

// A facet feature — a typed annotation over a byte range. A union of one member
// today; forward-compat for pin.itemLink / pin.tag / etc. Clients ignore
// feature types they don't understand.
export type FacetFeature = MentionFeature

// Bluesky-style facet: a byte range over an item's plaintext body carrying one
// or more features. Reach-independent (a mention stores a DID regardless of how
// far out the author found the person). Offsets are UTF-8 byte indices
// (TextEncoder), the Bluesky convention, so multibyte/emoji bodies stay correct.
export type Facet = {
  index: { byteStart: number; byteEnd: number }
  features: FacetFeature[]
}

export type ItemRef = {
  id: string
  itemURL: string
  type: ItemType
  title: string
  summary?: string
  publishedAt: string
  mimeType: string
  byteSize: number
  durationMs?: number
  filename?: string
  attachments?: AttachmentRef[]
  // Bluesky-style annotations over the plaintext body — mentions today,
  // pin.itemLink / pin.tag later. Optional: absent on posts written before
  // facets existed and on posts with no mentions.
  facets?: Facet[]
  // See AttachmentRef.contentHash. Stable across repack (which rewrites
  // id + itemURL but preserves plaintext bytes) and across encryption
  // regime changes.
  contentHash?: string
  // ISO 8601 timestamp of the most recent edit. Absent on original
  // publishes; set by editPost. publishedAt is preserved across edits
  // so chronology doesn't change; editedAt is the honest signal that
  // the post drifted from what readers may have pinned.
  editedAt?: string
}

// A channel image reference (avatar or cover banner). itemURL carries the
// Sia per-object key in its fragment; mimeType is stored because Sia
// metadata-via-share is publisher-private cross-account, so the reader needs
// it to render; contentHash is the CIDv1 cache key (stable across repack).
export type ChannelImage = {
  itemURL: string
  mimeType: string
  contentHash?: string
  // Plaintext byte size, for the storage-cost tooltip sum when a channel is
  // pinned and the MyStorage channel-chip rollup. Optional for back-compat —
  // legacy channel images predate the field and are omitted from those sums.
  byteSize?: number
}

// Whether a channel is publicly followable. Obscure channels are
// Watch-only: subscribers save (handle, channelID, K) locally; nothing
// public ties the follower to the channel. Public channels can be
// followed via a dev.sia.pin.subscription stand-off record under the
// follower's repo. Set at creation, sticky — a public channel can't
// later be obscured because existing Follow records would become orphan
// pointers, and going obscure means a new channel + migration.
export type ChannelVisibility = 'obscure' | 'public'

export type ChannelManifest = {
  version: typeof CHANNEL_MANIFEST_VERSION
  name: string
  description: string
  authorPubkey: string
  authorATProtoDID: string
  publishedAt: string
  // Absent on manifests written before this field existed; readers treat
  // missing as 'obscure' (the safer default — Follow is opt-in).
  visibility?: ChannelVisibility
  // avatar = round channel image; cover = wide banner. (Both optional; the
  // header falls back to a hash-derived mark / gradient when absent.)
  avatar?: ChannelImage
  cover?: ChannelImage
  language?: string
  items: ItemRef[]
}

export type SubscriptionRef = {
  authorHandle: string
  authorDID: string
  channelID: string // base32(sha256(K)).slice(0,16); ATProto rkey
  channelKey: string
  label?: string
  cachedName?: string
  addedAt: string
}

export type OwnedChannel = {
  channelID: string
  channelKey: string
  name: string
  createdAt: string
}

export type Subscriptions = {
  version: typeof SUBSCRIPTIONS_VERSION
  subscribed: SubscriptionRef[]
}
