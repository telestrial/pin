// Where a tab's settings come from, and what it refuses to conclude.
//
// This hook used to resolve settings itself — its own Sia download, its own locator
// recovery, its own reading of what an unreadable snapshot meant — which put a second
// recovery path beside the doc restore. That is what emptied an account: the read
// failed, the failure came back indistinguishable from an absence, the naming gate fired
// on the empty state left behind, and the `settings/self` that naming wrote carried a
// newer timestamp than the peer's, so the peer applied it.
//
// The doc is the only source now, and `docRestore` is what makes an absence mean
// something. So the load is a doc read with one precondition, and the tests below are
// about the precondition rather than the read.

import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { docState } = vi.hoisted(() => ({
  docState: {
    record: null as Uint8Array | null,
    throws: false,
    reads: 0,
  },
}))

vi.mock('../lib/docs', () => ({
  openDocs: async () => 'namespace-id',
  getRecord: async () => {
    docState.reads += 1
    if (docState.throws) throw new Error('doc read failed')
    return docState.record ?? undefined
  },
  putRecord: async () => {},
  listAll: async () => [],
}))

import { deriveSettingsKey, encryptSettings } from '../core/crypto'
import { SETTINGS_VERSION } from '../core/settings'
import {
  FINGERPRINT_KEY,
  fingerprintOf,
  MIRRORED_AT_KEY,
} from '../lib/hooks/useSettingsDocsMirror'
import { useSettingsSync } from '../lib/hooks/useSettingsSync'
import { useAuthStore } from '../stores/auth'
import { useCuratorStore } from '../stores/curator'
import { createFakeApp, resetAllStores } from './setupFakeApp'

const APP_KEY_HEX = 'a1'.repeat(32)

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** `settings/self` as the mirror writes it: encrypted under the settings key. */
async function published(fields: Record<string, unknown>) {
  const key = await deriveSettingsKey(Uint8Array.fromHex(APP_KEY_HEX))
  const enc = await encryptSettings(
    key,
    JSON.stringify({
      version: SETTINGS_VERSION,
      myChannels: [],
      subscriptions: [],
      updatedAt: '2026-01-02T00:00:00.000Z',
      ...fields,
    }),
  )
  return new TextEncoder().encode(enc)
}

