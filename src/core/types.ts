export const CHANNEL_MANIFEST_VERSION = 1
export const SUBSCRIPTIONS_VERSION = 1

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

export type Subscriptions = {
  version: typeof SUBSCRIPTIONS_VERSION
  subscribed: SubscriptionRef[]
}
