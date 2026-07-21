import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  applyProfilePatch,
  type ProfilePatch,
  type ProfileRecord,
} from '../core/profile'
import type {
  FollowEdge,
  OwnedChannel,
  SubscriptionRef,
  ThemeMode,
} from '../core/types'
import { APP_KEY } from '../lib/constants'
import { useActionStore } from './actionQueue'
import { useFeedStore } from './feed'
import { usePinStore } from './pin'

export type AuthStep =
  | 'loading'
  | 'welcome'
  | 'bluesky-onboarding'
  | 'connect'
  | 'approve'
  | 'recovery'
  | 'connected'

export type FeedSortOrder = 'oldest' | 'newest'

// Re-exported so existing `import { ThemeMode } from '../stores/auth'` sites
// keep working; the type itself lives in core/types (used by the settings
// serializer, which mustn't import a store).
export type { ThemeMode }

type AuthState = {
  sdk: Sdk | null
  storedKeyHex: string | null
  indexerURL: string
  step: AuthStep
  error: string | null
  approvalURL: string | null
  myChannels: OwnedChannel[]
  subscriptions: SubscriptionRef[]
  // channelIDs the user explicitly unsubscribed from and hasn't re-added.
  // The handle-follow auto-Watch reconcile skips anything in here so an
  // explicit unsubscribe survives repeated boots (otherwise a channel
  // claimed by a person you follow would be re-added every reconcile).
  // Driven uniformly by add/removeSubscription — no handle-follow
  // special-casing; it's just "channels I deliberately dropped".
  dismissedAutoWatch: string[]
  // Public follow graph (Phase D step 6). `follows` = channel-follows as
  // did:dht-native edges; `handleFollows` = handle-follows as target did:dhts.
  // Local source of truth (mirrored into the identity-doc + settings record),
  // replacing the atproto dev.sia.pin.subscription / .handlefollow records.
  follows: FollowEdge[]
  handleFollows: string[]
  // The user's own profile — canonical locally (settings-synced), published into
  // the identity-doc. Replaces the atproto dev.sia.pin.profile record.
  profile: ProfileRecord | null
  atprotoAgent: Agent | null
  atprotoDID: string | null
  atprotoHandle: string | null
  // This identity's own did:dht, derived from the Sia AppKey (HKDF, same as the
  // keeper / identity-doc). The self-sovereign "who am I" — used for isSelf and
  // profile navigation, replacing the atproto handle/DID. Persisted for instant
  // availability on boot; re-derived at connect so it's never stale.
  myDidDht: string | null
  feedSortOrder: FeedSortOrder
  theme: ThemeMode
  settingsObjectID: string | null
  // CID of the current dev.sia.pin.settings/self record — the compare-and-swap
  // guard for the next write. Runtime-only (re-fetched on load), not persisted.
  settingsRecordCid: string | null
  settingsLoaded: boolean
  settingsDirty: boolean
  // Soft lock: when true, the connected surface is replaced by the lock
  // screen. The session (sdk, agent, AppKey) stays live and the background
  // runners keep going — this is a visual gate, not a teardown — so
  // unlocking is instant. Runtime-only (not persisted): a real reload runs
  // normal boot, so you can never be stuck locked across a refresh.
  locked: boolean
  setSdk: (sdk: Sdk) => void
  setStep: (step: AuthStep) => void
  setError: (error: string | null) => void
  setStoredKeyHex: (hex: string) => void
  setIndexerURL: (url: string) => void
  setApprovalURL: (url: string | null) => void
  addMyChannel: (channel: OwnedChannel) => void
  updateMyChannelName: (channelID: string, name: string) => void
  setChannelAdvertised: (channelID: string, advertised: boolean) => void
  removeMyChannel: (channelID: string) => void
  addSubscription: (sub: SubscriptionRef) => void
  updateSubscriptionName: (channelID: string, name: string) => void
  removeSubscription: (channelID: string) => void
  // Clears tombstones for the given channelIDs (used on handle-unfollow,
  // which sweeps a person's channels — a later re-follow then re-adds fresh).
  clearDismissedAutoWatch: (channelIDs: string[]) => void
  addFollow: (edge: FollowEdge) => void
  removeFollow: (channelID: string) => void
  addHandleFollow: (didDht: string) => void
  removeHandleFollow: (didDht: string) => void
  setProfile: (patch: ProfilePatch) => void
  setATProtoIdentity: (
    agent: Agent | null,
    did: string | null,
    handle: string | null,
  ) => void
  setATProtoHandle: (handle: string) => void
  setMyDidDht: (did: string) => void
  setFeedSortOrder: (order: FeedSortOrder) => void
  setTheme: (theme: ThemeMode) => void
  hydrateSettings: (
    myChannels: OwnedChannel[],
    subscriptions: SubscriptionRef[],
    dismissedAutoWatch: string[],
    theme: ThemeMode,
    follows: FollowEdge[],
    handleFollows: string[],
    profile: ProfileRecord | null,
    // null when the freshest settings came from the Sia snapshot with no atproto
    // record (no CID to CAS against — the next save is a fresh create).
    cid: string | null,
  ) => void
  setSettingsObjectID: (id: string) => void
  setSettingsRecordCid: (cid: string | null) => void
  setSettingsLoaded: (loaded: boolean) => void
  setSettingsDirty: (dirty: boolean) => void
  setLocked: (locked: boolean) => void
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
      dismissedAutoWatch: [],
      follows: [],
      handleFollows: [],
      profile: null,
      atprotoAgent: null,
      atprotoDID: null,
      atprotoHandle: null,
      myDidDht: null,
      feedSortOrder: 'newest',
      theme: 'rounded',
      settingsObjectID: null,
      settingsRecordCid: null,
      settingsLoaded: false,
      settingsDirty: false,
      locked: false,
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
      setChannelAdvertised: (channelID, advertised) =>
        set((s) => ({
          myChannels: s.myChannels.map((c) =>
            c.channelID === channelID ? { ...c, advertised } : c,
          ),
        })),
      removeMyChannel: (channelID) =>
        set((s) => ({
          myChannels: s.myChannels.filter((c) => c.channelID !== channelID),
        })),
      addSubscription: (sub) =>
        set((s) => {
          // Re-adding clears any tombstone for this channel (you want it again).
          const dismissedAutoWatch = s.dismissedAutoWatch.filter(
            (id) => id !== sub.channelID,
          )
          const already = s.subscriptions.some(
            (x) =>
              x.authorHandle === sub.authorHandle &&
              x.channelID === sub.channelID,
          )
          return already
            ? { dismissedAutoWatch }
            : { subscriptions: [...s.subscriptions, sub], dismissedAutoWatch }
        }),
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
          // Tombstone it so the auto-Watch reconcile won't resurrect it.
          dismissedAutoWatch: s.dismissedAutoWatch.includes(channelID)
            ? s.dismissedAutoWatch
            : [...s.dismissedAutoWatch, channelID],
        })),
      clearDismissedAutoWatch: (channelIDs) =>
        set((s) => {
          const drop = new Set(channelIDs)
          return {
            dismissedAutoWatch: s.dismissedAutoWatch.filter(
              (id) => !drop.has(id),
            ),
          }
        }),
      addFollow: (edge) =>
        set((s) =>
          s.follows.some((f) => f.channelID === edge.channelID)
            ? s
            : { follows: [...s.follows, edge] },
        ),
      removeFollow: (channelID) =>
        set((s) => ({
          follows: s.follows.filter((f) => f.channelID !== channelID),
        })),
      addHandleFollow: (didDht) =>
        set((s) =>
          s.handleFollows.includes(didDht)
            ? s
            : { handleFollows: [...s.handleFollows, didDht] },
        ),
      removeHandleFollow: (didDht) =>
        set((s) => ({
          handleFollows: s.handleFollows.filter((d) => d !== didDht),
        })),
      setProfile: (patch) =>
        set((s) => ({ profile: applyProfilePatch(s.profile, patch) })),
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
      setMyDidDht: (myDidDht) => set({ myDidDht }),
      setFeedSortOrder: (feedSortOrder) => set({ feedSortOrder }),
      setTheme: (theme) => set({ theme }),
      hydrateSettings: (
        myChannels,
        subscriptions,
        dismissedAutoWatch,
        theme,
        follows,
        handleFollows,
        profile,
        cid,
      ) =>
        set({
          myChannels,
          subscriptions,
          dismissedAutoWatch,
          theme,
          follows,
          handleFollows,
          profile,
          settingsRecordCid: cid,
          settingsLoaded: true,
        }),
      setSettingsObjectID: (settingsObjectID) => set({ settingsObjectID }),
      setSettingsRecordCid: (settingsRecordCid) => set({ settingsRecordCid }),
      setSettingsLoaded: (settingsLoaded) => set({ settingsLoaded }),
      setSettingsDirty: (settingsDirty) => set({ settingsDirty }),
      setLocked: (locked) => set({ locked }),
      reset: () => {
        useFeedStore.getState().reset()
        usePinStore.getState().reset()
        useActionStore.getState().reset()
        set({
          sdk: null,
          storedKeyHex: null,
          step: 'loading',
          error: null,
          approvalURL: null,
          myChannels: [],
          subscriptions: [],
          dismissedAutoWatch: [],
          follows: [],
          handleFollows: [],
          profile: null,
          atprotoAgent: null,
          atprotoDID: null,
          atprotoHandle: null,
          myDidDht: null,
          settingsObjectID: null,
          settingsRecordCid: null,
          settingsLoaded: false,
          settingsDirty: false,
          locked: false,
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
        dismissedAutoWatch: state.dismissedAutoWatch,
        follows: state.follows,
        handleFollows: state.handleFollows,
        profile: state.profile,
        atprotoDID: state.atprotoDID,
        atprotoHandle: state.atprotoHandle,
        myDidDht: state.myDidDht,
        feedSortOrder: state.feedSortOrder,
        theme: state.theme,
        settingsObjectID: state.settingsObjectID,
        settingsDirty: state.settingsDirty,
      }),
    },
  ),
)
