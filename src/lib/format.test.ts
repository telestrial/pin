import { describe, expect, it } from 'vitest'
import { formatBytes } from './format'

describe('formatBytes', () => {
  it('formats sub-kilobyte values in B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('uses decimal divisors (KB = 1000, not 1024)', () => {
    expect(formatBytes(1_500)).toBe('1.5 KB')
    expect(formatBytes(999_999)).toBe('1000 KB')
  })

  it('promotes to MB at 1,000,000 bytes', () => {
    expect(formatBytes(1_500_000)).toBe('1.5 MB')
    expect(formatBytes(999_999_999)).toBe('1000 MB')
  })

  it('promotes to GB at 1,000,000,000 bytes', () => {
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB')
  })

  it('strips trailing zeros across every unit', () => {
    // .00 / .0 carry no information — drop them. KB and MB max at 1
    // fractional place; GB at 2.
    expect(formatBytes(1_000)).toBe('1 KB')
    expect(formatBytes(1_000_000)).toBe('1 MB')
    expect(formatBytes(1_000_000_000)).toBe('1 GB')
    expect(formatBytes(50_000_000_000)).toBe('50 GB')
  })

  it('keeps decimals when they carry information', () => {
    // .01 GB is 10 MB — meaningful at storage scale; .10 GB simplifies
    // to .1 GB (one trailing zero dropped, the leading .1 kept).
    expect(formatBytes(50_010_000_000)).toBe('50.01 GB')
    expect(formatBytes(50_100_000_000)).toBe('50.1 GB')
    expect(formatBytes(1_500_000)).toBe('1.5 MB')
  })

  it('renders a 50 GB cap as "50 GB" exactly', () => {
    // Regression: the previous 1024-divisor / decimal-label combo
    // turned a 50 GB cap into "46.57 GB", which contradicted the
    // user's stated cap. Decimal divisors + trailing-zero strip
    // bring it to a clean "50 GB".
    expect(formatBytes(50_000_000_000)).toBe('50 GB')
  })

  it('matches what cloud storage providers display for whole-number caps', () => {
    expect(formatBytes(5_000_000_000)).toBe('5 GB')
    expect(formatBytes(100_000_000_000)).toBe('100 GB')
  })
})
