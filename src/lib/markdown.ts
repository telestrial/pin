import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { Facet } from '../core/types'
import { byteToChar, mentionOf } from './facets'

export function renderMarkdown(text: string): string {
  const rawHTML = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(rawHTML)
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Render a post body (markdown) with its mention facets as tappable @-links.
//
// Facets are byte ranges over the plaintext body, but the body renders as
// markdown — offsets don't survive markdown→HTML. So: replace each mention's
// range with a sentinel token (math brackets — unlikely in real text, and
// markdown passes them through verbatim), run the normal sanitized markdown
// pipeline, then swap each sentinel for an anchor we build ourselves. The anchor
// is injected AFTER DOMPurify from our own escaped values (handle + surface), so
// it needs no custom-scheme allowance and can't be an injection vector. Click
// navigation is handled by delegation on the container reading data-mention-handle.
export function renderPostBody(body: string, facets?: Facet[]): string {
  const mentions = (facets ?? [])
    .map((f) => {
      const m = mentionOf(f)
      return m ? { f, m } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  if (mentions.length === 0) return renderMarkdown(body)

  const tokens: { handle: string; surface: string }[] = []
  let src = body
  // Splice sentinels from the end so earlier byte→char offsets (computed
  // against the original body) stay valid as we edit later positions first.
  const desc = [...mentions].sort(
    (a, b) => b.f.index.byteStart - a.f.index.byteStart,
  )
  for (const { f, m } of desc) {
    const cs = byteToChar(body, f.index.byteStart)
    const ce = byteToChar(body, f.index.byteEnd)
    const surface = body.slice(cs, ce)
    const idx = tokens.length
    tokens.push({ handle: m.handle ?? '', surface })
    src = `${src.slice(0, cs)}⟦m:${idx}⟧${src.slice(ce)}`
  }

  const html = renderMarkdown(src)
  return html.replace(/⟦m:(\d+)⟧/g, (_, n) => {
    const t = tokens[Number(n)]
    if (!t) return ''
    return `<a href="#" data-mention-handle="${escapeHTML(t.handle)}" class="mention">${escapeHTML(t.surface)}</a>`
  })
}
