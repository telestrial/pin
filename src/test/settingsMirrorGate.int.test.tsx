// What a tab may publish before it knows what it holds.
//
// THE CROSS-DEVICE WIPE IS A WRITE, and this is the write. A fresh tab holds an empty
// persisted store and no mirror fingerprint, so those differ and the boot catch-up
// schedules a mirror of that emptiness. What it races is the doc restore — a DHT resolve
// and a Sia download — which takes longer than the 2s debounce every time. So the empty
// record lands first with a newer `updatedAt` than the peer's, the peer's overlay finds
// something newer and applies it, and an account that existed on another device is gone.
//
// Making the READER careful cannot fix this: the writer never read anything.

import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { writes } = vi.hoisted(() => ({ writes: [] as string[] }))

vi.mock('../lib/docs', () => ({
  openDocs: async () => 'namespace-id',
  getRecord: async () => undefined,
  putRecord: async (collection: string, rkey: string) => {
    writes.push(`${collection}/${rkey}`)
  },
  listAll: async () => [],
  subscribeDocChanges: () => () => {},
}))

import type { OwnedChannel } from '../core/types'
import { useSettingsDocsMirror } from '../lib/hooks/useSettingsDocsMirror'
import { useAuthStore } from '../stores/auth'
import { createFakeApp, resetAllStores } from './setupFakeApp'

const APP_KEY_HEX = 'a1'.repeat(32)

const channel: OwnedChannel = {
  channelID: 'ch1',
  channelKey: 'key-ch1',
  name: 'Channel One',
  createdAt: '2026-01-01T00:00:00.000Z',
}

/** Past the 2s debounce and the awaits inside the mirror. */
const settleDebounce = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500)
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

describe('integration: what the settings mirror may write', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetAllStores()
    localStorage.clear()
    writes.length = 0
    const account = createFakeApp().createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    useAuthStore.setState({
      client: account.client,
      storedKeyHex: APP_KEY_HEX,
      settingsLoaded: false,
      settingsDirty: false,
      myChannels: [],
      profile: null,
    })
  })

  it('writes nothing while settings are unloaded', async () => {
    // The wipe, in one assertion. Empty store, no fingerprint, so the boot catch-up
    // wants to push — and what it would push is an emptiness this tab never established.
    renderHook(() => useSettingsDocsMirror())
    await settleDebounce()

    expect(writes).toEqual([])
  })

  it('writes once the load reports, with no settings field changing', async () => {
    // The boot catch-up is DROPPED rather than deferred while unloaded, so the load
    // finishing has to be its own trigger. A session holding local state that was never
    // mirrored — a crash mid-write last time — would otherwise keep it local forever.
    //
    // `settingsLoaded` flips ALONE here, and that is the whole point: touching a settings
    // field in the same write would fire the ordinary subscription and this would pass
    // with the trigger deleted. It did, until a sabotage said so.
    useAuthStore.setState({ myChannels: [channel] })
    renderHook(() => useSettingsDocsMirror())
    await settleDebounce()
    expect(writes).toEqual([])

    await act(async () => {
      useAuthStore.setState({ settingsLoaded: true })
    })
    await settleDebounce()

    expect(writes).toEqual(['settings/self'])
  })

  it('writes a change made after the load', async () => {
    // The ordinary path, and the one that must keep working: the gate is about the boot
    // race, not about muting the mirror.
    useAuthStore.setState({ settingsLoaded: true })
    renderHook(() => useSettingsDocsMirror())
    await settleDebounce()
    writes.length = 0

    await act(async () => {
      useAuthStore.setState({ myChannels: [channel] })
    })
    await settleDebounce()

    expect(writes).toEqual(['settings/self'])
  })
})
