import type { ProfileRecord } from './profile'
import type {
  FollowEdge,
  OwnedChannel,
  SubscriptionRef,
  ThemeMode,
} from './types'

export const SETTINGS_VERSION = 1

export type DispatchSettings = {
  version: typeof SETTINGS_VERSION
  myChannels: OwnedChannel[]
  subscriptions: SubscriptionRef[]
  // Visual theme, synced so the look follows the identity across devices.
  // Optional for back-compat with settings written before the field existed
  // (a missing value leaves the device's current theme untouched on load).
  theme?: ThemeMode
  // Public follow graph (Phase D step 6, atproto-free). `follows` = channel-follows
  // as did:dht-native edges (replacing dev.sia.pin.subscription records);
  // `handleFollows` = handle-follows as target did:dhts (replacing
  // dev.sia.pin.handlefollow). Both optional for back-compat (treated empty).
  follows?: FollowEdge[]
  handleFollows?: string[]
  // The user's own profile (Phase D step 6, atproto-free) — canonical locally,
  // published into the identity-doc for others to resolve. Optional for
  // back-compat (absent → no profile set).
  profile?: ProfileRecord | null
  // Invitations to members-only channels this identity has turned down, by channelID.
  // The membership the Curator wrote stays; this only keeps the invitation off the
  // sidebar, on every device. Optional (absent → none dismissed).
  dismissedInvitations?: string[]
  updatedAt: string
}
