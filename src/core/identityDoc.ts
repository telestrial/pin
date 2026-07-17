import type { ProfileRecord } from './profile'

// The public directory document for an identity — what a visitor gets when they
// resolve someone's did:dht. It's the atproto-free replacement for the profile
// record + the public follow-graph + the advertised-channel list, published as one
// Sia blob pointed at by the `_dir` record under the did:dht key (see lib/identityDoc).
//
// Public by design (profile, *advertised* public channels, public follows are all
// public — 06-02). Obscure channels are deliberately ABSENT — they're only reachable
// via their own K-derived locator, so resolving an identity never enumerates them.

export const DIRECTORY_DOC_VERSION = 1

// One advertised public channel: enough for a resolver to read it — the channelID +
// its key K (public channels' K is shareable by definition) → derive the channel's
// locator (lib/channelLocator) and decrypt its manifest.
export type DirectoryChannelRef = {
  channelID: string
  key: string // base64 K
  name: string
}

export type DirectoryDoc = {
  version: typeof DIRECTORY_DOC_VERSION
  profile: ProfileRecord | null
  channels: DirectoryChannelRef[]
  // Public follows, mirrored as their subject AT-URIs (at://did/dev.sia.pin.channel/id)
  // — the same values atproto's follow records carry. Resolving them into a walkable
  // discovery graph is step 5 (needs the followed identities' did:dht).
  follows: string[]
  updatedAt: string
}
