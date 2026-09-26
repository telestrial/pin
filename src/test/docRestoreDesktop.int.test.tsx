// Which platform restores its doc, and on what evidence.
//
// This hook reported ready under Tauri without reading anything, on the reasoning that a
// persistent store needs no restoring. That holds for a store that has been POPULATED,
// and a durable store is not a populated one — a fresh install, or a second identity on
// an existing install, opens a redb that is empty, because the namespace derives from the
// AppKey. Ready over an empty doc releases `identity`, `snapshot` and `engagement`, and
// they do to the durable copy what a tab did to it before any of this existed: publish a
// directory with no endorsements in it, and mirror the empty doc over the snapshot.
//
// So the evidence is the doc's settings record rather than the platform. These tests are
// about which of the two is consulted, which is why they assert on whether the snapshot
// was read at all.

import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { hydrated, settled, docState, tauri } = vi.hoisted(() => ({
  hydrated: [] as string[],
  settled: [] as string[],
  // What the durable doc holds when the restore runs. `undefined` stands for the empty
  // store a fresh install opens.
  docState: { settings: undefined as Uint8Array | undefined },
  tauri: { value: false },
}))

vi.mock('../lib/docs', () => ({
  openDocs: async () => 'namespace-id',
  getRecord: async (collection: string, rkey: string) =>
    collection === 'settings' && rkey === 'self'
      ? docState.settings
      : undefined,
}))

vi.mock('../lib/docsMirror', () => ({
  hydrateFromSia: async () => {
    hydrated.push('read')
    return { kind: 'restored' as const, records: 3 }
  },
}))

vi.mock('../lib/openExternal', () => ({
  inTauri: () => tauri.value,
}))

vi.mock('../lib/withdrawn', () => ({
  settleWithdrawals: async () => {
    settled.push('settled')
  },
}))

import { useDocRestore } from '../lib/hooks/useDocRestore'
import { useAuthStore } from '../stores/auth'
import { useCuratorStore } from '../stores/curator'
import { createFakeApp, resetAllStores } from './setupFakeApp'

// One microtask turn past the awaits inside the effect.
const settle = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('integration: the doc restore across platforms', () => {
  beforeEach(() => {
    resetAllStores()
    hydrated.length = 0
    settled.length = 0
    docState.settings = undefined
    tauri.value = false
    const account = createFakeApp().createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    useAuthStore.setState({
      client: account.client,
      storedKeyHex: 'a1'.repeat(32),
    })
    useCuratorStore.getState().set({ docRestore: 'pending' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the snapshot on desktop when the durable doc holds no settings', async () => {
    // THE REGRESSION. A fresh install of an existing identity, or a second identity on
    // an existing one: the store is durable and empty at once. Reporting ready here is
    // what lets the publishing loops overwrite the durable copy with nothing.
    tauri.value = true
    docState.settings = undefined

    renderHook(() => useDocRestore())
    await settle()

    expect(hydrated).toEqual(['read'])
    expect(useCuratorStore.getState().docRestore).toBe('ready')
  })

  it('leaves the snapshot alone on desktop when the doc is already populated', async () => {
    // The ordinary desktop boot, and why the platform check was there to begin with:
    // re-reading the snapshot into a doc that already holds it would churn the very
    // records the snapshot loop fingerprints.
    tauri.value = true
    docState.settings = new Uint8Array([1, 2, 3])

    renderHook(() => useDocRestore())
    await settle()

    expect(hydrated).toEqual([])
    expect(useCuratorStore.getState().docRestore).toBe('ready')
  })

  it('settles the withdrawal ledger on the desktop path that reads nothing', async () => {
    // `hydrateFromSia` forgets a withdrawal the snapshot has caught up with, so the path
    // that skips it has to do that job itself — otherwise a ledger entry outlives the
    // record it was protecting and is never cleared.
    tauri.value = true
    docState.settings = new Uint8Array([1, 2, 3])

    renderHook(() => useDocRestore())
    await settle()

    expect(settled).toEqual(['settled'])
  })

  it('reads the snapshot on web whatever the doc holds', async () => {
    // A MemStore that answers for `settings/self` was filled by the settings mirror from
    // localStorage, which says nothing about the rest of the doc — so the web path must
    // not inherit the desktop shortcut.
    tauri.value = false
    docState.settings = new Uint8Array([1, 2, 3])

    renderHook(() => useDocRestore())
    await settle()

    expect(hydrated).toEqual(['read'])
  })
})
