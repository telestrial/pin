// Resolution-ladder step 1: the feed reader (makeCachingLocatorReader) resolves a
// subscribed channel via its locator AND caches the EXACT ciphertext into the
// shared iroh-docs doc at sub/<channelID>, as a fire-and-forget side effect. Read
// behavior is unchanged (still resolves, still fresh); this locks that the cache
// gets seeded and that the cached blob decodes back to the same manifest — the
// property step 3 (read-doc-first) will rely on.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@siafoundation/sia-storage', async () =>
  (await import('./fakeModules')).fakeSiaStorageModule(),
)
vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)

// Capture what the caching reader writes into the shared doc.
const docStore = new Map<string, Uint8Array>()
vi.mock('../lib/docs', () => ({
  openDocs: async () => '',
  putRecord: async (collection: string, rkey: string, value: Uint8Array) => {
    docStore.set(`${collection}/${rkey}`, value)
  },
  getRecord: async (collection: string, rkey: string) =>
    docStore.get(`${collection}/${rkey}`),
  deleteRecord: async (collection: string, rkey: string) => {
    docStore.delete(`${collection}/${rkey}`)
  },
}))

import { createChannel } from '../core/channels'
import {
  channelKeyFromBase64,
  decryptForChannel,
  encryptForChannel,
} from '../core/crypto'
import type { ChannelManifest, ItemRef, SubscriptionRef } from '../core/types'
import {
  cacheSubscribedChannel,
  commitChannelManifest,
  dropSubscribedChannel,
  makeCachingLocatorReader,
} from '../lib/channelLocator'
import {
  applyIfChanged,
  revalidateSubscribedChannel,
} from '../lib/channelRevalidate'
import { useFeedStore } from '../stores/feed'
import { createFakeApp, resetAllStores } from './setupFakeApp'

