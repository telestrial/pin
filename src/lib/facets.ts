import type { Facet, MentionFeature } from '../core/types'

// Facets store UTF-8 byte offsets (Bluesky convention). The composer works in
// JS string (UTF-16 code-unit) indices and the renderer slices JS strings, so
// we convert between the two. Both walk by code point, so a facet range always
// lands on a character boundary — never mid-surrogate, never mid-multibyte.

export function charToByte(text: string, charIndex: number): number {
  return new TextEncoder().encode(text.slice(0, charIndex)).length
}

export function byteToChar(text: string, byteIndex: number): number {
  if (byteIndex <= 0) return 0
  const enc = new TextEncoder()
  let bytes = 0
  let charIdx = 0
  for (const ch of text) {
    if (bytes >= byteIndex) break
    bytes += enc.encode(ch).length
    charIdx += ch.length // code units (1 for BMP, 2 for surrogate pairs)
  }
  return charIdx
}

// The pin.mention feature of a facet, if it has one. A facet's features array
// may (later) carry other types; the mention is the one the picker records.
export function mentionOf(facet: Facet): MentionFeature | undefined {
  return facet.features.find(
    (f): f is MentionFeature => f.$type === 'pin.mention',
  )
}

// A mention captured during composition: the exact surface text inserted and
// the identity it points at. The composer holds these in insertion order and
// resolves them to byte-range facets at submit time (buildMentionFacets), which
// keeps offset bookkeeping out of the per-keystroke path — no re-anchoring as
// the user edits around a mention.
export type DraftMention = {
  did: string
  handle: string
  surface: string // e.g. "@alice" — the literal text spliced into the body
}

// Resolve draft mentions to byte-range facets against the FINAL body. Scans for
// each surface in insertion order from a moving cursor (so repeated surfaces map
// in order), skipping any whose text the author edited away — a broken mention
// simply drops. Non-overlapping by construction (cursor only moves forward).
export function buildMentionFacets(
  body: string,
  mentions: readonly DraftMention[],
): Facet[] {
  const facets: Facet[] = []
  let searchFrom = 0
  for (const m of mentions) {
    const at = body.indexOf(m.surface, searchFrom)
    if (at === -1) continue // author edited the surface away — drop it
    const byteStart = charToByte(body, at)
    const byteEnd = charToByte(body, at + m.surface.length)
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'pin.mention', did: m.did, handle: m.handle }],
    })
    searchFrom = at + m.surface.length
  }
  return facets
}
