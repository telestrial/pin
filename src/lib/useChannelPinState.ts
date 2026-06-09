import type { PinState } from '../components/PinIcon'
import type { ChannelManifest, ItemRef } from '../core/types'
import { isValidAttachment } from '../core/types'
import { type PinnedItemRef, usePinStore } from '../stores/pin'

// Channel-level pin state, derived from the per-item pins of the current
// manifest — the membership-drift analog of usePinState's content-drift.
//   pinnable: you hold nothing for this channel
//   pinned:   you hold the current version of every current item
//   edited:   you hold some items but you're behind — new items arrived,
//             and/or items you hold were edited (catch up by re-pinning)
//
// "Behind" is additions/edits only: a retracted item you still hold means
// you have *more* than current, not less, so it doesn't pull you out of
// 'pinned'. Owned channels don't use this (their header icon is the
// retract path); this drives the non-owned ChannelPinButton.
export function computeChannelPinState(
  items: readonly ItemRef[],
  channelID: string,
  pinned: readonly PinnedItemRef[],
): PinState {
  if (items.length === 0) return 'pinnable'
  const mine = pinned.filter((p) => p.channel.channelID === channelID)
  if (mine.length === 0) return 'pinnable'

  let heldAny = 0
  let heldCurrent = 0
  for (const item of items) {
    const pin = mine.find((p) => p.item.publishedAt === item.publishedAt)
    if (!pin) continue
    heldAny++
    const drifted =
      !!pin.item.contentHash &&
      !!item.contentHash &&
      pin.item.contentHash !== item.contentHash
    if (!drifted) heldCurrent++
  }

  if (heldAny === 0) return 'pinnable'
  if (heldCurrent === items.length) return 'pinned'
  return 'edited'
}

export function useChannelPinState(
  manifest: ChannelManifest | undefined,
  channelID: string,
): PinState {
  const pinned = usePinStore((s) => s.pinned)
  if (!manifest) return 'pinnable'
  return computeChannelPinState(manifest.items, channelID, pinned)
}

function bytesOrZero(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

// Total content bytes a channel pin mirrors — item bodies + valid
// attachments. Legacy refs without byteSize contribute 0. This is the number
// the storage bar will read after pinning (modulo negligible AES-GCM
// per-object overhead), so the hover tooltip and the bar speak the same
// content-byte language. Avatar/cover are NOT counted: channel-pin currently
// mirrors items only (cover/avatar pinning is deferred — see CLAUDE.md), so
// counting them would overstate what the bar actually moves. They rejoin
// both the pin and this sum together when cover/avatar pinning lands.
export function channelPinByteSize(manifest: ChannelManifest): number {
  let total = 0
  for (const item of manifest.items) {
    total += bytesOrZero(item.byteSize)
    for (const att of item.attachments ?? []) {
      if (isValidAttachment(att)) total += bytesOrZero(att.byteSize)
    }
  }
  return total
}
