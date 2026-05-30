import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SubscriptionRef } from '../core/types'
import { APP_KEY } from '../lib/constants'
import { useFeedStore } from './feed'
import { usePinStore } from './pin'
import { useUploadQueueStore } from './uploadQueue'

export type AuthStep =
  | 'loading'
  | 'welcome'
  | 'bluesky-onboarding'
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
  atprotoAgent: Agent | null
  atprotoDID: string | null
  atprotoHandle: string | null
  feedSortOrder: FeedSortOrder
  settingsObjectID: string | null
  settingsLoaded: boolean
  setSdk: (sdk: Sdk) => void
  setStep: (step: AuthStep) => void
  setError: (error: string | null) => void
  setStoredKeyHex: (hex: string) => void
  setIndexerURL: (url: string) => void
  setApprovalURL: (url: string | null) => void
  addMyChannel: (channel: OwnedChannel) => void
  updateMyChannelName: (channelID: string, name: string) => void
  removeMyChannel: (channelID: string) => void
  addSubscription: (sub: SubscriptionRef) => void
  updateSubscriptionName: (channelID: string, name: string) => void
  removeSubscription: (channelID: string) => void
  setATProtoIdentity: (
    agent: Agent | null,
    did: string | null,
    handle: string | null,
  ) => void
  setATProtoHandle: (handle: string) => void
  setFeedSortOrder: (order: FeedSortOrder) => void
  hydrateSettings: (
    myChannels: OwnedChannel[],
    subscriptions: SubscriptionRef[],
    objectID: string,
  ) => void
  setSettingsObjectID: (id: string) => void
  setSettingsLoaded: (loaded: boolean) => void
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
      atprotoAgent: null,
      atprotoDID: null,
      atprotoHandle: null,
      feedSortOrder: 'newest',
      settingsObjectID: null,
      settingsLoaded: false,
      setSdk: (sdk) => set({ sdk, step: 'connected', error: null }),
      setStep: (step) => set({ step, error: null }),
      setError: (error) => set({ error }),
      setStoredKeyHex: (hex) => set({ storedKeyHex: hex }),
      setIndexerURL: (url) => set({ indexerURL: url }),
      setApprovalURL: (url) => set({ approvalURL: url }),
      addMyChannel: (channel) =>
        set((s) => ({ myChannels: [...s.myChannels, channel] })),
      updateMyChannelName: (channelID, name) =>
        set((s) => ({
          myChannels: s.myChannels.map((c) =>
            c.channelID === channelID ? { ...c, name } : c,
          ),
        })),
      removeMyChannel: (channelID) =>
        set((s) => ({
          myChannels: s.myChannels.filter((c) => c.channelID !== channelID),
        })),
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
      updateSubscriptionName: (channelID, name) =>
        set((s) => ({
          subscriptions: s.subscriptions.map((sub) =>
            sub.channelID === channelID
              ? { ...sub, cachedName: name, label: name }
              : sub,
          ),
        })),
      removeSubscription: (channelID) =>
        set((s) => ({
          subscriptions: s.subscriptions.filter(
            (sub) => sub.channelID !== channelID,
          ),
        })),
      setATProtoIdentity: (atprotoAgent, atprotoDID, atprotoHandle) =>
        // Don't overwrite an already-cached handle with null. The OAuth
        // scope doesn't permit app.bsky.actor.getProfile, so doBoot can
        // legitimately resolve handle=null on a returning session — that
        // shouldn't trash the persisted display value from the prior boot,
        // nor a handle pre-seeded by BlueskyOnboardingScreen before the
        // sign-in redirect.
        set((s) => ({
          atprotoAgent,
          atprotoDID,
          atprotoHandle: atprotoHandle ?? s.atprotoHandle,
        })),
      setATProtoHandle: (atprotoHandle) => set({ atprotoHandle }),
      setFeedSortOrder: (feedSortOrder) => set({ feedSortOrder }),
      hydrateSettings: (myChannels, subscriptions, objectID) =>
        set({
          myChannels,
          subscriptions,
          settingsObjectID: objectID,
          settingsLoaded: true,
        }),
      setSettingsObjectID: (settingsObjectID) => set({ settingsObjectID }),
      setSettingsLoaded: (settingsLoaded) => set({ settingsLoaded }),
      reset: () => {
        useFeedStore.getState().reset()
        usePinStore.getState().reset()
        useUploadQueueStore.getState().reset()
        set({
          sdk: null,
          storedKeyHex: null,
          step: 'loading',
          error: null,
          approvalURL: null,
          myChannels: [],
          subscriptions: [],
          atprotoAgent: null,
          atprotoDID: null,
          atprotoHandle: null,
          settingsObjectID: null,
          settingsLoaded: false,
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
        atprotoDID: state.atprotoDID,
        atprotoHandle: state.atprotoHandle,
        feedSortOrder: state.feedSortOrder,
        settingsObjectID: state.settingsObjectID,
      }),
    },
  ),
)