const channel = {
  channelID: 'ch1',
  channelKey: 'key-ch1',
  name: 'Channel One',
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('integration: loading settings from the doc', () => {
  beforeEach(() => {
    resetAllStores()
    localStorage.clear()
    docState.record = null
    docState.throws = false
    docState.reads = 0
    const account = createFakeApp().createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    useAuthStore.setState({
      client: account.client,
      storedKeyHex: APP_KEY_HEX,
      settingsLoaded: false,
      myChannels: [],
      profile: null,
    })
    useCuratorStore.getState().set({ docRestore: 'pending' })
  })

  it('loads what the doc holds once the restore is ready', async () => {
    docState.record = await published({
      myChannels: [channel],
      profile: { username: 'alice', displayName: 'Alice' },
    })
    useCuratorStore.getState().set({ docRestore: 'ready' })

    renderHook(() => useSettingsSync())
    await settle()

    expect(useAuthStore.getState().settingsLoaded).toBe(true)
    expect(useAuthStore.getState().myChannels).toEqual([channel])
    expect(useAuthStore.getState().profile?.username).toBe('alice')
  })

  it('reads nothing while the restore is still pending', async () => {
    // The naming gate is `connected && settingsLoaded && !hasUsername`, so staying
    // unloaded is what keeps it away. A tab that concluded here would be concluding
    // from a doc nobody had put back yet.
    docState.record = await published({ myChannels: [channel] })

    renderHook(() => useSettingsSync())
    await settle()

    expect(useAuthStore.getState().settingsLoaded).toBe(false)
    expect(docState.reads).toBe(0)
  })

  it('reads nothing when the restore came back unknown', async () => {
    // THE CASE THAT EMPTIED AN ACCOUNT. `unknown` is nobody having answered about the
    // snapshot — a browser where Sia will not read, a host outage, a locator naming a
    // reclaimed object. Loading here publishes an emptiness over a full account, and
    // refusing to load costs a session that will not start, which is the cheaper of the
    // two by a margin that is not close.
    docState.record = await published({ myChannels: [channel] })
    useCuratorStore.getState().set({ docRestore: 'unknown' })

    renderHook(() => useSettingsSync())
    await settle()

    expect(useAuthStore.getState().settingsLoaded).toBe(false)
    expect(docState.reads).toBe(0)
  })

  it('stays unloaded when the doc read throws', async () => {
    // Same rule one layer in: a read that failed is not an account with no settings.
    docState.throws = true
    useCuratorStore.getState().set({ docRestore: 'ready' })

    renderHook(() => useSettingsSync())
    await settle()

    expect(useAuthStore.getState().settingsLoaded).toBe(false)
    expect(docState.reads).toBe(1)
  })

  it('loads empty when the doc genuinely holds no settings', async () => {
    // A brand-new identity, and the state every account starts in. The restore reporting
    // ready is what makes this an answer rather than a gap — and it is the one branch
    // that MUST load, or a new account could never name itself.
    useCuratorStore.getState().set({ docRestore: 'ready' })

    renderHook(() => useSettingsSync())
    await settle()

    expect(useAuthStore.getState().settingsLoaded).toBe(true)
    expect(useAuthStore.getState().myChannels).toEqual([])
  })

  // A channel created in a tab used to disappear on the next refresh, and these three
  // are the guard that stopped it. Observed live first — create a channel, reload the
  // moment it reaches the sidebar, come back to an empty list — then reproduced with
  // the flag as the only variable between losing it and keeping it.
  //
  // The window is ordinary on web rather than exotic: the doc is a MemStore that dies
  // with the tab, so the durable copy is the Sia snapshot, and that lands seconds after
  // the local write. A refresh in between restores a doc that predates the channel.
  it('refuses a record older than the state this device mirrored', async () => {
    // The doc's record predates what local holds, so applying it would drop a channel
    // that exists. Loaded anyway: the app has to start, and the mirror's catch-up
    // pushes local state out, which is what makes the doc current again.
    localStorage.setItem(MIRRORED_AT_KEY, '2026-01-03T00:00:00.000Z')
    docState.record = await published({
      myChannels: [],
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    useAuthStore.setState({ myChannels: [channel] })
    useCuratorStore.getState().set({ docRestore: 'ready' })

    renderHook(() => useSettingsSync())
    await settle()

    expect(useAuthStore.getState().myChannels).toEqual([channel])
    expect(useAuthStore.getState().settingsLoaded).toBe(true)
  })

  it('applies a record newer than the state this device mirrored', async () => {
    // The other device's edit, which is the whole reason this path reads the doc at
    // all. A guard that kept local state unconditionally would be a different bug.
    localStorage.setItem(MIRRORED_AT_KEY, '2026-01-01T00:00:00.000Z')
    docState.record = await published({
      myChannels: [channel],
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    useAuthStore.setState({ myChannels: [] })
    useCuratorStore.getState().set({ docRestore: 'ready' })

    renderHook(() => useSettingsSync())
    await settle()

    expect(useAuthStore.getState().myChannels).toEqual([channel])
  })

  it('applies what the doc holds when this device has never mirrored', async () => {
    // No stamp is not a claim that local is newer — it is the absence of one, which is
    // where every device sits on first run and on the upgrade that introduced the
    // stamp. Refusing here would leave a fresh device unable to load its own account.
    docState.record = await published({ myChannels: [] })
    useAuthStore.setState({ myChannels: [channel] })
    useCuratorStore.getState().set({ docRestore: 'ready' })

    renderHook(() => useSettingsSync())
    await settle()

    expect(useAuthStore.getState().myChannels).toEqual([])
  })

  it('keeps local state that has moved since the last mirror', async () => {
    // A crash mid-write last session leaves local fresher than the doc. The mirror's
    // boot catch-up pushes it out; reading the doc over it would lose the newer state.
    //
    // The fingerprint written here is of the state that WAS mirrored (no channels),
    // while the store holds one — which is what "local has moved" means, derived rather
    // than declared. A `settingsDirty` flag used to answer this and was set by one
    // mutation out of a dozen, so it said "mirrored" for a channel that had reached
    // nothing.
    localStorage.setItem(
      FINGERPRINT_KEY,
      fingerprintOf(useAuthStore.getState()),
    )
    useAuthStore.setState({ myChannels: [channel] })
    docState.record = await published({ myChannels: [] })
    useCuratorStore.getState().set({ docRestore: 'ready' })

    renderHook(() => useSettingsSync())
    await settle()

    expect(useAuthStore.getState().settingsLoaded).toBe(true)
    expect(useAuthStore.getState().myChannels).toEqual([channel])
    expect(docState.reads).toBe(0)
  })
})
