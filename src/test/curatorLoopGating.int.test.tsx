// Which loops a tab may start before its doc has been put back.
//
// On web the doc is a fresh MemStore every session, so until the snapshot is restored
// this instance holds an account with no endorsements, no comments and no manifests.
// Three loops publish current state assembled from that doc — `identity` republishes
// the directory, where an absent endorsement reads to every crawler as a withdrawal;
// `snapshot` mirrors whatever it finds and moves the durable pointer onto it;
// `engagement` folds held records into tallies it publishes. Running any of them over
// an unrestored doc converts a failure to read into an authoritative write.

import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted with the mock factory, which vitest lifts above every other statement in the
// file — a plain const here is read before it is initialized.
const { started, record } = vi.hoisted(() => {
  const started: string[] = []
  return {
    started,
    record: (name: string) => async () => {
      started.push(name)
    },
  }
})

vi.mock('../lib/docs', () => ({
  openDocs: async () => 'namespace-id',
  startKeepAliveLoop: record('keep-alive'),
  startChannelDocLoop: record('channel-doc'),
  startChannelSyncLoop: record('channel-sync'),
  startRepackLoop: record('repack'),
  startInstanceLoop: record('instance'),
  startDeliverLoop: record('deliver'),
  startDiscoverLoop: record('discover'),
  startSnapshotLoop: record('snapshot'),
  startIdentityLoop: record('identity'),
  startEngagementLoop: record('engagement'),
}))

import { useCuratorLoops } from '../lib/hooks/useCuratorLoops'
import { useAuthStore } from '../stores/auth'
import { useCuratorStore } from '../stores/curator'
import { createFakeApp, resetAllStores } from './setupFakeApp'

const GATED = ['snapshot', 'identity', 'engagement']

// One microtask turn past the awaits inside the effect.
const settle = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('integration: curator loop gating on the doc restore', () => {
  beforeEach(() => {
    resetAllStores()
    started.length = 0
    const account = createFakeApp().createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    useAuthStore.setState({
      client: account.client,
      storedKeyHex: 'a1'.repeat(32),
      curationEnabled: true,
    })
    useCuratorStore.getState().set({ docRestore: 'pending' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('holds the loops that publish current state until the doc is restored', async () => {
    const { unmount } = renderHook(() => useCuratorLoops())
    await settle()

    for (const name of GATED) {
      expect(started, `${name} ran over an unrestored doc`).not.toContain(name)
    }
    // And the rest are up, or waiting on the restore would cost this instance its
    // keep-alives and its ability to be reached.
    expect(started).toContain('keep-alive')
    expect(started).toContain('deliver')
    expect(started.length).toBe(7)
    unmount()
  })

  it('starts them once the restore settles, and starts the others once only', async () => {
    const { unmount } = renderHook(() => useCuratorLoops())
    await settle()

    await act(async () => {
      useCuratorStore.getState().set({ docRestore: 'ready' })
    })
    await settle()

    for (const name of GATED) expect(started).toContain(name)
    // The seven live in their own effect, so the flip must not re-run them. A second
    // copy of a publishing loop is two instances of one cadence.
    expect(started.filter((n) => n === 'keep-alive').length).toBe(1)
    expect(started.length).toBe(10)
    unmount()
  })

  it('keeps holding them while the restore reports unknown', async () => {
    // A snapshot that exists and would not read. Retrying is `useDocRestore`'s job;
    // what must not happen meanwhile is publishing an account this instance cannot see.
    const { unmount } = renderHook(() => useCuratorLoops())
    await settle()

    await act(async () => {
      useCuratorStore.getState().set({ docRestore: 'unknown' })
    })
    await settle()

    for (const name of GATED) expect(started).not.toContain(name)
    unmount()
  })
})
