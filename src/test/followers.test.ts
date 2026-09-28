// Who follows somebody, out of what the crawl has read.
//
// A follow lives in the FOLLOWER's directory and nothing writes into the followed
// identity's scope, so a follower count can only ever be a reverse scan of the index.
// These lock what that scan counts — and, as much, what it declines to.
//
// THE PERSON IS THE UNIT (John, 2026-09-28): a channel is how somebody chooses to follow a
// person, so a person's followers include their channels' followers, Following counts
// people, and every count is one per person.

import { describe, expect, it } from 'vitest'
import {
  type FollowerEdges,
  followedPeople,
  followersOf,
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

  it('counts following a CHANNEL of theirs', () => {
    // The author gets the credit for all of it: somebody who follows only one of your
    // voices is part of your audience.
    const held = [
      who('did:a', [], [{ didDht: 'did:target', channelID: 'ch1' }]),
    ]
    expect(followersOfPerson(held, 'did:target')).toEqual(['did:a'])
  })

  it('counts a person once however many of their channels they follow', () => {
    // One per person, so the number moves when a person does and not when an author
    // splits a channel in five.
    const held = [
      who(
        'did:a',
        ['did:target'],
        [
          { didDht: 'did:target', channelID: 'ch1' },
          { didDht: 'did:target', channelID: 'ch2' },
        ],
      ),
    ]
    expect(followersOfPerson(held, 'did:target')).toEqual(['did:a'])
  })

  it('never counts somebody as their own follower', () => {
    // A directory can name anybody, its own author included — and every author of a
    // public channel follows it, so that is the edge this is really about.
    const held = [
      who(
        'did:target',
        ['did:target'],
        [{ didDht: 'did:target', channelID: 'mine' }],
      ),
    ]
    expect(followersOfPerson(held, 'did:target')).toEqual([])
  })

  it('answers the same way twice and counts one identity once', () => {
    const held = [who('did:c', ['did:target']), who('did:a', ['did:target'])]
    expect(followersOfPerson(held, 'did:target')).toEqual(['did:a', 'did:c'])
  })
})

