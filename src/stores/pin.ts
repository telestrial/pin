import type { Sdk } from '@siafoundation/sia-storage'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  type AccountSnapshot,
  fetchAccountSnapshot,
  pinItem,
  unpinItem,
} from '../core/pin'
import type { ItemRef } from '../core/types'
import { APP_KEY } from '../lib/constants'

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

type PinState = {
  pinned: PinnedItemRef[]
  account: AccountSnapshot | null
  pinning: Set<string>
  pin: (sdk: Sdk, input: PinInput) => Promise<void>
  unpin: (sdk: Sdk, itemURL: string) => Promise<void>
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

export const usePinStore = create<PinState>()(
  persist(
    (set, get) => ({
      pinned: [],
      account: null,
      pinning: new Set<string>(),
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
            unpinItem(
              sdk,
              driftedFrom.objectID,
              driftedFrom.attachmentObjectIDs ?? [],
            ).catch(() => {})
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
        const pinning = new Set(get().pinning)
        pinning.add(itemURL)
        set({ pinning })
        try {
          await unpinItem(sdk, ref.objectID, ref.attachmentObjectIDs ?? [])
          const next = new Set(get().pinning)
          next.delete(itemURL)
          set((s) => ({
            pinned: s.pinned.filter((p) => p.item.itemURL !== itemURL),
            pinning: next,
          }))
          get().refreshAccount(sdk)
        } catch (e) {
          const next = new Set(get().pinning)
          next.delete(itemURL)
          set({ pinning: next })
          throw e
        }
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
        set({ pinned: [], account: null, pinning: new Set<string>() }),
    }),
    {
      name: `sia-pins-${APP_KEY.slice(0, 16)}`,
      partialize: (state) => ({ pinned: state.pinned }),
    },
  ),
)
