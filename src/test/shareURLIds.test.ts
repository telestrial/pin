// Reading an object id out of a share URL.
//
// The unit tier is where this belongs and the only place it can be checked honestly:
// the integration tier exercises it through the fake, whose URLs are the same SHAPE as
// real Sia's but never the real thing, so a parser that only ever met the fake would be
// a parser nobody had tested against production. The vectors below are the shape the
// SDK builds — `sia://<authority>/objects/<id>/shared`, signed query, key in the
// fragment — taken from its own assertion that the path is exactly that.

import { describe, expect, it } from 'vitest'
import { objectIDInShareURL } from '../core/siaClient'
import { fakeShareURL } from './shareURL'

const ID = 'a'.repeat(64)

describe('the object id in a share URL', () => {
  it('reads it from a URL the SDK would build', () => {
    expect(
      objectIDInShareURL(
        `sia://indexer.example.com/objects/${ID}/shared?signature=abc&valid_until=99#encryption_key=Zm9v`,
      ),
    ).toBe(ID)
  })

  it('reads it with neither query nor fragment', () => {
    expect(objectIDInShareURL(`sia://host/objects/${ID}/shared`)).toBe(ID)
  })

  it('reads the fake’s URLs, which is what makes the tier above meaningful', () => {
    // Not a courtesy to the fake: the fake mints this shape precisely so the code under
    // test is the same code in both tiers. If this ever fails the two have drifted, and
    // the integration tier has quietly stopped exercising the real parser.
    expect(objectIDInShareURL(fakeShareURL(ID))).toBe(ID)
  })

  it('says nothing for a URL that is not one', () => {
    // Null is "this URL names no id", never "no such object" — the caller decides what
    // an absence means, and here it has learned nothing at all.
    expect(objectIDInShareURL('sia://gone#encryption_key=ff')).toBeNull()
    expect(objectIDInShareURL('')).toBeNull()
    expect(objectIDInShareURL(`sia://host/objects/${ID}`)).toBeNull()
    expect(objectIDInShareURL(`sia://host/${ID}/shared`)).toBeNull()
    // `/shared` ends the path; a segment that merely starts with it is a
    // different route, so the match is bounded on the right as well.
    expect(
      objectIDInShareURL(`sia://host/objects/${ID}/sharedthing`),
    ).toBeNull()
  })

  it('does not mistake an id for one that merely contains the path', () => {
    // A slash cannot be part of an id, so the segment has to be bounded on both sides.
    expect(objectIDInShareURL('sia://host/objects/a/b/shared')).toBeNull()
  })
})
