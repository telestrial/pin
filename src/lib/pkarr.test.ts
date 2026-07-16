import { describe, expect, it } from 'vitest'
import { chunkForTxt, reassembleTxt } from './pkarr'

// A representative Sia share URL — longer than one 255-byte TXT string, so it must
// chunk. Shaped like the real thing (per-object encryption key in the fragment).
const SIA_URL =
  'sia://sia.storage/objects/126b5993aa11cc22dd33ee44ff5566778899aabbccddeeff/shared' +
  '?sv=253402214400&sig=abcdef0123456789abcdef0123456789#encryption_key=' +
  'AABBCCDDEEFF00112233445566778899'.repeat(5) // ~310 chars total → spans >1 TXT string

describe('chunkForTxt / reassembleTxt', () => {
  it('round-trips a long value through chunking', () => {
    const chunks = chunkForTxt('_c', SIA_URL)
    expect(chunks.length).toBeGreaterThan(1)
    expect(reassembleTxt(chunks, '_c')).toBe(SIA_URL)
  })

  it('keeps every chunk within the 255-byte TXT cap', () => {
    for (const c of chunkForTxt('_c', SIA_URL)) {
      expect(c.value.length).toBeLessThanOrEqual(255)
    }
  })

  it('names chunks with an incrementing index', () => {
    expect(chunkForTxt('_c', 'x'.repeat(600)).map((c) => c.name)).toEqual([
      '_c0',
      '_c1',
      '_c2',
    ])
  })

  it('reassembles from fully-qualified names, out of order (as the DHT returns them)', () => {
    // pkarr resolves names as `_c0.<pubkey>`, and record order is not guaranteed.
    const records = [
      { name: '_c1.abcpubkey', value: 'world' },
      { name: '_c0.abcpubkey', value: 'hello ' },
    ]
    expect(reassembleTxt(records, '_c')).toBe('hello world')
  })

  it('ignores non-matching records and returns empty when none match', () => {
    const records = [{ name: '_iroh.pub', value: 'nodeid' }]
    expect(reassembleTxt(records, '_c')).toBe('')
  })

  it('single short value is one chunk', () => {
    expect(chunkForTxt('_c', 'short')).toEqual([{ name: '_c0', value: 'short' }])
  })
})
