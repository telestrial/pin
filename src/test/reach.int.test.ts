// The reach ladder: what the crawl already holds is preferred over resolving somebody
// again.
//
// `makeReach` backs the walk in `core/network` — the mention pool's candidate list and the
// reachable-people count both run through it. It has two rungs, and the thing worth
// locking is the ORDER, which is invisible to a test that only stocks one of them: with
// only the network stocked, a broken index still passes. So every case here stocks the two
// rungs with DIFFERENT answers and asserts which one came back.

import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import {
  directory_collection,
  request_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
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

/** What the crawl recorded about them, at the tier it still holds them. */
function hold(
  didDht: string,
  username: string,
  follows: string[],
  tier = 'full',
) {
  docStore.set(
    `${directory_collection()}/${didDht}`,
    new TextEncoder().encode(
      JSON.stringify({
        tier,
        profile: tier === 'full' ? { username } : null,
        channels: [],
        reach: [],
        follows:
          tier === 'minimal'
            ? []
            : follows.map((f) => ({ didDht: f, channelID: 'c1' })),
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

  it('asks the crawl to read anyone it had to resolve', async () => {
    // The one input to the crawl's order that does not come from the graph. A walk that
    // went to the network is a walk that will go again next session unless something
    // records that this person was wanted.
    await publish(THEM, 'from-the-network', [NETWORK_FOLLOW])

    const { resolve } = makeReach(me.client, FAKE_APP_KEY_HEX)
    await resolve(THEM)

    await waitFor(() =>
      expect(docStore.has(`${request_collection()}/${THEM}`)).toBe(true),
    )
  })

  it('walks through a reduced record on the edges it still carries', async () => {
    // The reduced tier exists so distance keeps propagating and the horizon fades rather
    // than cutting. Its profile is gone, which degrades to a short did — the same fallback
    // as somebody who chose no @-name — but its edges are real and cost nothing.
    hold(THEM, '', [HELD_FOLLOW], 'reduced')
    await publish(THEM, 'from-the-network', [NETWORK_FOLLOW])

    const { fetch, resolve } = makeReach(me.client, FAKE_APP_KEY_HEX)

    expect(await fetch(THEM)).toEqual([HELD_FOLLOW])
    expect((await resolve(THEM))?.handle).toBe('did:dht:…them')
  })

  it('resolves a minimal record rather than reading it as nobody to walk to', async () => {
    // A minimal record kept the way back to them and nothing else, so its empty follows
    // are what the crawl dropped rather than what they publish. Reading that as an answer
    // stops a walk AT them instead of THROUGH them, and every branch behind them goes
    // missing — deny-by-absence, in the shape of the sweep that once near-wiped an account.
    hold(THEM, '', [], 'minimal')
    await publish(THEM, 'from-the-network', [NETWORK_FOLLOW])

    const { fetch } = makeReach(me.client, FAKE_APP_KEY_HEX)

    expect(await fetch(THEM)).toEqual([NETWORK_FOLLOW])
  })

  it('asks for nobody whose record the crawl faded on purpose', async () => {
    // A record fades because the crawl decided this person is past the horizon. A
    // transitive hop in a walk is not somebody looking at them, so asking would read them
    // back in full only to fade them again, on every walk, forever. A screen that actually
    // renders them still asks.
    hold(THEM, '', [], 'minimal')
    await publish(THEM, 'from-the-network', [NETWORK_FOLLOW])

    const { fetch } = makeReach(me.client, FAKE_APP_KEY_HEX)
    await fetch(THEM)
    await new Promise((r) => setTimeout(r, 10))

    expect(docStore.has(`${request_collection()}/${THEM}`)).toBe(false)
  })

  it('asks for nobody it could answer from what is held', async () => {
    // A request is for somebody who could not be answered. Nominating a held identity
    // would have the crawl spend its budget re-reading what it already has.
    hold(THEM, 'from-the-index', [HELD_FOLLOW])

    const { resolve } = makeReach(me.client, FAKE_APP_KEY_HEX)
    await resolve(THEM)

    expect(docStore.has(`${request_collection()}/${THEM}`)).toBe(false)
  })

  it('asks once however many times the same person is looked at', async () => {
    // Every write to this doc is announced to every syncing instance AND a reason to
    // mirror the whole doc to Sia. A feed re-rendering the same unresolved person must not
    // cost a write per render — that is the shape of the churn bug of 2026-08-29, which
    // re-uploaded an idle account's entire doc every seventeen seconds.
    await publish(THEM, 'from-the-network', [NETWORK_FOLLOW])

    const { resolve } = makeReach(me.client, FAKE_APP_KEY_HEX)
    await resolve(THEM)
    await waitFor(() =>
      expect(docStore.has(`${request_collection()}/${THEM}`)).toBe(true),
    )
    const first = docStore.get(`${request_collection()}/${THEM}`)

    // A fresh build, so the per-build memo does not answer instead of the doc.
    await makeReach(me.client, FAKE_APP_KEY_HEX).resolve(THEM)
    await new Promise((r) => setTimeout(r, 10))

    expect(docStore.get(`${request_collection()}/${THEM}`)).toBe(first)
  })

  it('names an identity it can reach on neither rung by a short did', async () => {
    // Never dropped for being unreachable: a walk that omitted them would make a person
    // vanish from a mention pool because a lookup failed once.
    const { fetch, resolve } = makeReach(me.client, FAKE_APP_KEY_HEX)

    expect(await fetch(THEM)).toEqual([])
    expect((await resolve(THEM))?.handle).toBe('did:dht:…them')
  })
})