describe('followersOf', () => {
  it('says how each follower follows, one entry per person', () => {
    const held = [
      who(
        'did:b',
        [],
        [
          { didDht: 'did:target', channelID: 'techno' },
          { didDht: 'did:target', channelID: 'cats' },
          { didDht: 'did:other', channelID: 'x' },
        ],
      ),
      who('did:a', ['did:target']),
    ]
    expect(followersOf(held, 'did:target')).toEqual([
      // Wholesale first: the larger claim leads, the same order Following uses.
      { didDht: 'did:a', wholesale: true, channelIDs: [] },
      { didDht: 'did:b', wholesale: false, channelIDs: ['techno', 'cats'] },
    ])
  })

  it('merges one identity appearing twice in the corpus', () => {
    // The corpus unions the viewer's own edges into the held records, so one identity
    // can in principle arrive from both halves.
    const held = [
      who('did:a', [], [{ didDht: 'did:target', channelID: 'techno' }]),
      who(
        'did:a',
        ['did:target'],
        [{ didDht: 'did:target', channelID: 'techno' }],
      ),
    ]
    expect(followersOf(held, 'did:target')).toEqual([
      { didDht: 'did:a', wholesale: true, channelIDs: ['techno'] },
    ])
  })

  it('leaves out the subject and anybody who does not follow them', () => {
    const held = [
      who(
        'did:target',
        ['did:target'],
        [{ didDht: 'did:target', channelID: 'mine' }],
      ),
      who('did:c', ['did:someone-else']),
    ]
    expect(followersOf(held, 'did:target')).toEqual([])
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

  it('counts the wholesale followers of its author, who receive it', () => {
    // Following a person watches every public channel they advertise, now and later, so a
    // wholesale follower is in this channel's audience as surely as a direct one.
    const held = [
      who('did:a', [], [{ didDht: 'did:author', channelID: 'ch1' }]),
      who('did:b', ['did:author']),
      who('did:c', ['did:someone-else']),
    ]
    expect(followersOfChannel(held, 'ch1', 'did:author')).toEqual([
      'did:a',
      'did:b',
    ])
  })

  it('counts somebody who follows both ways once', () => {
    const held = [
      who(
        'did:a',
        ['did:author'],
        [{ didDht: 'did:author', channelID: 'ch1' }],
      ),
    ]
    expect(followersOfChannel(held, 'ch1', 'did:author')).toEqual(['did:a'])
  })

  it('without an author, counts only its own followers', () => {
    const held = [who('did:b', ['did:author'])]
    expect(followersOfChannel(held, 'ch1')).toEqual([])
  })

  it('is empty for a channel nobody held has followed', () => {
    // Empty means the crawl has read nobody who follows it — never that nobody does.
    expect(followersOfChannel([who('did:a', ['did:x'])], 'ch1')).toEqual([])
  })
})

describe('followedPeople', () => {
  it('is one entry per person, however they are followed', () => {
    // Following three of somebody's channels is following them once; which channels is
    // kept on the entry.
    const out = followedPeople(
      'did:me',
      [
        { didDht: 'did:bob', channelID: 'techno' },
        { didDht: 'did:bob', channelID: 'cats' },
        { didDht: 'did:ann', channelID: 'essays' },
      ],
      ['did:cy'],
    )
    expect(out.map((p) => p.didDht)).toEqual(['did:cy', 'did:bob', 'did:ann'])
    expect(out[0]).toEqual({ didDht: 'did:cy', wholesale: true, channels: [] })
    expect(out[1].channels.map((c) => c.channelID)).toEqual(['techno', 'cats'])
    expect(out[1].wholesale).toBe(false)
  })

  it('merges a wholesale follow with channel follows of the same person', () => {
    const out = followedPeople(
      'did:me',
      [{ didDht: 'did:bob', channelID: 'techno' }],
      ['did:bob'],
    )
    expect(out).toHaveLength(1)
    expect(out[0].wholesale).toBe(true)
  })

  it('never includes itself', () => {
    // Following your own channel puts you among its audience; it is authorship rather
    // than attention, and counted here would read a profile as following somebody when
    // it follows nobody but itself.
    const out = followedPeople(
      'did:me',
      [
        { didDht: 'did:me', channelID: 'mine' },
        { didDht: 'did:them', channelID: 'theirs' },
      ],
      ['did:me'],
    )
    expect(out.map((p) => p.didDht)).toEqual(['did:them'])
  })

  it('is keyed on the subject, so it holds on any profile', () => {
    const out = followedPeople(
      'did:them',
      [
        { didDht: 'did:them', channelID: 'theirs' },
        { didDht: 'did:me', channelID: 'mine' },
      ],
      ['did:them'],
    )
    expect(out.map((p) => p.didDht)).toEqual(['did:me'])
  })
})

describe('the two directions agree', () => {
  it('A is among the followers of B exactly when B is among the people A follows', () => {
    // One relation, read from either end — which the grain-split counts were not: a
    // profile could read "Following 3" meaning three channels of one person while
    // somebody else read 0 over forty channel followers.
    const edges: Record<
      string,
      {
        follows: { didDht: string; channelID: string }[]
        handleFollows: string[]
      }
    > = {
      'did:a': {
        follows: [
          { didDht: 'did:b', channelID: 'b1' },
          { didDht: 'did:b', channelID: 'b2' },
        ],
        handleFollows: [],
      },
      'did:b': {
        follows: [{ didDht: 'did:b', channelID: 'b1' }],
        handleFollows: ['did:c'],
      },
      'did:c': {
        follows: [{ didDht: 'did:a', channelID: 'a1' }],
        handleFollows: ['did:a'],
      },
    }
    const held = Object.entries(edges).map(([did, e]) =>
      who(did, e.handleFollows, e.follows),
    )
    const dids = Object.keys(edges)
    for (const a of dids) {
      for (const b of dids) {
        const aFollowsB = followedPeople(
          a,
          edges[a].follows,
          edges[a].handleFollows,
        ).some((p) => p.didDht === b)
        expect(followersOfPerson(held, b).includes(a)).toBe(aFollowsB)
      }
    }
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
