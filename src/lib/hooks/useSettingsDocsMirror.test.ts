import { describe, expect, it } from 'vitest'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import type { OwnedChannel } from '../../core/types'
import {
  decidePeerSettings,
  fingerprintOf,
  mayPublishSettings,
  type SettingsFields,
} from './useSettingsDocsMirror'

const channel = (id: string): OwnedChannel => ({
  channelID: id,
  channelKey: `key-${id}`,
  name: `Channel ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
})

const EMPTY: SettingsFields = {
  myChannels: [],
  subscriptions: [],
  dismissedAutoWatch: [],
  theme: 'rounded',
  follows: [],
  handleFollows: [],
  profile: null,
}

// A full DispatchSettings from a partial SettingsFields (peer wire shape).
const peerFrom = (
  f: Partial<DispatchSettings>,
  version: number = SETTINGS_VERSION,
): DispatchSettings =>
  ({
    version,
    myChannels: [],
    subscriptions: [],
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...f,
  }) as DispatchSettings

describe('decidePeerSettings', () => {
  it('applies a peer record that differs from what we hold', () => {
    const peer = peerFrom({ myChannels: [channel('a')] })
    const next = decidePeerSettings(peer, EMPTY, true, 'rounded')
    expect(next).not.toBeNull()
    expect(next?.myChannels).toEqual([channel('a')])
  })

  it('does NOT apply when local state is not fully mirrored (clobber guard)', () => {
    const peer = peerFrom({ myChannels: [channel('a')] })
    // A peer change is available, but we have an unsynced local edit — skip it.
    expect(decidePeerSettings(peer, EMPTY, false, 'rounded')).toBeNull()
  })

  it('does NOT apply a version mismatch (never apply what we cannot trust)', () => {
    const peer = peerFrom({ myChannels: [channel('a')] }, SETTINGS_VERSION + 1)
    expect(decidePeerSettings(peer, EMPTY, true, 'rounded')).toBeNull()
  })

  it('does NOT apply when the content equals what we already hold (no-op)', () => {
    const current: SettingsFields = { ...EMPTY, myChannels: [channel('a')] }
    const peer = peerFrom({ myChannels: [channel('a')] })
    expect(decidePeerSettings(peer, current, true, 'rounded')).toBeNull()
  })

  it('propagates a legitimate peer-emptied account (not a wipe — a valid change)', () => {
    const current: SettingsFields = { ...EMPTY, myChannels: [channel('a')] }
    const peer = peerFrom({ myChannels: [] }) // peer removed the channel
    const next = decidePeerSettings(peer, current, true, 'rounded')
    expect(next?.myChannels).toEqual([])
  })

  it('fills omitted back-compat fields with the same defaults hydrate uses', () => {
    // A peer record from before optional fields existed: only channels + version
    // (peerFrom omits theme / dismissedAutoWatch / follows / handleFollows / profile).
    const peer = peerFrom({ myChannels: [channel('a')] })
    const next = decidePeerSettings(peer, EMPTY, true, 'corners')
    expect(next).toMatchObject({
      theme: 'corners', // omitted → the passed default
      dismissedAutoWatch: [],
      follows: [],
      handleFollows: [],
      profile: null,
    })
  })
})

describe('fingerprintOf', () => {
  it('is stable for equal field sets and differs for unequal ones', () => {
    const a: SettingsFields = { ...EMPTY, myChannels: [channel('a')] }
    const b: SettingsFields = { ...EMPTY, myChannels: [channel('a')] }
    const c: SettingsFields = { ...EMPTY, myChannels: [channel('b')] }
    expect(fingerprintOf(a)).toBe(fingerprintOf(b))
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(c))
  })
})

// The rule that stops a second device erasing an account. A browser signing into an
// existing identity failed to resolve the durable settings pointer (relay lag), the
// app read that as "no settings", showed the naming gate, and the name it was given
// was a settings mutation — which published zero channels over a real record.
describe('mayPublishSettings', () => {
  it('refuses to publish settings whose provenance is unknown', () => {
    // The load failed. Local emptiness here means "we could not read", and that is
    // indistinguishable from "there is nothing" — so it may not be written.
    expect(mayPublishSettings('unknown')).toBe(false)
  })

  it('publishes what was read, and what was created here', () => {
    // Read from the durable snapshot, or from a peer's synced record.
    expect(mayPublishSettings('loaded')).toBe(true)
    // A brand-new account has no durable copy it could be contradicting, so its
    // local state is authoritative by definition — including when it's empty.
    expect(mayPublishSettings('created')).toBe(true)
  })
})

describe('decidePeerSettings while recovering', () => {
  it('takes a peer copy even when local is unmirrored', () => {
    // The mirror-clean guard exists to protect unsynced local EDITS. A restore that
    // never reached its settings has no edits to protect — it has ignorance — so the
    // guard would only keep it stranded. This is the second way out of 'unknown':
    // the durable pointer may be unreachable while another instance of the same
    // identity is right there holding the answer.
    const peer = peerFrom({ myChannels: [channel('a')] })
    expect(decidePeerSettings(peer, EMPTY, false, 'rounded', false)).toBeNull()
    expect(
      decidePeerSettings(peer, EMPTY, false, 'rounded', true),
    ).not.toBeNull()
  })

  it('still refuses a peer copy it cannot understand', () => {
    // Recovering relaxes the clobber guard, not the validity checks — a version we
    // don't know is not a rescue.
    const peer = peerFrom({ myChannels: [channel('a')] }, SETTINGS_VERSION + 1)
    expect(decidePeerSettings(peer, EMPTY, false, 'rounded', true)).toBeNull()
  })
})
