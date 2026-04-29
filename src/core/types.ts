export const CHANNEL_MANIFEST_VERSION = 1
export const SUBSCRIPTIONS_VERSION = 1

export type ItemType = 'text' | 'image' | 'audio' | 'video'

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
}

export type ChannelManifest = {
  version: typeof CHANNEL_MANIFEST_VERSION
  name: string
  description: string
  authorPubkey: string
  authorATProtoDID: string
  publishedAt: string
  coverArtItemURL?: string
  language?: string
  items: ItemRef[]
}

export type SubscriptionRef = {
  authorHandle: string
  authorDID: string
  channelID: string         // base32(sha256(K)).slice(0,16); ATProto rkey
  channelKey: string
  label?: string
  cachedName?: string
  addedAt: string
}

export type Subscriptions = {
  version: typeof SUBSCRIPTIONS_VERSION
  subscribed: SubscriptionRef[]
}
