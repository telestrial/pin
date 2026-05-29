import type { PinState } from '../components/PinIcon'
import type { ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { type PinnedItemRef, usePinStore } from '../stores/pin'

// Drift-aware pin state for a given item in a given channel.
//
// Identity: a pin matches the rendered item when both
// (channelID, publishedAt) align. editItem preserves publishedAt
// across edits so the same logical post keeps the same timestamp
// — id, itemURL, and contentHash all change on edit, publishedAt
// doesn't. Same-millisecond collisions on the same channel are
// vanishingly unlikely; the heuristic is good enough and avoids
// inventing a persistent post identity that would shift power
// over reader-side artifacts toward the author.
//
// Comparison: if your pinned snapshot's contentHash differs from
// the rendered item's contentHash, the post drifted under you →
// 'edited'. Otherwise → 'pinned'. Not pinned at all → 'pinnable'.
// Legacy items without contentHash on either side fall through
// to 'pinned' (can't detect drift; show as plain custody).
//
// Surface scope: the library views (MyStorage tiles, PinSidebar
// item rows) show items as plain 'pinned' regardless; their job
// is to surface your archive, not compare it to channel state.
// Drift surfaces only where channel state and your custody are
// shown side-by-side: feed rows, channel page rows, Read pages.

// Pure form of usePinState, exposed for testing and any caller that
// already has both arrays in hand (avoids two extra store subscriptions).
export function computePinState(
  item: ItemRef,
  channelID: string,
  myChannels: readonly { channelID: string }[],
  pinned: readonly PinnedItemRef[],
): PinState {
  // Owned posts are always 'pinned' — the manifest is yours, the bytes
  // are in your Sia scope. Drift can't apply to your own posts: editing
  // creates the new version, there's no older snapshot of yours to
  // drift from. (Subscribers who pinned an earlier version see drift;
  // the author doesn't.)
  if (myChannels.some((c) => c.channelID === channelID)) return 'pinned'

  const pin = pinned.find(
    (p) =>
      p.channel.channelID === channelID &&
      p.item.publishedAt === item.publishedAt,
  )
  if (!pin) return 'pinnable'
  if (
    pin.item.contentHash &&
    item.contentHash &&
    pin.item.contentHash !== item.contentHash
  ) {
    return 'edited'
  }
  return 'pinned'
}

export function usePinState(item: ItemRef, channelID: string): PinState {
  const myChannels = useAuthStore((s) => s.myChannels)
  const pinned = usePinStore((s) => s.pinned)
  return computePinState(item, channelID, myChannels, pinned)
}
