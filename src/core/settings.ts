import type { OwnedChannel, SubscriptionRef, ThemeMode } from './types'

export const SETTINGS_VERSION = 1

export type DispatchSettings = {
  version: typeof SETTINGS_VERSION
  myChannels: OwnedChannel[]
  subscriptions: SubscriptionRef[]
  // Visual theme, synced so the look follows the identity across devices.
  // Optional for back-compat with settings written before the field existed
  // (a missing value leaves the device's current theme untouched on load).
  theme?: ThemeMode
  // channelIDs the user explicitly unsubscribed from (the handle-follow
  // auto-Watch tombstone set). Synced so an unsubscribe sticks across
  // devices — otherwise a second device's reconcile re-adds the channel
  // and writes it back, resurrecting it everywhere. Optional for back-compat
  // with settings written before the field existed (treated empty).
  dismissedAutoWatch?: string[]
  updatedAt: string
}
