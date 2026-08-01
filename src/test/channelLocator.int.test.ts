// Grace deletion for channel-manifest generations. A pkarr publish takes
// seconds to propagate on the Mainline DHT, so right after a commit a reader can
// still resolve the PREVIOUS pointer. commitChannelManifest must therefore keep
// the current + immediately-previous manifest object alive and only reclaim the
// generation two commits back — otherwise a slightly-stale reader hits
// "object not found" (the real-network bug this guards against). The fake pkarr
// has no propagation lag, so this can't reproduce the race directly; it locks
// the keep-2 reclamation logic that fixes it.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)

import { createChannel } from '../core/channels'
import type { ChannelManifest, ItemRef } from '../core/types'
import {
  commitChannelManifest,
  resolveChannelViaLocator,
} from '../lib/channelLocator'
import { createFakeApp, resetAllStores } from './setupFakeApp'

function withItem(manifest: ChannelManifest, n: number): ChannelManifest {
  const item = {
    id: `item-${n}`,
    itemURL: `sia://item-${n}`,
    type: 'text',
    title: '',
    summary: `post ${n}`,
    publishedAt: `2026-07-20T00:00:0${n}.000Z`,
    mimeType: 'text/markdown',
    byteSize: 1,
    contentHash: `hash-${n}`,
  } as ItemRef
  return { ...manifest, items: [item, ...manifest.items] }
}

describe('integration: channel locator grace deletion', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('keeps the current + previous manifest object, reclaims two-generations-back', async () => {
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
    const channel = {
      channelID: created.channelID,
      channelKey: created.channelKey,
    }

    // Commit 1 (empty). One manifest object, nothing to reclaim yet.
    await commitChannelManifest(
      client,
      channel.channelID,
      channel.channelKey,
      created.manifest,
    )
    expect(app.world.objects.size).toBe(1)

    // Commit 2. Both generations kept — a reader still resolving gen-1's pointer
    // during DHT propagation must find it.
    const m2 = withItem(created.manifest, 2)
    await commitChannelManifest(
      client,
      channel.channelID,
      channel.channelKey,
      m2,
    )
    expect(app.world.objects.size).toBe(2)

    // Commit 3. Gen-1 (two back) is reclaimed; gen-2 + gen-3 stay live.
    const m3 = withItem(m2, 3)
    await commitChannelManifest(
      client,
      channel.channelID,
      channel.channelKey,
      m3,
    )
    expect(app.world.objects.size).toBe(2)

    // Steady state: further commits stay bounded at two live objects.
    const m4 = withItem(m3, 4)
    await commitChannelManifest(
      client,
      channel.channelID,
      channel.channelKey,
      m4,
    )
    expect(app.world.objects.size).toBe(2)

    // And the locator resolves to the latest manifest throughout.
    const resolved = await resolveChannelViaLocator(channel.channelKey)
    expect(resolved?.items.map((i) => i.summary)).toEqual([
      'post 4',
      'post 3',
      'post 2',
    ])
  })
})
