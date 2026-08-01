// Integration coverage for the action journal's resume path — the novel
// behavior the unit tests can't reach. Drives the production useActionRunner
// against the Phase 3 fakes:
//   1. a normal publish goes upload → checkpoint → append → success, with the
//      action carrying its checkpoint + published-channel bookkeeping;
//   2. a rehydrated checkpointed action (as hydration would seed it: bytes
//      stripped, uploadedItemRef present) resumes WITHOUT re-uploading and
//      still lands the manifest append.

import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)

import { buildItemRef } from '../core/channels'
import { resolveChannelViaLocator } from '../lib/channelLocator'
import { useActionRunner } from '../lib/hooks/useActionRunner'
import { type PublishAction, useActionStore } from '../stores/actionQueue'
import {
  authorCreateChannel,
  createFakeApp,
  mountAs,
  resetAllStores,
} from './setupFakeApp'

// Mounting this drives the production runner effect against the seeded stores.
function RunnerHarness() {
  useActionRunner()
  return null
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('integration: action journal resume', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('publishes through the runner, recording a checkpoint + published channel', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    const channel = await authorCreateChannel(alice, { name: 'voice' })
    mountAs(alice, {
      myChannels: [
        {
          channelID: channel.channelID,
          channelKey: channel.channelKey,
          name: 'voice',
        },
      ],
    })

    render(<RunnerHarness />)

    const id = useActionStore.getState().enqueuePublish({
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
      const a = useActionStore.getState().actions.find((a) => a.id === id)
      expect(a?.state).toBe('success')
    })
    const done = useActionStore.getState().actions.find((a) => a.id === id) as
      | PublishAction
      | undefined
    expect(done?.ledger.uploadedItemRef).toBeDefined()
    expect(done?.ledger.publishedChannelIDs).toEqual([channel.channelID])

    // The append landed in the manifest committed to the locator.
    const manifest = await resolveChannelViaLocator(
      alice.client,
      channel.channelKey,
    )
    expect(manifest?.items.some((i) => i.summary === 'fresh post')).toBe(true)
  })

  it('resumes a checkpointed action without re-uploading', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    const channel = await authorCreateChannel(alice, { name: 'voice' })

    // Simulate the upload having completed in a prior session: bytes are on
    // Sia, the checkpoint holds the resolved ItemRef.
    const body = 'resumed post'
    const uploaded = await alice.client.uploadItem(enc(body))
    const itemRef = buildItemRef(uploaded, {
      type: 'text',
      title: '',
      summary: body,
      mimeType: 'text/markdown',
      bytes: enc(body),
    })
    const bodyObjectID = uploaded.id

    mountAs(alice, {
      myChannels: [
        {
          channelID: channel.channelID,
          channelKey: channel.channelKey,
          name: 'voice',
        },
      ],
    })

    // Seed the journal exactly as hydration would: pending, bytes stripped,
    // checkpoint present.
    useActionStore.setState({
      actions: [
        {
          id: 'resume-1',
          kind: 'publish',
          state: 'pending',
          progress: 0,
          createdAt: '2026-06-14T00:00:00.000Z',
          title: body,
          successLabel: 'Published',
          failLabel: 'Publish',
          intent: {
            payload: {
              type: 'text',
              title: '',
              summary: body,
              mimeType: 'text/markdown',
              bytes: new Uint8Array(0),
            },
            channelIDs: [channel.channelID],
            destination: 'channel',
          },
          ledger: { uploadedItemRef: itemRef },
        },
      ],
    })

    render(<RunnerHarness />)

    await waitFor(() => {
      const a = useActionStore
        .getState()
        .actions.find((a) => a.id === 'resume-1')
      expect(!a || a.state === 'success').toBe(true)
    })

    // The body bytes weren't re-uploaded — the checkpoint's object persists and
    // the append points back at its URL (the manifest commit itself mints a
    // separate small manifest object; the body object is what must be reused).
    expect(app.world.objects.has(bodyObjectID)).toBe(true)

    // The append still landed, pointing at the checkpoint's bytes.
    const manifest = await resolveChannelViaLocator(
      alice.client,
      channel.channelKey,
    )
    expect(manifest?.items.some((i) => i.itemURL === itemRef.itemURL)).toBe(
      true,
    )
  })
})
