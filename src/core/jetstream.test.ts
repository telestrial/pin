import { describe, expect, it } from 'vitest'
import { pickJetstreamEndpoint } from './jetstream'

describe('pickJetstreamEndpoint', () => {
  it.each([
    'Pacific/Auckland',
    'Pacific/Honolulu',
    'Pacific/Fiji',
    'Asia/Tokyo',
    'Asia/Hong_Kong',
    'Asia/Singapore',
    'Australia/Sydney',
    'Australia/Brisbane',
    'America/Los_Angeles',
    'America/Anchorage',
    'America/Vancouver',
    'America/Tijuana',
    'America/Whitehorse',
  ])('returns us-west for %s', (tz) => {
    expect(pickJetstreamEndpoint(tz)).toContain('us-west')
  })

  it.each([
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Toronto',
    'America/Sao_Paulo',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Africa/Cairo',
    'UTC',
  ])('returns us-east for %s', (tz) => {
    expect(pickJetstreamEndpoint(tz)).toContain('us-east')
  })

  it('returns a wss:// URL', () => {
    expect(pickJetstreamEndpoint('UTC')).toMatch(/^wss:\/\//)
    expect(pickJetstreamEndpoint('Asia/Tokyo')).toMatch(/^wss:\/\//)
  })

  it('falls back to us-east for unknown / empty / garbage timezone strings', () => {
    expect(pickJetstreamEndpoint('')).toContain('us-east')
    expect(pickJetstreamEndpoint('not-a-real-tz')).toContain('us-east')
    expect(pickJetstreamEndpoint('Mars/Olympus_Mons')).toContain('us-east')
  })
})
