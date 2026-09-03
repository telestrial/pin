// The reach ladder: what the crawl already holds is preferred over resolving somebody
// again.
//
// `makeReach` backs the walk in `core/network` — the mention pool's candidate list and the
// reachable-people count both run through it. It has two rungs, and the thing worth
// locking is the ORDER, which is invisible to a test that only stocks one of them: with
// only the network stocked, a broken index still passes. So every case here stocks the two
// rungs with DIFFERENT answers and asserts which one came back.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { directory_collection } from '../../crates/pin-core/pkg/pin_core.js'
import { DIRECTORY_DOC_VERSION } from '../core/identityDoc'
import { makeReach } from '../lib/reach'
import {
  fakeDocStore as docStore,
  publishFakeDirectory,
  unpublishFakeDirectory,
} from './fakeModules'
import {
  createFakeApp,
  FAKE_APP_KEY_HEX,
  type FakeAccount,
  resetAllStores,
} from './setupFakeApp'

const THEM = 'did:dht:them'
const HELD_FOLLOW = 'did:dht:heldfollow'
const NETWORK_FOLLOW = 'did:dht:networkfollow'

/** What the crawl recorded about them. */
function hold(didDht: string, username: string, follows: string[]) {
  docStore.set(
    `${directory_collection()}/${didDht}`,
    new TextEncoder().encode(
      JSON.stringify({
        profile: { username },
        channels: [],
        reach: [],
        follows: follows.map((f) => ({ didDht: f, channelID: 'c1' })),
        handleFollows: [],
        url: 'sia://held',
        epoch: 1,
        seenAt: '2026-09-01T12:00:00.000Z',
      }),
    ),
  )
}

/** What they currently publish about themselves, over pkarr and Sia. */
async function publish(didDht: string, username: string, follows: string[]) {
  await publishFakeDirectory(didDht, {
    version: DIRECTORY_DOC_VERSION,
    profile: { username },
    channels: [],
    follows: follows.map((f) => ({ didDht: f, channelID: 'c1' })),
    handleFollows: [],
    updatedAt: new Date().toISOString(),
  })
}

describe('the reach ladder', () => {
  let me: FakeAccount

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    me = createFakeApp().createAccount({
      did: 'did:plc:me',
      handle: 'me.test',
    })
  })

  it('answers from what the crawl holds rather than resolving again', async () => {
    // Both rungs stocked, disagreeing. The network copy is the one that must NOT win —
    // it costs a DHT lookup and a Sia download to learn what is already in the doc.
    hold(THEM, 'from-the-index', [HELD_FOLLOW])
    await publish(THEM, 'from-the-network', [NETWORK_FOLLOW])

    const { fetch, resolve } = makeReach(me.client, FAKE_APP_KEY_HEX)

    expect(await fetch(THEM)).toEqual([HELD_FOLLOW])
    expect((await resolve(THEM))?.username).toBe('from-the-index')
  })

  it('resolves anyone the crawl has not reached', async () => {
    // The frontier case, and the reason the second rung stays: an identity nobody has
    // crawled is the ordinary state, not a failure.
    await publish(THEM, 'from-the-network', [NETWORK_FOLLOW])

    const { fetch, resolve } = makeReach(me.client, FAKE_APP_KEY_HEX)

    expect(await fetch(THEM)).toEqual([NETWORK_FOLLOW])
    expect((await resolve(THEM))?.username).toBe('from-the-network')
  })

  it('skips the index entirely when given no key', async () => {
    // How the socialGraph harness drives the walk, and how any caller with no open doc
    // does. A held record must not leak into a build that did not ask for one.
    hold(THEM, 'from-the-index', [HELD_FOLLOW])
    await publish(THEM, 'from-the-network', [NETWORK_FOLLOW])

    const { fetch, resolve } = makeReach(me.client)

    expect(await fetch(THEM)).toEqual([NETWORK_FOLLOW])
    expect((await resolve(THEM))?.username).toBe('from-the-network')
  })

  it('keeps answering for a held identity whose record is off the DHT', async () => {
    // Relay lag and propagation gaps are routine on the browser tier, and this is the
    // rung that makes them survivable: what we hold answers without asking anyone.
    hold(THEM, 'from-the-index', [HELD_FOLLOW])
    unpublishFakeDirectory(THEM)

    const { fetch, resolve } = makeReach(me.client, FAKE_APP_KEY_HEX)

    expect(await fetch(THEM)).toEqual([HELD_FOLLOW])
    expect((await resolve(THEM))?.username).toBe('from-the-index')
  })

  it('names an identity it can reach on neither rung by a short did', async () => {
    // Never dropped for being unreachable: a walk that omitted them would make a person
    // vanish from a mention pool because a lookup failed once.
    const { fetch, resolve } = makeReach(me.client, FAKE_APP_KEY_HEX)

    expect(await fetch(THEM)).toEqual([])
    expect((await resolve(THEM))?.handle).toBe('did:dht:…them')
  })
})
