// Who follows somebody, out of what the crawl has read.
//
// A follow lives in the FOLLOWER's directory and nothing writes into the followed
// identity's scope, so a follower count can only ever be a reverse scan of the index.
// These lock what that scan counts — and, as much, what it declines to.

import { describe, expect, it } from 'vitest'
import {
  type FollowerEdges,
  followersOfChannel,
  followersOfPerson,
  ownFollowerEdges,
} from '../core/followers'

function who(
  didDht: string,
  handleFollows: string[] = [],
  follows: { didDht: string; channelID: string }[] = [],
): FollowerEdges {
  return { didDht, handleFollows, follows }
}

describe('followersOfPerson', () => {
  it('counts whoever names them as a wholesale follow', () => {
    const held = [
      who('did:a', ['did:target']),
      who('did:b', ['did:someone-else']),
      who('did:c', ['did:target', 'did:other']),
    ]
    expect(followersOfPerson(held, 'did:target')).toEqual(['did:a', 'did:c'])
  })

  it('does not count following a CHANNEL of theirs', () => {
    // The two grains are different claims. Following one voice is not following the
    // person, and merging them would leave a profile's number unable to say which it
    // meant — the channel's own count is where that follower is reported.
    const held = [
      who('did:a', [], [{ didDht: 'did:target', channelID: 'ch1' }]),
    ]
    expect(followersOfPerson(held, 'did:target')).toEqual([])
    expect(followersOfChannel(held, 'ch1')).toEqual(['did:a'])
  })

  it('never counts somebody as their own follower', () => {
    // A directory can name anybody, its own author included.
    const held = [who('did:target', ['did:target'])]
    expect(followersOfPerson(held, 'did:target')).toEqual([])
  })

  it('answers the same way twice and counts one identity once', () => {
    const held = [who('did:c', ['did:target']), who('did:a', ['did:target'])]
    expect(followersOfPerson(held, 'did:target')).toEqual(['did:a', 'did:c'])
  })
})

describe('followersOfChannel', () => {
  it('counts whoever names the channel, whatever author they name with it', () => {
    // A channelID is base32(sha256(K)) — it already names one channel and nothing else,
    // so requiring the author to match would drop a follower whose record disagrees
    // about who publishes it.
    const held = [
      who('did:a', [], [{ didDht: 'did:target', channelID: 'ch1' }]),
      who('did:b', [], [{ didDht: 'did:someone-else', channelID: 'ch1' }]),
      who('did:c', [], [{ didDht: 'did:target', channelID: 'ch2' }]),
    ]
    expect(followersOfChannel(held, 'ch1')).toEqual(['did:a', 'did:b'])
  })

  it('is empty for a channel nobody held has followed', () => {
    // Empty means the crawl has read nobody who follows it — never that nobody does.
    expect(followersOfChannel([who('did:a', ['did:x'])], 'ch1')).toEqual([])
  })
})

describe('ownFollowerEdges', () => {
  // The corpus is the held `directory/<did>` records and there is never one for you, so
  // without this every count a viewer computes is short by exactly themselves.

  it('counts you toward a channel you follow', () => {
    const held = [who('did:a', [], [{ didDht: 'did:them', channelID: 'ch1' }])]
    expect(followersOfChannel(held, 'ch1')).toEqual(['did:a'])

    const withMe = [
      ...held,
      ownFollowerEdges(
        'did:me',
        [{ didDht: 'did:them', channelID: 'ch1' }],
        [],
      ),
    ]
    expect(followersOfChannel(withMe, 'ch1')).toEqual(['did:a', 'did:me'])
  })

  it('counts you toward a person you follow wholesale', () => {
    const withMe = [ownFollowerEdges('did:me', [], ['did:them'])]
    expect(followersOfPerson(withMe, 'did:them')).toEqual(['did:me'])
  })

  it('still does not make you your own follower', () => {
    // Your own record in the corpus reaches the self-edge guard that the crawl corpus
    // could never produce a case for. Viewing your own profile, it skips you.
    const withMe = [ownFollowerEdges('did:me', [], ['did:me'])]
    expect(followersOfPerson(withMe, 'did:me')).toEqual([])
  })

  it('counts you toward your OWN channel when you follow it', () => {
    // The person guard above does not apply at this grain: following your own channel is
    // a claim about the voice, published in your directory like any other.
    const withMe = [
      ownFollowerEdges('did:me', [{ didDht: 'did:me', channelID: 'ch1' }], []),
    ]
    expect(followersOfChannel(withMe, 'ch1')).toEqual(['did:me'])
  })

  it('drops the cached name, so one corpus holds one shape', () => {
    const edges = ownFollowerEdges(
      'did:me',
      [{ didDht: 'did:them', channelID: 'ch1', name: 'Their channel' }],
      [],
    )
    expect(edges.follows).toEqual([{ didDht: 'did:them', channelID: 'ch1' }])
  })
})
