// Test harness helpers for integration tests. Pulls in production stores
// (zustand) and the Phase 3 fakes; safe to import from a test body but
// NOT from a vi.mock factory (the factory would race the production
// modules it's replacing). See fakeModules.ts for the lean mock side.

import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import {
  appendItemToChannel,
  buildItemRef,
  type CreatedChannel,
  createChannel,
  editItem,
} from '../core/channels'
import { uploadItem } from '../core/sia'
import type { ChannelManifest, ItemRef, SubscriptionRef } from '../core/types'
import {
  commitChannelManifest,
  makeLocatorFirstReader,
  resolveChannelViaLocator,
} from '../lib/channelLocator'
import { useActionStore } from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import { useComposeStore } from '../stores/compose'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { FakeAgent, FakeRecordStore } from './fakeAgent'
import { setCurrentWorld } from './fakeModules'
import { createFakeWorld, FakeSdk, type FakeWorld } from './fakeSdk'

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
      world.handles.set(did, handle)
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
  useActionStore.getState().reset()
  useComposeStore.getState().disarm()
  useToastStore.setState({ toasts: [] })
  // The persist middleware re-reads localStorage on rehydrate; nuke it
  // so the next test starts genuinely clean.
  localStorage.clear()
  setCurrentWorld(null)
}

// The channel's current published manifest, read back off its locator (the
// same path a reader uses). Helpers read-modify-write against this instead of
// threading the manifest through the test.
async function loadChannelManifest(
  sdk: Sdk,
  channel: { channelKey: string },
): Promise<ChannelManifest> {
  const manifest = await resolveChannelViaLocator(sdk, channel.channelKey)
  if (!manifest) throw new Error('channel locator not resolvable')
  return manifest
}

// Convenience: author publishes a text post through the real locator write path
// (upload bytes → append to manifest → commit locator). Setup for int tests.
export async function publishTextPost(
  author: FakeAccount,
  channel: { channelID: string; channelKey: string },
  body: string,
): Promise<ItemRef> {
  const sdk = author.sdk as unknown as Sdk
  const bytes = new TextEncoder().encode(body)
  const uploaded = await uploadItem(sdk, bytes)
  const item = buildItemRef(uploaded, {
    type: 'text',
    title: '',
    summary: body,
    mimeType: 'text/markdown',
    bytes,
  })
  const current = await loadChannelManifest(sdk, channel)
  const manifest = appendItemToChannel(current, item)
  await commitChannelManifest(
    sdk,
    channel.channelID,
    channel.channelKey,
    manifest,
  )
  return item
}

// Convenience: author edits an existing text post in place. Uploads new bytes,
// swaps the manifest entry (preserving publishedAt), stamps editedAt, commits.
export async function editTextPost(
  author: FakeAccount,
  channel: { channelID: string; channelKey: string },
  oldItemID: string,
  newBody: string,
): Promise<ItemRef> {
  const sdk = author.sdk as unknown as Sdk
  const bytes = new TextEncoder().encode(newBody)
  const uploaded = await uploadItem(sdk, bytes)
  const newItem: ItemRef = {
    ...buildItemRef(uploaded, {
      type: 'text',
      title: '',
      summary: newBody,
      mimeType: 'text/markdown',
      bytes,
    }),
    editedAt: new Date().toISOString(),
  }
  const current = await loadChannelManifest(sdk, channel)
  const { manifest, item } = editItem(current, oldItemID, newItem)
  await commitChannelManifest(
    sdk,
    channel.channelID,
    channel.channelKey,
    manifest,
  )
  return item
}

// Convenience: author creates a channel and commits its locator.
export async function authorCreateChannel(
  author: FakeAccount,
  args: { name: string; description?: string } = { name: 'Channel' },
): Promise<CreatedChannel> {
  const sdk = author.sdk as unknown as Sdk
  const created = await createChannel(sdk, {
    name: args.name,
    description: args.description ?? '',
  })
  await commitChannelManifest(
    sdk,
    created.channelID,
    created.channelKey,
    created.manifest,
  )
  return created
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
  // Reads go locator-first (pkarr → Sia → atproto fallback), matching what
  // App's useChannelReader injects in production — so a subscriber's feed reads
  // the channel the author committed to the locator, not the (gone) atproto record.
  useFeedStore
    .getState()
    .setChannelReader(makeLocatorFirstReader(account.sdk as unknown as Sdk))
}
