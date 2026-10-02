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
  newChannelKey,
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
import { useReadingStore } from '../stores/reading'
import { useToastStore } from '../stores/toast'
import { didOfSync, setCurrentWorld } from './fakeModules'
import { createFakeWorld, FakeSiaClient, type FakeWorld } from './fakeSia'

// A real-shaped AppKey hex (64 chars), because it's an HKDF input rather than an opaque
// label. For a test with no account in it. An ACCOUNT has its own — see `createAccount` —
// because every channel object is signed by its author's did and checked against the did a
// reader names, so two people in a test have to be two identities.
export const FAKE_APP_KEY_HEX = 'a1'.repeat(32)

/** A real-shaped AppKey for an account, derived from its label so a test reproduces. */
export function appKeyFor(label: string): string {
  // FNV-1a, stepped once per byte. Deterministic and distinct per label is all a test
  // needs here; nothing about it has to resist anyone.
  let h = 2166136261
  let out = ''
  for (let i = 0; i < 32; i++) {
    for (const c of `${i}:pin:fake-account:${label}`) {
      h ^= c.charCodeAt(0)
      h = Math.imul(h, 16777619) >>> 0
    }
    out += (h & 0xff).toString(16).padStart(2, '0')
  }
  return out
}

export type FakeAccount = {
  // The Sia surface the app talks to. Tests that need to assert on storage
  // directly (scope contents, byte totals) go through this too — there is no
  // lower layer to reach for, because the real one is Rust.
  client: FakeSiaClient
  // did/handle are test bookkeeping: the labels an account is filed under in the fake
  // world, which predate identities being did:dht.
  did: string
  handle: string
  // The account's own identity, as the app derives it: everything it publishes is sealed
  // as this AppKey's author and signed by this did.
  appKeyHex: string
  didDht: string
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
      const appKeyHex = appKeyFor(did)
      return {
        client: new FakeSiaClient(did, world),
        did,
        handle,
        appKeyHex,
        didDht: didOfSync(appKeyHex),
      }
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
  useReadingStore.setState({ channels: null })
  // The persist middleware re-reads localStorage on rehydrate; nuke it
  // so the next test starts genuinely clean.
  localStorage.clear()
  setCurrentWorld(null)
}

// The channel's current published manifest, read back off its locator (the
// same path a reader uses). Helpers read-modify-write against this instead of
// threading the manifest through the test.
async function loadChannelManifest(
  author: FakeAccount,
  channel: { channelKey: string },
): Promise<ChannelManifest> {
  const manifest = await resolveChannelViaLocator(
    channel.channelKey,
    author.didDht,
  )
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
  const item = await buildItemRef(uploaded, {
    type: 'text',
    title: '',
    summary: body,
    mimeType: 'text/markdown',
    bytes,
  })
  const current = await loadChannelManifest(author, channel)
  const manifest = await appendItemToChannel(current, item)
  await commitChannelManifest(
    client,
    author.appKeyHex,
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
  const built = await buildItemRef(uploaded, {
    type: 'text',
    title: '',
    summary: newBody,
    mimeType: 'text/markdown',
    bytes,
  })
  const newItem: ItemRef = { ...built, editedAt: new Date().toISOString() }
  const current = await loadChannelManifest(author, channel)
  const { manifest, item } = await editItem(current, oldItemID, newItem)
  await commitChannelManifest(
    client,
    author.appKeyHex,
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
    channelKey: await newChannelKey(),
    name: args.name,
    description: args.description ?? '',
  })
  await commitChannelManifest(
    client,
    author.appKeyHex,
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
    storedKeyHex: account.appKeyHex,
    myDidDht: account.didDht,
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
