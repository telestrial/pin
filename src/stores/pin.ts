import type { Sdk } from '@siafoundation/sia-storage'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  type AccountSnapshot,
  fetchAccountSnapshot,
  pinItemBytes,
  unpinItemBytes,
} from '../core/pin'
import type { ItemRef } from '../core/types'
import { APP_KEY } from '../lib/constants'

export type PinnedItemRef = {
  item: ItemRef
  channel: {
    authorHandle: string
    channelID: string
    name: string
  }
  objectID: string
  pinnedAt: string
}

export type PinInput = Omit<PinnedItemRef, 'objectID' | 'pinnedAt'>

type PinState = {
  pinned: PinnedItemRef[]
  account: AccountSnapshot | null
  pinning: Set<string>
  pin: (sdk: Sdk, input: PinInput) => Promise<void>
  unpin: (sdk: Sdk, itemURL: string) => Promise<void>
  refreshAccount: (sdk: Sdk) => Promise<void>
  isPinned: (itemURL: string) => boolean
  isPinning: (itemURL: string) => boolean
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
        if (get().pinned.some((p) => p.item.itemURL === url)) return
        const pinning = new Set(get().pinning)
        pinning.add(url)
        set({ pinning })
        try {
          const { objectID } = await pinItemBytes(sdk, url)
          const ref: PinnedItemRef = {
            ...input,
            objectID,
            pinnedAt: new Date().toISOString(),
          }
          const next = new Set(get().pinning)
          next.delete(url)
          set((s) => ({ pinned: [...s.pinned, ref], pinning: next }))
          fetchAccountSnapshot(sdk)
            .then((account) => set({ account }))
            .catch(() => {})
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
          await unpinItemBytes(sdk, ref.objectID)
          const next = new Set(get().pinning)
          next.delete(itemURL)
          set((s) => ({
            pinned: s.pinned.filter((p) => p.item.itemURL !== itemURL),
            pinning: next,
          }))
          fetchAccountSnapshot(sdk)
            .then((account) => set({ account }))
            .catch(() => {})
        } catch (e) {
          const next = new Set(get().pinning)
          next.delete(itemURL)
          set({ pinning: next })
          throw e
        }
      },
      refreshAccount: async (sdk) => {
        try {
          const account = await fetchAccountSnapshot(sdk)
          set({ account })
        } catch {
          // best-effort
        }
      },
      isPinned: (itemURL) =>
        get().pinned.some((p) => p.item.itemURL === itemURL),
      isPinning: (itemURL) => get().pinning.has(itemURL),
      reset: () =>
        set({ pinned: [], account: null, pinning: new Set<string>() }),
    }),
    {
      name: `sia-pins-${APP_KEY.slice(0, 16)}`,
      partialize: (state) => ({ pinned: state.pinned }),
    },
  ),
)
