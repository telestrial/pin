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
}

export type ChannelCover = {
  itemURL: string
  mimeType: string
  contentHash?: string
}

export type ChannelManifest = {
  version: typeof CHANNEL_MANIFEST_VERSION
  name: string
  description: string
  authorPubkey: string
  authorATProtoDID: string
  publishedAt: string
  coverArt?: ChannelCover
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
