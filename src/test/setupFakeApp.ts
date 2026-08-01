// Test harness helpers for integration tests. Pulls in production stores
// (zustand) and the Phase 3 fakes; safe to import from a test body but
// NOT from a vi.mock factory (the factory would race the production
// modules it's replacing). See fakeModules.ts for the lean mock side.

import {
  appendItemToChannel,
  buildItemRef,
  type CreatedChannel,
  createChannel,
  editItem,
} from '../core/channels'
import type { ChannelManifest, ItemRef, SubscriptionRef } from '../core/types'
import {
  commitChannelManifest,
  makeLocatorReader,
  resolveChannelViaLocator,
} from '../lib/channelLocator'
import { useActionStore } from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import { useComposeStore } from '../stores/compose'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { setCurrentWorld } from './fakeModules'
import { createFakeWorld, FakeSiaClient, type FakeWorld } from './fakeSia'

export type FakeAccount = {
  // The Sia surface the app talks to. Tests that need to assert on storage
  // directly (scope contents, byte totals) go through this too — there is no
  // lower layer to reach for, because the real one is Rust.
  client: FakeSiaClient
  // did/handle are test bookkeeping for building SubscriptionRefs; identity is
  // did:dht (derived from the AppKey) in the app itself.
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
  setCurrentWorld(world)
  return {
    world,
    createAccount: ({ did, handle, maxPinned }) => {
      if (maxPinned !== undefined) world.accountMax.set(did, maxPinned)
      world.handles.set(did, handle)
      return { client: new FakeSiaClient(did, world), did, handle }
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
async function loadChannelManifest(channel: {
  channelKey: string
}): Promise<ChannelManifest> {
  const manifest = await resolveChannelViaLocator(channel.channelKey)
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
  const client = author.client
  const bytes = new TextEncoder().encode(body)
  const uploaded = await client.uploadItem(bytes)
  const item = buildItemRef(uploaded, {
    type: 'text',
    title: '',
    summary: body,
    mimeType: 'text/markdown',
    bytes,
  })
  const current = await loadChannelManifest(channel)
  const manifest = appendItemToChannel(current, item)
  await commitChannelManifest(
    client,
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
  const client = author.client
  const bytes = new TextEncoder().encode(newBody)
  const uploaded = await client.uploadItem(bytes)
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
  const current = await loadChannelManifest(channel)
  const { manifest, item } = editItem(current, oldItemID, newItem)
  await commitChannelManifest(
    client,
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
  const client = author.client
  const created = await createChannel(client, {
    name: args.name,
    description: args.description ?? '',
  })
  await commitChannelManifest(
    client,
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
    client: account.client,
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
  // Reads go through the locator (pkarr → Sia), matching what App's
  // useChannelReader injects in production — so a subscriber's feed reads the
  // channel the author committed to the locator.
  useFeedStore.getState().setChannelReader(makeLocatorReader())
}
