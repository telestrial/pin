// Integration: ghost reconciliation classifies only owned channels whose
// atproto record is actually gone — a real channel survives, a ghost (entry
// with no record) is flagged for pruning. Backed by the fake agent/record
// store so it's deterministic and fast.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock(
  '@atproto/api',
  async () => (await import('./fakeModules')).fakeAtprotoApiModule(),
)
vi.mock(
  '../core/jetstream',
  async () => (await import('./fakeModules')).fakeJetstreamModule(),
)
vi.mock(
  '@siafoundation/sia-storage',
  async () => (await import('./fakeModules')).fakeSiaStorageModule(),
)

import { reconcileGhostChannels } from '../core/channels'
import { authorCreateChannel, createFakeApp, resetAllStores } from './setupFakeApp'

describe('integration: ghost reconciliation', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('flags only the channel whose record is missing', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: 'did:plc:alice', handle: 'alice.test' })
    const real = await authorCreateChannel(alice, { name: 'real channel' })

    const ghostID = 'ghostrkey00000000'
    const ghosts = await reconcileGhostChannels(alice.did, [
      real.channelID,
      ghostID,
    ])

    expect(ghosts).toEqual([ghostID])
  })

  it('flags nothing when every record exists', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: 'did:plc:alice', handle: 'alice.test' })
    const a = await authorCreateChannel(alice, { name: 'a' })
    const b = await authorCreateChannel(alice, { name: 'b' })

    const ghosts = await reconcileGhostChannels(alice.did, [
      a.channelID,
      b.channelID,
    ])

    expect(ghosts).toEqual([])
  })

  it('flags all when none exist (fully-orphaned settings)', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: 'did:plc:alice', handle: 'alice.test' })

    const ghosts = await reconcileGhostChannels(alice.did, ['g1aaaaaaaaaaaaaa', 'g2bbbbbbbbbbbbbb'])

    expect(ghosts.sort()).toEqual(['g1aaaaaaaaaaaaaa', 'g2bbbbbbbbbbbbbb'])
  })
})
