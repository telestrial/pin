import type { Sdk } from '@siafoundation/sia-storage'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  type AccountSnapshot,
  fetchAccountSnapshot,
  pinItem,
} from '../core/pin'
import type { ItemRef } from '../core/types'
import { APP_KEY } from '../lib/constants'
import { useActionStore } from './actionQueue'

// At-most-one-in-flight account refresh. Coalesces bursts (e.g.
// loop-until-clean repack with N batches, each calling refreshAccount)
// into at most one follow-up round-trip after the current one settles —
// so N batches produce 1 or 2 sdk.account() calls instead of N.
let accountRefreshInFlight: Promise<void> | null = null
let accountRefreshPending: Sdk | null = null

export type PinnedItemRef = {
  item: ItemRef
  channel: {
    authorHandle: string
    channelID: string
    name: string
  }
  objectID: string
  // Object IDs of the item's pinned attachment bytes, so unpin can release
  // the whole post. Legacy persisted entries predate this field — readers
  // default to []. Optional so PinInput callers don't construct it.
  attachmentObjectIDs?: string[]
  pinnedAt: string
}

export type PinInput = Omit<
  PinnedItemRef,
  'objectID' | 'attachmentObjectIDs' | 'pinnedAt'
>

type ChannelFanoutResult = { total: number; failed: number }

// An in-flight channel batch pin/unpin with per-item progress. Drives the
// channel header's in-place progress pin (fills bottom-up while pinning,
// drains while unpinning) and the right-sidebar in-flight row. Not persisted.
export type ChannelPinJob = {
  channelID: string
  channelName: string
  done: number
  total: number
  mode: 'pin' | 'unpin'
}

type PinState = {
  pinned: PinnedItemRef[]
  account: AccountSnapshot | null
  pinning: Set<string>
  // Channel batch jobs in flight, keyed by channelID, with progress. The
  // job outlives the button that started it (it's a store action), so a
  // navigate-away keeps pinning and the sidebar keeps showing it. Not
  // persisted.
  channelPins: Record<string, ChannelPinJob>
  pin: (sdk: Sdk, input: PinInput) => Promise<void>
  unpin: (sdk: Sdk, itemURL: string) => Promise<void>
  // Snapshot a whole channel: fan out pin() over every current item
  // (body + attachments). Reuses pin()'s dedup + drift-swap, so this
  // doubles as catch-up — already-held items are skipped, drifted ones
  // swap to current, new ones get pinned. Partial-failure-tolerant: one
  // item failing doesn't abort the batch; the count comes back so the
  // caller can surface "pinned 44 of 47."
  pinChannel: (
    sdk: Sdk,
    items: readonly ItemRef[],
    channel: PinInput['channel'],
  ) => Promise<ChannelFanoutResult>
  // Release a whole channel: unpin every item currently held for it.
  unpinChannel: (sdk: Sdk, channelID: string) => Promise<ChannelFanoutResult>
  refreshAccount: (sdk: Sdk) => Promise<void>
  isPinned: (itemURL: string) => boolean
  isPinning: (itemURL: string) => boolean
  // Used by the repack runner: swap the underlying object identity for one
  // or more pinned entries when their bytes get re-uploaded into a packed
  // slab. The user-visible "I pinned this" relationship is preserved; only
  // the internal ID + URL change.
  replaceMany: (
    replacements: Array<{
      oldObjectID: string
      newObjectID: string
      newURL: string
      newContentHash: string
    }>,
  ) => void
  reset: () => void
}

// Every Sia object ID currently held by these pins — each pin's body plus its
// attachment objects. Used by unpin to refcount shared bytes: with granular
// pinning a file can be held by both a whole-post pin and a standalone library
// pin, so a delete must skip any object still referenced by another pin.
export function objectIDsReferencedBy(
  pins: readonly PinnedItemRef[],
): Set<string> {
  const set = new Set<string>()
  for (const p of pins) {
    set.add(p.objectID)
    for (const aid of p.attachmentObjectIDs ?? []) set.add(aid)
  }
  return set
}

// Simplified shape of zustand's setter — enough for the channel-job
// helpers below to be defined outside the store initializer.
type PinSet = (
  partial: Partial<PinState> | ((state: PinState) => Partial<PinState>),
) => void

function startChannelJob(set: PinSet, job: ChannelPinJob): void {
  set((s) => ({ channelPins: { ...s.channelPins, [job.channelID]: job } }))
}

function bumpChannelJob(set: PinSet, channelID: string): void {
  set((s) => {
    const job = s.channelPins[channelID]
    if (!job) return {}
    return {
      channelPins: {
        ...s.channelPins,
        [channelID]: { ...job, done: job.done + 1 },
      },
    }
  })
}

function endChannelJob(set: PinSet, channelID: string): void {
  set((s) => {
    const { [channelID]: _, ...rest } = s.channelPins
    return { channelPins: rest }
  })
}

