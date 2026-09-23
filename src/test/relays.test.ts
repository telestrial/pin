import { describe, expect, it } from 'vitest'
import { configure_relays } from '../../crates/pin-core/pkg/pin_core.js'
import { DEFAULT_IROH_RELAYS, DEFAULT_PKARR_RELAYS } from '../lib/constants'
import { ensureRelays, resolveRelays } from '../lib/relays'

// The real wasm is loaded by src/test/setup.ts, so `configure_relays` here is the
// shipped parser rather than a stand-in for it. That is the point: what this guards is
// the shipped DEFAULTS, which are hand-written URLs that nothing else reads until an
// endpoint binds — and a bind only happens in a browser.

describe('relays', () => {
  it('ships defaults the parser accepts', async () => {
    await expect(ensureRelays()).resolves.toBeUndefined()
  })

  it('carries both legs off one resolve', () => {
    const set = resolveRelays()
    expect(set.pkarr).toEqual(DEFAULT_PKARR_RELAYS)
    expect(set.iroh).toEqual(DEFAULT_IROH_RELAYS)
  })

  // Configuring nothing has to be refused rather than filled in. A set answered with a
  // compiled-in relay would mean an instance nobody configured still reaches the
  // network, which reads as working.
  it('refuses a set with a missing leg', () => {
    expect(() => configure_relays([], DEFAULT_IROH_RELAYS)).toThrow()
    expect(() => configure_relays(DEFAULT_PKARR_RELAYS, [])).toThrow()
  })

  it('refuses a malformed url', () => {
    expect(() => configure_relays(['not a url'], DEFAULT_IROH_RELAYS)).toThrow()
  })
})
