// Engagement's floor rung, from the reader's side: a channel's published counts reach a
// screen through the same cache-then-resolve path its posts do.
//
// The Curator's loops normally fill that cache — the engagement loop for a channel this
// identity owns, the pull loop for a subscribed one. Neither runs here, which is the
// point: what these cover is the FALL-THROUGH, the rung that answers when no pass has
// come round yet. A just-pasted subscribe URL is exactly that case.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { createChannel } from '../core/channels'
import { channelKeyFromBase64 } from '../core/crypto'
import {
  commitChannelManifest,
  makeCachingLocatorReader,
} from '../lib/channelLocator'
import { readTally, warmChannelTallies } from '../lib/channelTallies'
import { fakeDocStore as docStore, publishFakeTallies } from './fakeModules'
import { createFakeApp, FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

const PUBLISHED_AT = '2026-08-13T10:00:00.000Z'

/** One subject's counts, in the shape a fold publishes. */
function aggregate(count: number) {
  return {
    kinds: {
      like: {
        count,
        setRoot: 'root-a',
        sampleActors: ['did:dht:bob'],
        retentionCheckedAt: PUBLISHED_AT,
      },
    },
    updatedAt: PUBLISHED_AT,
  }
}

async function aChannelWithCounts(did: string, count: number) {
  const app = createFakeApp()
  const alice = app.createAccount({ did, handle: `${did}.test` })
  const created = await createChannel(alice.client, {
    name: 'Counted',
    description: '',
  })
  await commitChannelManifest(
    alice.client,
    FAKE_APP_KEY_HEX,
    created.channelID,
    created.channelKey,
    created.manifest,
  )

  // What the author's Curator would have published to the channel's engagement locator.
  const k = channelKeyFromBase64(created.channelKey)
  const { engagement_subject } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  const subject = engagement_subject(created.channelID, PUBLISHED_AT, undefined)
  publishFakeTallies(k, { [subject]: aggregate(count) })

  return { ...created, subject }
}

describe('integration: a channel’s published counts reach a reader', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('caches every subject the author published, read back by the item it counts', async () => {
    const channel = await aChannelWithCounts('did:plc:tally1', 3)

    await warmChannelTallies(
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
    )

    // Read by the item, not by the subject: a row knows what it is rendering, and the
    // subject is derived from that. A mismatch between how the cache is keyed on write
    // and on read would be invisible to both compilers.
    const tally = await readTally(FAKE_APP_KEY_HEX, {
      channelID: channel.channelID,
      publishedAt: PUBLISHED_AT,
    })
    expect(tally?.kinds.like?.count).toBe(3)
    expect(tally?.kinds.like?.setRoot).toBe('root-a')
  })

  it('reports no counts for an item nobody endorsed', async () => {
    const channel = await aChannelWithCounts('did:plc:tally2', 1)
    await warmChannelTallies(
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
    )

    // A different item in the same channel. Absent reads the same as zero to a row, so
    // this must be null rather than the neighbouring item's count.
    const tally = await readTally(FAKE_APP_KEY_HEX, {
      channelID: channel.channelID,
      publishedAt: '2026-08-13T11:00:00.000Z',
    })
    expect(tally).toBeNull()
  })

  it('reports no counts for a channel whose author has published none', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:tally3',
      handle: 'tally3.test',
    })
    const created = await createChannel(alice.client, {
      name: 'Quiet',
      description: '',
    })
    await commitChannelManifest(
      alice.client,
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
      created.manifest,
    )

    // The common case by a wide margin — a channel nobody has endorsed has no tallies
    // object at all — and it must read as nothing rather than throwing.
    await warmChannelTallies(
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
    )
    expect(
      await readTally(FAKE_APP_KEY_HEX, {
        channelID: created.channelID,
        publishedAt: PUBLISHED_AT,
      }),
    ).toBeNull()
  })

  it('warms the counts when the feed resolves the channel', async () => {
    const channel = await aChannelWithCounts('did:plc:tally4', 7)

    // The fall-through is wired to the channel read rather than called separately, so a
    // reader that had to go to the network for the posts gets the counts with them.
    const reader = makeCachingLocatorReader(FAKE_APP_KEY_HEX, new Set())
    await reader('', channel.channelID, channel.channelKey)

    await vi.waitFor(async () =>
      expect(
        (
          await readTally(FAKE_APP_KEY_HEX, {
            channelID: channel.channelID,
            publishedAt: PUBLISHED_AT,
          })
        )?.kinds.like?.count,
      ).toBe(7),
    )
  })
})