export const usePinStore = create<PinState>()(
  persist(
    (set, get) => ({
      pinned: [],
      account: null,
      pinning: new Set<string>(),
      channelPins: {},
      pin: async (sdk, input) => {
        const url = input.item.itemURL
        // Drift case: an existing pin matches the same logical post
        // (same channelID + publishedAt) but at a different itemURL
        // because the author edited. Re-pinning swaps your v1 for
        // v_current — single custody snapshot, updated. Library pins
        // (channelID 'library') aren't channel-bound, so they skip
        // this check and dedup purely by itemURL.
        const isLibrary = input.channel.channelID === 'library'
        const driftedFrom = isLibrary
          ? undefined
          : get().pinned.find(
              (p) =>
                p.channel.channelID === input.channel.channelID &&
                p.item.publishedAt === input.item.publishedAt,
            )
        if (driftedFrom && driftedFrom.item.itemURL === url) return
        if (get().pinned.some((p) => p.item.itemURL === url)) return
        const pinning = new Set(get().pinning)
        pinning.add(url)
        set({ pinning })
        try {
          // Pin new bytes first so a mid-operation failure can't
          // leave the user un-pinned. Whole-item: body + attachments.
          // Unpin of the old (body + its attachments) is best-effort —
          // orphan sweep catches strays.
          const { objectID, attachmentObjectIDs } = await pinItem(
            sdk,
            input.item,
          )
          if (driftedFrom) {
            // Release the stale version's bytes — but only those no other pin
            // (nor the freshly-pinned current version) still references. The
            // byte reclaim is journaled (durable, retried) rather than a
            // best-effort delete that a QUIC blip could silently drop.
            const referenced = objectIDsReferencedBy(
              get().pinned.filter((p) => p !== driftedFrom),
            )
            referenced.add(objectID)
            for (const aid of attachmentObjectIDs) referenced.add(aid)
            const stale = [
              driftedFrom.objectID,
              ...(driftedFrom.attachmentObjectIDs ?? []),
            ].filter((id) => !referenced.has(id))
            useActionStore.getState().enqueueDeleteObjects({
              objectIDs: stale,
              label: `Reclaiming old version of “${input.item.title || 'item'}”`,
            })
          }
          const ref: PinnedItemRef = {
            ...input,
            objectID,
            attachmentObjectIDs,
            pinnedAt: new Date().toISOString(),
          }
          const next = new Set(get().pinning)
          next.delete(url)
          set((s) => ({
            pinned: driftedFrom
              ? s.pinned.map((p) => (p === driftedFrom ? ref : p))
              : [...s.pinned, ref],
            pinning: next,
          }))
          get().refreshAccount(sdk)
        } catch (e) {
          const next = new Set(get().pinning)
          next.delete(url)
          set({ pinning: next })
          throw e
        }
      },
      unpin: async (sdk, itemURL) => {
        const ref = get().pinned.find((p) => p.item.itemURL === itemURL)
        if (!ref) return
        // Reference-aware: reclaim only the bytes no other pin still holds.
        const referenced = objectIDsReferencedBy(
          get().pinned.filter((p) => p !== ref),
        )
        const toDelete = [
          ref.objectID,
          ...(ref.attachmentObjectIDs ?? []),
        ].filter((id) => !referenced.has(id))
        // Drop the local pin now (the reliable leg); the byte reclaim is
        // journaled — durable + retried — instead of a best-effort delete that
        // a QUIC blip could silently drop. The runner refreshes the storage
        // meter when the cleanup completes.
        set((s) => ({
          pinned: s.pinned.filter((p) => p.item.itemURL !== itemURL),
        }))
        useActionStore.getState().enqueueDeleteObjects({
          objectIDs: toDelete,
          label: `Reclaiming “${ref.item.title || 'item'}”`,
        })
        get().refreshAccount(sdk)
      },
      pinChannel: async (sdk, items, channel) => {
        const { channelID } = channel
        startChannelJob(set, {
          channelID,
          channelName: channel.name,
          done: 0,
          total: items.length,
          mode: 'pin',
        })
        let failed = 0
        try {
          for (const item of items) {
            try {
              await get().pin(sdk, { item, channel })
            } catch {
              failed++
            }
            bumpChannelJob(set, channelID)
          }
        } finally {
          endChannelJob(set, channelID)
        }
        return { total: items.length, failed }
      },
      unpinChannel: async (sdk, channelID) => {
        const targets = get().pinned.filter(
          (p) => p.channel.channelID === channelID,
        )
        startChannelJob(set, {
          channelID,
          channelName: targets[0]?.channel.name ?? channelID,
          done: 0,
          total: targets.length,
          mode: 'unpin',
        })
        let failed = 0
        try {
          for (const p of targets) {
            try {
              await get().unpin(sdk, p.item.itemURL)
            } catch {
              failed++
            }
            bumpChannelJob(set, channelID)
          }
        } finally {
          endChannelJob(set, channelID)
        }
        return { total: targets.length, failed }
      },
      refreshAccount: async (sdk) => {
        if (accountRefreshInFlight) {
          accountRefreshPending = sdk
          return accountRefreshInFlight
        }
        accountRefreshInFlight = (async () => {
          try {
            const account = await fetchAccountSnapshot(sdk)
            set({ account })
          } catch {
            // best-effort
          } finally {
            accountRefreshInFlight = null
            const next = accountRefreshPending
            accountRefreshPending = null
            if (next) get().refreshAccount(next)
          }
        })()
        return accountRefreshInFlight
      },
      isPinned: (itemURL) =>
        get().pinned.some((p) => p.item.itemURL === itemURL),
      isPinning: (itemURL) => get().pinning.has(itemURL),
      replaceMany: (replacements) => {
        if (replacements.length === 0) return
        const byOldID = new Map(replacements.map((r) => [r.oldObjectID, r]))
        set((s) => ({
          pinned: s.pinned.map((p) => {
            const r = byOldID.get(p.objectID)
            if (!r) return p
            return {
              ...p,
              objectID: r.newObjectID,
              item: {
                ...p.item,
                id: r.newObjectID,
                itemURL: r.newURL,
                contentHash: r.newContentHash,
              },
            }
          }),
        }))
      },
      reset: () =>
        set({
          pinned: [],
          account: null,
          pinning: new Set<string>(),
          channelPins: {},
        }),
    }),
    {
      name: `sia-pins-${APP_KEY.slice(0, 16)}`,
      partialize: (state) => ({ pinned: state.pinned }),
    },
  ),
)
