import type { ProfileRecord } from './profile'
import type { FollowEdge } from './types'

// The public directory document for an identity — what a visitor gets when they
// resolve someone's did:dht. It's the atproto-free replacement for the profile
// record + the public follow-graph + the advertised-channel list, published as one
// Sia blob pointed at by the `_dir` record under the did:dht key (see lib/identityDoc).
//
// Public by design (profile, *advertised* public channels, public follows are all
// public — 06-02). Obscure channels are deliberately ABSENT — they're only reachable
// via their own K-derived locator, so resolving an identity never enumerates them.

export const DIRECTORY_DOC_VERSION = 4

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
  // Channel-follows as iroh-native edges (Phase D step 6) — {didDht, channelID,
  // name?}, no K. A resolver takes didDht → the author's identity-doc → looks up
  // channelID in `channels` → K there (public channels advertise K; obscure ones
  // aren't advertised, so a follow of one stays an opaque pointer). Replaces the
  // v1 subject-AT-URI strings.
  follows: FollowEdge[]
  // Handle-follows: the did:dhts of people this identity follows wholesale
  // (their channels auto-Watched + tracked). Replaces the dev.sia.pin.handlefollow
  // records.
  handleFollows: string[]
  // What this identity has endorsed — signed records, verbatim, each one verifiable on
  // its own. World-readable because auditability needs it to be: a third party can't check
  // a count whose backing records they can't read.
  //
  // Here rather than in an object of their own because a crawl fetches this blob anyway,
  // so endorsements cost no extra round trip. CURRENT endorsements only — withdrawing
  // removes the record instead of appending a tombstone, which keeps a blob that gets
  // fetched to draw a display name from carrying somebody's lifetime history.
  //
  // Opaque here on purpose: the shape is pin-engagement's, and a reader that needs to
  // interpret one verifies it through pin-core rather than trusting this type.
  endorsements?: unknown[]
  // Where this identity's comments are, when there are any. A pointer rather than the
  // records, unlike endorsements above: a comment carries its words inline, so the blob
  // grows with what somebody has said, and this one gets fetched to draw a display name in
  // a feed row. One extra Sia read buys them, and it falls on a crawl rather than on
  // anything a screen is waiting for.
  //
  // Absent while nothing has been commented, which is what keeps the extra read conditional.
  commentsURL?: string
  updatedAt: string
}
