import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('runs in jsdom (has window + document)', () => {
    expect(typeof window).toBe('object')
    expect(typeof document).toBe('object')
  })

  it('has fake-indexeddb installed', () => {
    expect(typeof indexedDB).toBe('object')
  })

  it('has Web Crypto available', () => {
    expect(typeof crypto).toBe('object')
    expect(typeof crypto.subtle).toBe('object')
  })
})
