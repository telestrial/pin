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
