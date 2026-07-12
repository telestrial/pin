import { describe, expect, it } from 'vitest'
import { computeContentHash } from './contentHash'

const ENCODER = new TextEncoder()

describe('computeContentHash', () => {
  it("returns a CIDv1 string (base32 'b' multibase prefix, 59 chars total)", async () => {
    const cid = await computeContentHash(ENCODER.encode('hello'))
    expect(cid).toMatch(/^b[a-z2-7]{58}$/)
  })

  it('is deterministic — same input bytes produce the same CID', async () => {
    const a = await computeContentHash(ENCODER.encode('whatever'))
    const b = await computeContentHash(ENCODER.encode('whatever'))
    expect(a).toBe(b)
  })

  it('produces different CIDs for different inputs', async () => {
    const a = await computeContentHash(ENCODER.encode('alpha'))
    const b = await computeContentHash(ENCODER.encode('beta'))
    expect(a).not.toBe(b)
  })

  // Regression locks against three known fixtures. The first time these run,
  // they capture the multiformats-equivalent CIDv1-raw-sha256 value; any
  // future change to the hash + base32 + multibase pipeline will break them.
  it('matches the fixed CID for the empty input', async () => {
    const cid = await computeContentHash(new Uint8Array(0))
    expect(cid).toBe(
      'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
    )
  })

  it("matches the fixed CID for 'hello'", async () => {
    const cid = await computeContentHash(ENCODER.encode('hello'))
    expect(cid).toBe(
      'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq',
    )
  })

  it("matches the fixed CID for 'hello world'", async () => {
    const cid = await computeContentHash(ENCODER.encode('hello world'))
    expect(cid).toBe(
      'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
    )
  })

  it('returns the same CID for a sliced Uint8Array as for the slice copied into a fresh buffer', async () => {
    // The source code makes a defensive copy before passing to SubtleCrypto;
    // this test confirms slices vs fresh buffers produce identical CIDs.
    const big = new Uint8Array([0, 0, 0, 1, 2, 3, 4, 5, 0, 0])
    const slice = big.subarray(3, 8) // bytes [1, 2, 3, 4, 5]
    const fresh = new Uint8Array([1, 2, 3, 4, 5])
    const fromSlice = await computeContentHash(slice)
    const fromFresh = await computeContentHash(fresh)
    expect(fromSlice).toBe(fromFresh)
  })
})
