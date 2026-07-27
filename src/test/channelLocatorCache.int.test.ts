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
}))

import { createChannel } from '../core/channels'
import { channelKeyFromBase64, decryptForChannel } from '../core/crypto'
import {
  commitChannelManifest,
  makeCachingLocatorReader,
} from '../lib/channelLocator'
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

    const reader = makeCachingLocatorReader(client, 'deadbeef')
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
    const reader = makeCachingLocatorReader(client, '')
    const manifest = await reader('', created.channelID, created.channelKey)
    expect(manifest.name).toBe('Resilient')
  })
})
