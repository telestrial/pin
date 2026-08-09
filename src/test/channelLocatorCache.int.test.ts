// Resolution-ladder step 1: the feed reader (makeCachingLocatorReader) resolves a
// subscribed channel via its locator AND caches the EXACT ciphertext into the
// shared iroh-docs doc at sub/<channelID>, as a fire-and-forget side effect. Read
// behavior is unchanged (still resolves, still fresh); this locks that the cache
// gets seeded and that the cached blob decodes back to the same manifest — the
// property step 3 (read-doc-first) will rely on.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)

// The shared doc, faked: this file reads back what the caching reader wrote, and
// publish state rides the same store.
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { createChannel } from '../core/channels'
import {
  channelKeyFromBase64,
  decryptForChannel,
  encryptForChannel,
} from '../core/crypto'
import type { ChannelManifest, ItemRef, SubscriptionRef } from '../core/types'
import {
  commitChannelManifest,
  makeCachingLocatorReader,
} from '../lib/channelLocator'
import { applyCachedChannel, applyIfChanged } from '../lib/channelRevalidate'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

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
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
      created.manifest,
    )

    const reader = makeCachingLocatorReader('deadbeef', new Set())
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
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
      created.manifest,
    )

    // A doc write that throws must not break the read (cache is best-effort).
    const reader = makeCachingLocatorReader('', new Set())
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
      FAKE_APP_KEY_HEX,
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
    const reader = makeCachingLocatorReader('deadbeef', new Set())
    const m = await reader('', created.channelID, created.channelKey)
    expect(m.name).toBe('Cached')
  })

  // An explicit user Refresh must beat the cache, or it's the one control a reader
  // has and it can never show anything the background pass hasn't already cached.
  it('bypasses the cache for a subscribed channel when asked for a fresh read', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice8',
      handle: 'alice8.test',
    })
    const client = alice.client
    const created = await createChannel(client, {
      name: 'Current',
      description: '',
    })
    await commitChannelManifest(
      client,
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
      created.manifest,
    )
    // A stale cache entry that a normal read would happily serve.
    const kBytes = channelKeyFromBase64(created.channelKey)
    docStore.set(
      `sub/${created.channelID}`,
      new TextEncoder().encode(
        await encryptForChannel(
          kBytes,
          JSON.stringify({ ...created.manifest, name: 'Stale' }),
        ),
      ),
    )

    const reader = makeCachingLocatorReader('deadbeef', new Set())
    // Normal read: cache wins (fast path).
    expect((await reader('', created.channelID, created.channelKey)).name).toBe(
      'Stale',
    )
    // Fresh read: goes to the network instead.
    expect(
      (await reader('', created.channelID, created.channelKey, true)).name,
    ).toBe('Current')

    // ...and the fresh read re-seeds the cache, so the fast path is correct after.
    await vi.waitFor(async () => {
      const cached = docStore.get(`sub/${created.channelID}`)!
      const decoded = JSON.parse(
        await decryptForChannel(kBytes, new TextDecoder().decode(cached)),
      )
      expect(decoded.name).toBe('Current')
    })
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
      FAKE_APP_KEY_HEX,
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
      'deadbeef',
      new Set([created.channelID]),
    )
    const m = await reader('', created.channelID, created.channelKey)
    expect(m.name).toBe('Fresh')
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

  it('applyIfChanged refuses a manifest older than the one on screen', async () => {
    // The flash-then-vanish bug. A manifest reaches the feed from several places that
    // disagree — a peer device's fresh copy syncing in, this instance's own pass
    // resolving through relays that lag minutes behind. Without a recency check the
    // last writer wins, so a stale resolve un-publishes a post that's already visible.
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice8',
      handle: 'alice8.test',
    })
    const created = await createChannel(alice.client, {
      name: 'Ordered',
      description: '',
    })
    const sub = subFor(created.channelID, created.channelKey)

    const older: ChannelManifest = {
      ...created.manifest,
      publishedAt: '2026-08-01T11:00:00.000Z',
    }
    const newer = {
      ...withPost(created.manifest, 'the post'),
      publishedAt: '2026-08-01T12:00:00.000Z',
    }

    expect(applyIfChanged(sub, newer)).toBe(true)
    expect(useFeedStore.getState().entries).toHaveLength(1)

    // The stale one differs, so a difference-only check would apply it and the post
    // would vanish.
    expect(applyIfChanged(sub, older)).toBe(false)
    expect(useFeedStore.getState().entries).toHaveLength(1)

    // Forward still moves: a later manifest applies over the one being protected.
    const newest = {
      ...withPost(newer, 'a second post'),
      publishedAt: '2026-08-01T13:00:00.000Z',
    }
    expect(applyIfChanged(sub, newest)).toBe(true)
    expect(useFeedStore.getState().entries).toHaveLength(2)
  })

  it('applyCachedChannel surfaces a newly cached manifest and re-reads as a no-op', async () => {
    // The proof that the Curator's pull loop reaches the screen. The loop is Rust and
    // writes `sub/<id>`; this is the frontend half — a cached record becomes what the
    // feed shows. Standing in for the loop here is a direct cache write, because what
    // needs proving is the half that runs in the browser.
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
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
      created.manifest,
    )
    const sub = subFor(created.channelID, created.channelKey)

    // v1 is in the feed, as a first read would have left it.
    applyIfChanged(sub, created.manifest)
    expect(useFeedStore.getState().entries).toHaveLength(0)

    // The author publishes, and a pass caches the new manifest. Reads serve the cache,
    // so nothing the user does would surface this on its own.
    const v2 = withPost(created.manifest, 'fresh post')
    await commitChannelManifest(
      client,
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
      v2,
    )
    // What the Rust loop does: seal under K, write to sub/<id>. Nothing about the
    // blob is loop-specific — it's byte-identical to Sia's copy either way.
    docStore.set(
      `sub/${created.channelID}`,
      new TextEncoder().encode(
        await encryptForChannel(
          channelKeyFromBase64(created.channelKey),
          JSON.stringify(v2),
        ),
      ),
    )

    // Reading the cache back is what puts it on screen.
    expect(await applyCachedChannel(sub)).toBe(true)
    expect(useFeedStore.getState().entries.map((e) => e.item.summary)).toEqual([
      'fresh post',
    ])

    // A re-read with nothing new must report no change — the loop writes a record
    // every pass, so this is what keeps a quiet pass from re-rendering the feed.
    const entriesAfter = useFeedStore.getState().entries
    expect(await applyCachedChannel(sub)).toBe(false)
    expect(useFeedStore.getState().entries).toBe(entriesAfter)
  })

  it('applyCachedChannel is a no-op when nothing is cached yet', async () => {
    // A cold instance whose loop hasn't completed a pass. Reading must be quiet, not
    // an error — the reader falls through to a fresh resolve in that case.
    const sub = subFor('nevercached', 'AAAA')
    expect(await applyCachedChannel(sub)).toBe(false)
  })

  it('serves an owned channel from the doc, so a rewrite elsewhere reaches it', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    const created = await createChannel(alice.client, {
      name: 'Mine',
      description: '',
    })
    await commitChannelManifest(
      alice.client,
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
      created.manifest,
    )

    // Stand in for the Curator's repack, or another of your devices: the record moves
    // without this tab doing anything. Reading fresh from the locator would miss it,
    // which is the whole reason owned channels stopped being excluded from the doc.
    const rewritten = { ...created.manifest, name: 'Repacked' }
    docStore.set(
      `channel/${created.channelID}`,
      new TextEncoder().encode(
        await encryptForChannel(
          channelKeyFromBase64(created.channelKey),
          JSON.stringify(rewritten),
        ),
      ),
    )

    const reader = makeCachingLocatorReader(
      FAKE_APP_KEY_HEX,
      new Set([created.channelID]),
    )
    const seen = await reader('', created.channelID, created.channelKey)
    expect(seen.name).toBe('Repacked')

    // And an explicit Refresh still bypasses it for the network's answer.
    const forced = await reader('', created.channelID, created.channelKey, true)
    expect(forced.name).toBe('Mine')
  })
})
