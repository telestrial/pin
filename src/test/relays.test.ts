import { beforeEach, describe, expect, it } from 'vitest'
import { configure_relays } from '../../crates/pin-core/pkg/pin_core.js'
import {
  LOCAL_IROH_RELAYS,
  LOCAL_PKARR_RELAYS,
  PUBLIC_IROH_RELAYS,
  PUBLIC_PKARR_RELAYS,
} from '../lib/constants'
import { ensureRelays, relaysForPreset, resolveRelays } from '../lib/relays'
import { useAuthStore } from '../stores/auth'

// The real wasm is loaded by src/test/setup.ts, so `configure_relays` here is the
// shipped parser rather than a stand-in. That is the point: what this guards is the
// shipped SETS, which are hand-written URLs nothing else reads until an endpoint binds
// — and a bind only happens in a browser.

describe('relays', () => {
  beforeEach(() => {
    useAuthStore.setState({
      relayPreset: 'local',
      customPkarrRelays: [],
      customIrohRelays: [],
    })
  })

  // Read off the store's INITIAL state rather than through `resolveRelays`, because
  // the seeding in `beforeEach` would otherwise be what this asserts on — a sabotage
  // that flipped the shipped default passed against the earlier version of this test.
  it('defaults to the relays on this machine', () => {
    expect(useAuthStore.getInitialState().relayPreset).toBe('local')
    expect(relaysForPreset('local')).toEqual({
      pkarr: LOCAL_PKARR_RELAYS,
      iroh: LOCAL_IROH_RELAYS,
    })
  })

  it('ships sets the parser accepts', async () => {
    await expect(ensureRelays()).resolves.toBeUndefined()
    const pub = relaysForPreset('public')
    expect(() => configure_relays(pub.pkarr, pub.iroh)).not.toThrow()
  })

  it('reaches the public path when that is the choice', () => {
    useAuthStore.setState({ relayPreset: 'public' })
    expect(resolveRelays()).toEqual({
      pkarr: PUBLIC_PKARR_RELAYS,
      iroh: PUBLIC_IROH_RELAYS,
    })
  })

  // A fallback appended here would be invisible to the equality tests above, which read
  // the presets directly. And it is the failure worth guarding: a set gathered across a
  // relay we run and one we don't makes an empty answer unattributable again, which is
  // the whole reason for running our own.
  it('adds no public relay behind the local choice', () => {
    const set = resolveRelays()
    for (const url of [...PUBLIC_PKARR_RELAYS, ...PUBLIC_IROH_RELAYS]) {
      expect([...set.pkarr, ...set.iroh]).not.toContain(url)
    }
  })

  it('takes named relays from the store', () => {
    useAuthStore.setState({
      relayPreset: 'custom',
      customPkarrRelays: ['http://10.0.0.2:6881'],
      customIrohRelays: ['http://10.0.0.2:3340'],
    })
    expect(resolveRelays()).toEqual({
      pkarr: ['http://10.0.0.2:6881'],
      iroh: ['http://10.0.0.2:3340'],
    })
  })

  // Configuring nothing has to be refused rather than filled in. A set answered with a
  // compiled-in relay would mean an instance nobody configured still reaches the
  // network, which reads as working.
  it('refuses a set with a missing leg', () => {
    expect(() => configure_relays([], LOCAL_IROH_RELAYS)).toThrow()
    expect(() => configure_relays(LOCAL_PKARR_RELAYS, [])).toThrow()
  })

  it('refuses a malformed url', () => {
    expect(() => configure_relays(['not a url'], LOCAL_IROH_RELAYS)).toThrow()
  })
})
