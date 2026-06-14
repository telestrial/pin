// Integration coverage for the persistent upload queue's resume path — the
// novel behavior the unit tests can't reach. Drives the production
// useUploadRunner against the Phase 3 fakes:
//   1. a normal publish goes upload → checkpoint → append → success, with the
//      task carrying its checkpoint + published-channel bookkeeping;
//   2. a rehydrated checkpointed task (as hydration would seed it: bytes
//      stripped, uploadedItemRef present) resumes WITHOUT re-uploading and
//      still lands the manifest append.

import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock(
  '@atproto/api',
  async () => (await import('./fakeModules')).fakeAtprotoApiModule(),
)
vi.mock(
  '../core/jetstream',
  async () => (await import('./fakeModules')).fakeJetstreamModule(),
)
vi.mock(
  '@siafoundation/sia-storage',
  async () => (await import('./fakeModules')).fakeSiaStorageModule(),
)

import type { Sdk } from '@siafoundation/sia-storage'
import { buildItemRef, fetchChannel } from '../core/channels'
import { uploadItem } from '../core/sia'
import { useUploadRunner } from '../lib/useUploadRunner'
import { useUploadQueueStore } from '../stores/uploadQueue'
import {
  authorCreateChannel,
  createFakeApp,
  mountAs,
  resetAllStores,
} from './setupFakeApp'

// Mounting this drives the production runner effect against the seeded stores.
function RunnerHarness() {
  useUploadRunner()
  return null
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('integration: upload queue resume', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('publishes through the runner, recording a checkpoint + published channel', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: 'did:plc:alice', handle: 'alice.test' })
    const channel = await authorCreateChannel(alice, { name: 'voice' })
    mountAs(alice, {
      myChannels: [
        { channelID: channel.channelID, channelKey: channel.channelKey, name: 'voice' },
      ],
    })

    render(<RunnerHarness />)

    const id = useUploadQueueStore.getState().enqueue({
      payload: {
        type: 'text',
        title: '',
        summary: 'fresh post',
        mimeType: 'text/markdown',
        bytes: enc('fresh post'),
      },
      channelIDs: [channel.channelID],
    })

    // Catch it at success (before the 4s auto-remove) to inspect the
    // bookkeeping the runner wrote.
    await waitFor(() => {
      const t = useUploadQueueStore.getState().tasks.find((t) => t.id === id)
      expect(t?.state).toBe('success')
    })
    const done = useUploadQueueStore.getState().tasks.find((t) => t.id === id)
    expect(done?.uploadedItemRef).toBeDefined()
    expect(done?.publishedChannelIDs).toEqual([channel.channelID])

    // The append landed in the manifest.
    const manifest = await fetchChannel(
      alice.did,
      channel.channelID,
      channel.channelKey,
    )
    expect(manifest.items.some((i) => i.summary === 'fresh post')).toBe(true)
  })

  it('resumes a checkpointed task without re-uploading', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: 'did:plc:alice', handle: 'alice.test' })
    const channel = await authorCreateChannel(alice, { name: 'voice' })

    // Simulate the upload having completed in a prior session: bytes are on
    // Sia, the checkpoint holds the resolved ItemRef.
    const body = 'resumed post'
    const uploaded = await uploadItem(alice.sdk as unknown as Sdk, enc(body))
    const itemRef = buildItemRef(uploaded, {
      type: 'text',
      title: '',
      summary: body,
      mimeType: 'text/markdown',
      bytes: enc(body),
    })
    const objectsAfterUpload = app.world.objects.size

    mountAs(alice, {
      myChannels: [
        { channelID: channel.channelID, channelKey: channel.channelKey, name: 'voice' },
      ],
    })

    // Seed the queue exactly as hydration would: pending, bytes stripped,
    // checkpoint present.
    useUploadQueueStore.setState({
      tasks: [
        {
          id: 'resume-1',
          state: 'pending',
          progress: 0,
          createdAt: '2026-06-14T00:00:00.000Z',
          payload: {
            type: 'text',
            title: '',
            summary: body,
            mimeType: 'text/markdown',
            bytes: new Uint8Array(0),
          },
          channelIDs: [channel.channelID],
          destination: 'channel',
          uploadedItemRef: itemRef,
        },
      ],
    })

    render(<RunnerHarness />)

    await waitFor(() => {
      const t = useUploadQueueStore.getState().tasks.find((t) => t.id === 'resume-1')
      expect(!t || t.state === 'success').toBe(true)
    })

    // No new Sia object was minted — the slow re-upload was skipped.
    expect(app.world.objects.size).toBe(objectsAfterUpload)

    // The append still landed, pointing at the checkpoint's bytes.
    const manifest = await fetchChannel(
      alice.did,
      channel.channelID,
      channel.channelKey,
    )
    expect(manifest.items.some((i) => i.itemURL === itemRef.itemURL)).toBe(true)
  })
})
