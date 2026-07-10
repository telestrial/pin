import { describe, expect, it } from 'vitest'
import { normalizeUsername } from './profile'

describe('normalizeUsername', () => {
  it('strips a leading @ (single or repeated)', () => {
    expect(normalizeUsername('@john')).toBe('john')
    expect(normalizeUsername('@@john')).toBe('john')
  })

  it('removes all whitespace so the handle is one connected token', () => {
    expect(normalizeUsername('john williams')).toBe('johnwilliams')
    expect(normalizeUsername('  spaced  out  ')).toBe('spacedout')
    expect(normalizeUsername('tab\tnewline\n')).toBe('tabnewline')
  })

  it('caps length at 30 characters', () => {
    expect(normalizeUsername('a'.repeat(50))).toBe('a'.repeat(30))
  })

  it('returns empty string for blank/whitespace-only input', () => {
    expect(normalizeUsername('')).toBe('')
    expect(normalizeUsername('   ')).toBe('')
    expect(normalizeUsername('@')).toBe('')
  })

  it('is permissive on charset — the name is the user’s', () => {
    expect(normalizeUsername('DJ_Null.Bytes-42')).toBe('DJ_Null.Bytes-42')
  })

  it('does not enforce uniqueness — same input always normalizes the same', () => {
    // Two different people can hold the same normalized handle; nothing here
    // (or anywhere) rejects a collision.
    expect(normalizeUsername('@lebron')).toBe(normalizeUsername('lebron'))
  })
})
