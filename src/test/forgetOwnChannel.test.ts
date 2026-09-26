// Retracting a channel you authored, on the local side.
//
// The create writes three things: the channel in `myChannels`, a subscription so your own
// voice is in your own feed, and — for a public channel — the self-follow that puts you
// among its followers. The retract is the inverse gesture and owns undoing all three.
//
// The follow is the one that cannot be left behind quietly. It is PUBLISHED: the identity
// loop assembles `settings.follows` into the directory blob the whole graph crawls, so a
// stale edge tells everyone you follow a channel whose locator no longer resolves. And
// nothing sweeps it up, nor should anything — a pass that rewrote follow edges would fight
// the unfollow, which deliberately leaves its tombstone standing.

import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '../stores/auth'

const CHANNEL = 'mychannel00000001'
const OTHER = 'otherchannel00001'

function owning() {
  useAuthStore.setState({
    myChannels: [
      {
        channelID: CHANNEL,
        channelKey: 'k1',
        name: 'Mine',
        createdAt: '2026-09-01T00:00:00.000Z',
        visibility: 'public',
      },
      {
        channelID: OTHER,
        channelKey: 'k2',
        name: 'Another',
        createdAt: '2026-09-01T00:00:00.000Z',
        visibility: 'public',
      },
    ],
    subscriptions: [
      {
        authorHandle: '',
        authorDID: '',
        didDht: 'did:dht:me',
        channelID: CHANNEL,
        channelKey: 'k1',
        addedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        authorHandle: '',
        authorDID: '',
        didDht: 'did:dht:them',
        channelID: 'theirs',
        channelKey: 'k3',
        addedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    follows: [
      { didDht: 'did:dht:me', channelID: CHANNEL, name: 'Mine' },
      { didDht: 'did:dht:them', channelID: 'theirs', name: 'Theirs' },
    ],
  })
}

describe('forgetOwnChannel', () => {
  beforeEach(owning)

  it('drops the channel, its subscription and its self-follow together', () => {
    useAuthStore.getState().forgetOwnChannel(CHANNEL)

    const s = useAuthStore.getState()
    expect(s.myChannels.map((c) => c.channelID)).toEqual([OTHER])
    expect(s.subscriptions.map((x) => x.channelID)).toEqual(['theirs'])
    expect(s.follows.map((f) => f.channelID)).toEqual(['theirs'])
  })

  it('touches nothing that names another channel', () => {
    // Keyed on channelID alone, which already names one channel and nothing else — a
    // retract that swept by author would take every voice the same person publishes.
    useAuthStore.getState().forgetOwnChannel('nothing-by-this-id')

    const s = useAuthStore.getState()
    expect(s.myChannels).toHaveLength(2)
    expect(s.subscriptions).toHaveLength(2)
    expect(s.follows).toHaveLength(2)
  })
})