describe('integration: caching locator reader seeds sub/<id>', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('returns the manifest AND caches the exact ciphertext under sub/<channelID>', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    const client = alice.client

    const created = await createChannel(client, {
      name: "Alice's voice",
      description: '',
    })
    // Publish the locator so it resolves (createChannel builds the manifest;
    // commit is what puts the pointer + Sia object in place).
    await commitChannelManifest(
      client,
      created.channelID,
      created.channelKey,
      created.manifest,
    )

    const reader = makeCachingLocatorReader(client, 'deadbeef', new Set())
    const manifest = await reader('', created.channelID, created.channelKey)
    expect(manifest.name).toBe("Alice's voice")

    // The cache-back is fire-and-forget; wait for it to land.
    await vi.waitFor(() =>
      expect(docStore.has(`sub/${created.channelID}`)).toBe(true),
    )

    // The cached blob is the EXACT ciphertext — decrypting it with K yields the
    // same manifest the reader returned (the byte-identical decode step 3 needs).
    const cached = docStore.get(`sub/${created.channelID}`)!
    const kBytes = channelKeyFromBase64(created.channelKey)
    const decoded = JSON.parse(
      await decryptForChannel(kBytes, new TextDecoder().decode(cached)),
    )
    expect(decoded).toEqual(manifest)
  })

  it('does not throw the read even when the doc write fails', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice2',
      handle: 'alice2.test',
    })
    const client = alice.client
    const created = await createChannel(client, {
      name: 'Resilient',
      description: '',
    })
    await commitChannelManifest(
      client,
      created.channelID,
      created.channelKey,
      created.manifest,
    )

    // A doc write that throws must not break the read (cache is best-effort).
    const reader = makeCachingLocatorReader(client, '', new Set())
    const manifest = await reader('', created.channelID, created.channelKey)
    expect(manifest.name).toBe('Resilient')
  })

  // Step 3: the reader prefers the shared-doc cache for a SUBSCRIBED channel, and
  // resolves fresh (ignoring the cache) for an OWNED one.
  it('reads a subscribed channel from the shared-doc cache without resolving', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice5',
      handle: 'alice5.test',
    })
    const client = alice.client
    const created = await createChannel(client, {
      name: 'Fresh',
      description: '',
    })
    await commitChannelManifest(
      client,
      created.channelID,
      created.channelKey,
      created.manifest,
    )
    // Seed the cache with a DIFFERENT manifest so we can tell cache-read from
    // fresh-resolve.
    const kBytes = channelKeyFromBase64(created.channelKey)
    const cachedCiphertext = await encryptForChannel(
      kBytes,
      JSON.stringify({ ...created.manifest, name: 'Cached' }),
    )
    docStore.set(
      `sub/${created.channelID}`,
      new TextEncoder().encode(cachedCiphertext),
    )

    // Not owned → serves the cached manifest.
    const reader = makeCachingLocatorReader(client, 'deadbeef', new Set())
    const m = await reader('', created.channelID, created.channelKey)
    expect(m.name).toBe('Cached')
  })

  it('resolves an OWNED channel fresh, ignoring the shared-doc cache', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice6',
      handle: 'alice6.test',
    })
    const client = alice.client
    const created = await createChannel(client, {
      name: 'Fresh',
      description: '',
    })
    await commitChannelManifest(
      client,
      created.channelID,
      created.channelKey,
      created.manifest,
    )
    const kBytes = channelKeyFromBase64(created.channelKey)
    docStore.set(
      `sub/${created.channelID}`,
      new TextEncoder().encode(
        await encryptForChannel(
          kBytes,
          JSON.stringify({ ...created.manifest, name: 'Cached' }),
        ),
      ),
    )

    // Owned → ignores the cache, resolves the fresh locator manifest.
    const reader = makeCachingLocatorReader(
      client,
      'deadbeef',
      new Set([created.channelID]),
    )
    const m = await reader('', created.channelID, created.channelKey)
    expect(m.name).toBe('Fresh')
  })

  // Step 2 primitives: the eager pull loop resolves + caches (awaited), and drops
  // the cache on unsubscribe.
  it('cacheSubscribedChannel caches a resolvable channel and returns null for an unpublished one', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice3',
      handle: 'alice3.test',
    })
    const client = alice.client

    const published = await createChannel(client, {
      name: 'Published',
      description: '',
    })
    await commitChannelManifest(
      client,
      published.channelID,
      published.channelKey,
      published.manifest,
    )
    const ok = await cacheSubscribedChannel(
      client,
      'deadbeef',
      published.channelID,
      published.channelKey,
    )
    // Returns the resolved manifest (not just a boolean) so the caller can act on
    // a content change — that's what revalidate builds on.
    expect(ok?.name).toBe('Published')
    expect(docStore.has(`sub/${published.channelID}`)).toBe(true)

    // A channel that was created but never committed has no published locator →
    // unresolvable → false, nothing cached.
    const uncommitted = await createChannel(client, {
      name: 'Uncommitted',
      description: '',
    })
    const miss = await cacheSubscribedChannel(
      client,
      'deadbeef',
      uncommitted.channelID,
      uncommitted.channelKey,
    )
    expect(miss).toBeNull()
    expect(docStore.has(`sub/${uncommitted.channelID}`)).toBe(false)
  })

  it('dropSubscribedChannel removes the cached record', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice4',
      handle: 'alice4.test',
    })
    const client = alice.client
    const ch = await createChannel(client, {
      name: 'Droppable',
      description: '',
    })
    await commitChannelManifest(
      client,
      ch.channelID,
      ch.channelKey,
      ch.manifest,
    )
    await cacheSubscribedChannel(
      client,
      'deadbeef',
      ch.channelID,
      ch.channelKey,
    )
    expect(docStore.has(`sub/${ch.channelID}`)).toBe(true)

    await dropSubscribedChannel('deadbeef', ch.channelID)
    expect(docStore.has(`sub/${ch.channelID}`)).toBe(false)
  })
})

