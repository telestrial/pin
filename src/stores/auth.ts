import type { AtpAgent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ATProtoSession } from '../core/atproto'
import type { SubscriptionRef } from '../core/types'
import { APP_KEY } from '../lib/constants'
import { useFeedStore } from './feed'

export type AuthStep =
  | 'loading'
  | 'connect'
  | 'approve'
  | 'recovery'
  | 'connected'

export type OwnedChannel = {
  channelID: string
  channelKey: string
  name: string
  createdAt: string
}

export type FeedSortOrder = 'oldest' | 'newest'

type AuthState = {
  sdk: Sdk | null
  storedKeyHex: string | null
  indexerURL: string
  step: AuthStep
  error: string | null
  approvalURL: string | null
  myChannels: OwnedChannel[]
  subscriptions: SubscriptionRef[]
  atprotoSession: ATProtoSession | null
  atprotoAgent: AtpAgent | null
  feedSortOrder: FeedSortOrder
  setSdk: (sdk: Sdk) => void
  setStep: (step: AuthStep) => void
  setError: (error: string | null) => void
  setStoredKeyHex: (hex: string) => void
  setIndexerURL: (url: string) => void
  setApprovalURL: (url: string | null) => void
  addMyChannel: (channel: OwnedChannel) => void
  addSubscription: (sub: SubscriptionRef) => void
  setATProtoSession: (
    session: ATProtoSession | null,
    agent: AtpAgent | null,
  ) => void
  setFeedSortOrder: (order: FeedSortOrder) => void
  reset: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      sdk: null,
      storedKeyHex: null,
      indexerURL: '',
      step: 'loading',
      error: null,
      approvalURL: null,
      myChannels: [],
      subscriptions: [],
      atprotoSession: null,
      atprotoAgent: null,
      feedSortOrder: 'newest',
      setSdk: (sdk) => set({ sdk, step: 'connected', error: null }),
      setStep: (step) => set({ step, error: null }),
      setError: (error) => set({ error }),
      setStoredKeyHex: (hex) => set({ storedKeyHex: hex }),
      setIndexerURL: (url) => set({ indexerURL: url }),
      setApprovalURL: (url) => set({ approvalURL: url }),
      addMyChannel: (channel) =>
        set((s) => ({ myChannels: [...s.myChannels, channel] })),
      addSubscription: (sub) =>
        set((s) =>
          s.subscriptions.some(
            (x) =>
              x.authorHandle === sub.authorHandle &&
              x.channelID === sub.channelID,
          )
            ? s
            : { subscriptions: [...s.subscriptions, sub] },
        ),
      setATProtoSession: (atprotoSession, atprotoAgent) =>
        set({ atprotoSession, atprotoAgent }),
      setFeedSortOrder: (feedSortOrder) => set({ feedSortOrder }),
      reset: () => {
        useFeedStore.getState().reset()
        set({
          sdk: null,
          storedKeyHex: null,
          step: 'loading',
          error: null,
          approvalURL: null,
          myChannels: [],
          subscriptions: [],
          atprotoSession: null,
          atprotoAgent: null,
        })
      },
    }),
    {
      name: `sia-auth-${APP_KEY.slice(0, 16)}`,
      partialize: (state) => ({
        storedKeyHex: state.storedKeyHex,
        indexerURL: state.indexerURL,
        myChannels: state.myChannels,
        subscriptions: state.subscriptions,
        atprotoSession: state.atprotoSession,
        feedSortOrder: state.feedSortOrder,
      }),
    },
  ),
)
