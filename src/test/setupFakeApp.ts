// Test harness helpers for integration tests. Pulls in production stores
// (zustand) and the Phase 3 fakes; safe to import from a test body but
// NOT from a vi.mock factory (the factory would race the production
// modules it's replacing). See fakeModules.ts for the lean mock side.

import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { FakeAgent, FakeRecordStore } from './fakeAgent'
import { createFakeWorld, FakeSdk, type FakeWorld } from './fakeSdk'
import { setCurrentWorld } from './fakeModules'
import { useAuthStore } from '../stores/auth'
import { useComposeStore } from '../stores/compose'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'
import type { SubscriptionRef } from '../core/types'

export type FakeAccount = {
  sdk: FakeSdk
  agent: FakeAgent
  did: string
  handle: string
}

export type FakeApp = {
  world: FakeWorld
  createAccount: (params: {
    did: string
    handle: string
    maxPinned?: number
  }) => FakeAccount
}

export function createFakeApp(): FakeApp {
  const world = createFakeWorld()
  // Eagerly initialize so vi.mock'd reads work before any FakeAgent
  // constructor runs.
  if (!world.records) world.records = new FakeRecordStore()
  setCurrentWorld(world)
  return {
    world,
    createAccount: ({ did, handle, maxPinned }) => {
      if (maxPinned !== undefined) world.accountMax.set(did, maxPinned)
      const sdk = new FakeSdk(did, world)
      const agent = new FakeAgent(did, world)
      return { sdk, agent, did, handle }
    },
  }
}

export function resetAllStores(): void {
  useAuthStore.getState().reset()
  useFeedStore.getState().reset()
  usePinStore.getState().reset()
  useUploadQueueStore.getState().reset()
  useComposeStore.getState().disarm()
  useToastStore.setState({ toasts: [] })
  // The persist middleware re-reads localStorage on rehydrate; nuke it
  // so the next test starts genuinely clean.
  localStorage.clear()
  setCurrentWorld(null)
}

export function mountAs(
  account: FakeAccount,
  options: {
    subscriptions?: SubscriptionRef[]
    myChannels?: Array<{
      channelID: string
      channelKey: string
      name: string
      createdAt?: string
    }>
  } = {},
): void {
  useAuthStore.setState({
    sdk: account.sdk as unknown as Sdk,
    atprotoAgent: account.agent as unknown as Agent,
    atprotoDID: account.did,
    atprotoHandle: account.handle,
    storedKeyHex: 'fake-key-hex',
    indexerURL: 'https://indexer.fake',
    step: 'connected',
    subscriptions: options.subscriptions ?? [],
    myChannels: (options.myChannels ?? []).map((c) => ({
      ...c,
      createdAt: c.createdAt ?? new Date().toISOString(),
    })),
    settingsLoaded: true,
    error: null,
  })
}