// The out-of-band update path. Reads serve the cache (step 3), so a read can't
// notice the author published — the background check has to fill the feed in.
// This is the path ladder rung 1 (live-sync) lands on too, so it's tested as its
// own surface rather than only through the loop that currently drives it.
describe('integration: revalidate fills the feed in out of band', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  const subFor = (channelID: string, channelKey: string): SubscriptionRef => ({
    authorHandle: '',
    authorDID: '',
    didDht: 'did:dht:someauthor',
    channelID,
    channelKey,
    addedAt: new Date().toISOString(),
  })

  const withPost = (
    manifest: ChannelManifest,
    title: string,
  ): ChannelManifest => {
    const item: ItemRef = {
      id: `item-${title}`,
      itemURL: `sia://fake/${title}`,
      type: 'text',
      title: '',
      summary: title,
      publishedAt: new Date().toISOString(),
      mimeType: 'text/markdown',
      byteSize: title.length,
    }
    return { ...manifest, items: [item, ...manifest.items] }
  }

  it('applyIfChanged lands a manifest the feed has never seen', () => {
    const sub = subFor('chan1', 'key1')
    const manifest = withPost(
      {
        version: 1,
        name: 'Voice',
        description: '',
        authorPubkey: '',
        authorDidDht: 'did:dht:someauthor',
        publishedAt: new Date().toISOString(),
        items: [],
      } as unknown as ChannelManifest,
      'hello',
    )

    expect(applyIfChanged(sub, manifest)).toBe(true)
    const feed = useFeedStore.getState()
    expect(feed.manifests.chan1?.name).toBe('Voice')
    expect(feed.entries.map((e) => e.item.summary)).toEqual(['hello'])
  })

  it('applyIfChanged is a no-op on an unchanged manifest (no feed churn)', () => {
    const sub = subFor('chan2', 'key2')
    const manifest = withPost(
      {
        version: 1,
        name: 'Quiet',
        description: '',
        authorPubkey: '',
        authorDidDht: 'did:dht:someauthor',
        publishedAt: new Date().toISOString(),
        items: [],
      } as unknown as ChannelManifest,
      'only post',
    )
    expect(applyIfChanged(sub, manifest)).toBe(true)
    const entriesAfterFirst = useFeedStore.getState().entries

    // Same content, re-parsed the way a fresh resolve would deliver it.
    const reResolved = JSON.parse(JSON.stringify(manifest)) as ChannelManifest
    expect(applyIfChanged(sub, reResolved)).toBe(false)

    // Entry array identity preserved — a quiet pass must not rebuild entries,
    // or every cadence tick would re-render the feed.
    expect(useFeedStore.getState().entries).toBe(entriesAfterFirst)
  })

  it('revalidateSubscribedChannel picks up a new post and updates the feed', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice7',
      handle: 'alice7.test',
    })
    const client = alice.client

    const created = await createChannel(client, {
      name: 'Live',
      description: '',
    })
    await commitChannelManifest(
      client,
      created.channelID,
      created.channelKey,
      created.manifest,
    )
    const sub = subFor(created.channelID, created.channelKey)

    // The reader's first pass put v1 in the feed.
    applyIfChanged(sub, created.manifest)
    expect(useFeedStore.getState().entries).toHaveLength(0)

    // Author publishes. A cached read would still serve v1...
    const v2 = withPost(created.manifest, 'fresh post')
    await commitChannelManifest(
      client,
      created.channelID,
      created.channelKey,
      v2,
    )

    // ...so the background check is what surfaces it.
    const changed = await revalidateSubscribedChannel(client, 'deadbeef', sub)
    expect(changed).toBe(true)
    expect(useFeedStore.getState().entries.map((e) => e.item.summary)).toEqual([
      'fresh post',
    ])

    // And the same pass re-warmed the cache the reader serves, so a subsequent
    // read is both fast and current.
    const cached = docStore.get(`sub/${created.channelID}`)!
    const decoded = JSON.parse(
      await decryptForChannel(
        channelKeyFromBase64(created.channelKey),
        new TextDecoder().decode(cached),
      ),
    )
    expect(decoded.items).toHaveLength(1)

    // A second pass with nothing new must report no change.
    expect(await revalidateSubscribedChannel(client, 'deadbeef', sub)).toBe(
      false,
    )
  })
})
