import { describe, expect, it } from 'vitest'
import {
  buildMentionFacets,
  byteToChar,
  charToByte,
  type DraftMention,
} from './facets'

describe('charToByte / byteToChar', () => {
  it('round-trips pure ascii (1 byte per char)', () => {
    const s = 'hello @alice world'
    const at = s.indexOf('@')
    expect(charToByte(s, at)).toBe(at)
    expect(byteToChar(s, at)).toBe(at)
  })

  it('accounts for a multibyte char before the offset', () => {
    const s = '🎉 @bob' // 🎉 = 4 UTF-8 bytes / 2 UTF-16 code units, space = 1
    const at = s.indexOf('@') // code-unit index = 3
    const b = charToByte(s, at) // 4 + 1 = 5 bytes
    expect(b).toBe(5)
    expect(byteToChar(s, b)).toBe(at) // inverse lands back on the boundary
  })

  it('byteToChar clamps a non-positive index to 0', () => {
    expect(byteToChar('abc', 0)).toBe(0)
    expect(byteToChar('abc', -5)).toBe(0)
  })
})

describe('buildMentionFacets', () => {
  const m = (surface: string, did = `did:${surface}`): DraftMention => ({
    did,
    handle: surface.slice(1),
    surface,
  })

  it('locates a mention and records its byte range + feature', () => {
    const facets = buildMentionFacets('hi @alice!', [m('@alice')])
    expect(facets).toHaveLength(1)
    expect(facets[0]!.index).toEqual({ byteStart: 3, byteEnd: 9 })
    expect(facets[0]!.features[0]).toEqual({
      $type: 'pin.mention',
      did: 'did:@alice',
      handle: 'alice',
    })
  })

  it('drops a mention whose surface the author edited away', () => {
    expect(buildMentionFacets('hi there', [m('@alice')])).toEqual([])
  })

  it('maps repeated identical surfaces in insertion order, non-overlapping', () => {
    const facets = buildMentionFacets('@bob and @bob', [
      m('@bob', 'did:1'),
      m('@bob', 'did:2'),
    ])
    expect(facets).toHaveLength(2)
    expect(facets[0]!.index.byteStart).toBe(0)
    expect(facets[0]!.features[0]).toMatchObject({ did: 'did:1' })
    expect(facets[1]!.index.byteStart).toBe(9)
    expect(facets[1]!.features[0]).toMatchObject({ did: 'did:2' })
  })

  it('computes byte offsets past a multibyte char', () => {
    const facets = buildMentionFacets('🎉 @bob', [m('@bob')])
    expect(facets[0]!.index).toEqual({ byteStart: 5, byteEnd: 9 }) // @bob = 4 bytes
  })
})
