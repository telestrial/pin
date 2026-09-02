// Reading what the crawl recorded about other identities.
//
// The Curator's crawl is the only writer of these records and it does not run here, so
// what these cover is the reading half of a seam whose two sides are written in different
// languages. The record below is the exact shape `pin-curator`'s `discover` serializes —
// pinned there by `the_serialized_shape_is_the_one_the_frontend_reads`, and pinned here by
// being consumed field by field. Either side moving alone fails one of the two.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { directory_collection } from '../../crates/pin-core/pkg/pin_core.js'
import {
  listDirectories,
  listDirectoryDids,
  readDirectory,
} from '../lib/directories'
import { fakeDocStore as docStore } from './fakeModules'
import { FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

const ALICE = 'did:dht:alice'
const BOB = 'did:dht:bob'

/** A directory record exactly as the crawl writes one.
 *
 *  Field names are the assertion here as much as the values: `nodeID` and `handleFollows`
 *  are the two a `rename_all` on the Rust side would spell differently, and an address
 *  spelled two ways has one side writing where the other never looks. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      $type: 'dev.sia.pin.profile',
      username: 'alice',
      displayName: 'Alice',
      avatarURL: 'sia://avatar#encryption_key=a',
    },
    channels: [{ channelID: 'chan-one', key: 'AAAA', name: 'First' }],
    reach: [{ nodeID: 'aaa', relay: 'https://use1-1.relay.n0.iroh.link./' }],
    follows: [{ didDht: BOB, channelID: 'c1', name: 'Theirs' }],
    handleFollows: ['did:dht:carol'],
    url: 'sia://their-directory',
    epoch: 1,
    seenAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  }
}

function hold(didDht: string, value: unknown) {
  docStore.set(
    `${directory_collection()}/${didDht}`,
    new TextEncoder().encode(JSON.stringify(value)),
  )
}

describe('reading held directories', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('reads back every field the crawl recorded', async () => {
    hold(ALICE, record())

    const held = await readDirectory(FAKE_APP_KEY_HEX, ALICE)

    expect(held?.profile?.username).toBe('alice')
    expect(held?.profile?.avatarURL).toBe('sia://avatar#encryption_key=a')
    // The channel's K, which is what makes it readable to whoever holds this record.
    expect(held?.channels).toEqual([
      { channelID: 'chan-one', key: 'AAAA', name: 'First' },
    ])
    // Where to reach them. Spelled `nodeID`, not `nodeId`.
    expect(held?.reach).toEqual([
      { nodeID: 'aaa', relay: 'https://use1-1.relay.n0.iroh.link./' },
    ])
    // The edges the frontier is derived from: a follow whose did was dropped is a person
    // who can never be discovered.
    expect(held?.follows.map((f) => f.didDht)).toEqual([BOB])
    expect(held?.handleFollows).toEqual(['did:dht:carol'])
    expect(held?.seenAt).toBe('2026-09-01T12:00:00.000Z')
  })

  it('reads an identity nobody has crawled as not held', async () => {
    // Ordinary rather than an error: unresolved is the state every identity starts in,
    // and it is the branch that sends a caller to the network.
    expect(await readDirectory(FAKE_APP_KEY_HEX, ALICE)).toBeNull()
  })

  it('reads a published null profile as no profile', async () => {
    // The identity publisher writes an explicit null rather than omitting the key, and
    // the crawl carries that through. A caller has to be able to tell "they publish no
    // profile" from "a profile whose every field is missing".
    hold(ALICE, record({ profile: null }))
    const held = await readDirectory(FAKE_APP_KEY_HEX, ALICE)
    expect(held).not.toBeNull()
    expect(held?.profile).toBeNull()
  })

  it('lists every identity the crawl has read', async () => {
    hold(ALICE, record())
    hold(BOB, record({ profile: { username: 'bob' } }))

    expect((await listDirectoryDids(FAKE_APP_KEY_HEX)).sort()).toEqual(
      [ALICE, BOB].sort(),
    )

    const all = await listDirectories(FAKE_APP_KEY_HEX)
    expect(all.map((h) => h.didDht).sort()).toEqual([ALICE, BOB].sort())
    expect(all.find((h) => h.didDht === BOB)?.record.profile?.username).toBe(
      'bob',
    )
  })

  it('skips a record that will not parse rather than losing the index', async () => {
    // One unreadable entry among many must not cost a caller everything else the crawl
    // found — the same posture the Rust parse takes toward one malformed channel inside a
    // directory.
    hold(ALICE, record())
    docStore.set(
      `${directory_collection()}/${BOB}`,
      new TextEncoder().encode('{not json'),
    )

    const all = await listDirectories(FAKE_APP_KEY_HEX)
    expect(all.map((h) => h.didDht)).toEqual([ALICE])
  })
})
