import { describe, expect, it } from 'vitest'
import type { Facet } from '../core/types'
import { renderMarkdown, renderPostBody } from './markdown'

const mention = (
  byteStart: number,
  byteEnd: number,
  did: string,
  handle: string,
): Facet => ({
  index: { byteStart, byteEnd },
  features: [{ $type: 'pin.mention', did, handle }],
})

describe('renderPostBody', () => {
  it('equals renderMarkdown when there are no mention facets', () => {
    const body = 'plain **markdown** body'
    expect(renderPostBody(body)).toBe(renderMarkdown(body))
    expect(renderPostBody(body, [])).toBe(renderMarkdown(body))
  })

  it('renders a mention range as a data-mention anchor, text preserved', () => {
    const html = renderPostBody('hi @alice!', [
      mention(3, 9, 'did:plc:alice', 'alice.bsky.social'),
    ])
    expect(html).toContain('data-mention-handle="alice.bsky.social"')
    expect(html).toContain('class="mention"')
    expect(html).toContain('>@alice</a>')
    expect(html).toContain('hi ')
    expect(html).not.toContain('⟦m:') // sentinel fully swapped out
  })

  it('escapes the surface text and the handle (no markup injection)', () => {
    // '@a<b' occupies bytes 2..6 of 'x @a<b'.
    const html = renderPostBody('x @a<b', [mention(2, 6, 'did:x', 'h"&<>')])
    expect(html).toContain('data-mention-handle="h&quot;&amp;&lt;&gt;"')
    expect(html).toContain('@a&lt;b')
  })

  it('places multiple mentions at their own ranges', () => {
    // '@bob' 0..4, '@carol' 11..17.
    const html = renderPostBody('@bob meets @carol', [
      mention(0, 4, 'did:bob', 'bob'),
      mention(11, 17, 'did:carol', 'carol'),
    ])
    expect(html).toContain('>@bob</a>')
    expect(html).toContain('>@carol</a>')
    expect(html).toContain('meets')
  })

  it('keeps markdown around a mention working', () => {
    // '@alice' at bytes 2..8 inside bold markers.
    const html = renderPostBody('**@alice**', [
      mention(2, 8, 'did:alice', 'alice'),
    ])
    expect(html).toContain('<strong>')
    expect(html).toContain('>@alice</a>')
  })
})
