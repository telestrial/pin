// Cross-account channel-level pin: bob snapshots alice's whole channel
// (body + attachments fan-out), catches up when a new post arrives, and
// unpins the lot via the confirm modal. Drives the production ChannelView
// + ChannelPinButton against the Phase 3 fakes; assertions check both the
// visible state (icon title / aria-pressed) and the world (bob's scope,
// pinStore). The real-network proof of the same flow lives in the e2e tier.

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@atproto/api', async () =>
  (await import('./fakeModules')).fakeAtprotoApiModule(),
)
vi.mock('../core/jetstream', async () =>
  (await import('./fakeModules')).fakeJetstreamModule(),
)
vi.mock('@siafoundation/sia-storage', async () =>
  (await import('./fakeModules')).fakeSiaStorageModule(),
)

import { ChannelView } from '../components/ChannelView'
import type { SubscriptionRef } from '../core/types'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import {
  authorCreateChannel,
  createFakeApp,
  type FakeAccount,
  mountAs,
  publishTextPost,
  resetAllStores,
} from './setupFakeApp'

// Pin identity is (channelID, publishedAt). Two posts published within the
// same millisecond collide on that key — the documented "vanishingly
// unlikely" production edge, but trivial to hit when the in-memory fake
// publishes back-to-back. Nudge each post to a distinct millisecond so the
// fan-out sees two logical items, the way real seconds-apart publishes do.
async function tickMs(): Promise<void> {
  await new Promise((r) => setTimeout(r, 3))
}

async function setup(): Promise<{
  alice: FakeAccount
  bob: FakeAccount
  channel: { channelID: string; channelKey: string }
  sub: SubscriptionRef
}> {
  const app = createFakeApp()
  const alice = app.createAccount({
    did: 'did:plc:alice',
    handle: 'alice.test',
  })
  const bob = app.createAccount({ did: 'did:plc:bob', handle: 'bob.test' })
  const created = await authorCreateChannel(alice, { name: "Alice's voice" })
  const channel = {
    channelID: created.channelID,
    channelKey: created.channelKey,
  }
  await publishTextPost(alice, channel, 'post one')
  await tickMs()
  await publishTextPost(alice, channel, 'post two')
  const sub: SubscriptionRef = {
    authorHandle: alice.handle,
    authorDID: alice.did,
    channelID: channel.channelID,
    channelKey: channel.channelKey,
    addedAt: new Date().toISOString(),
  }
  mountAs(bob, { subscriptions: [sub] })
  return { alice, bob, channel, sub }
}

function renderChannel(authorHandle: string, channelID: string) {
  render(
    <ChannelView
      authorHandle={authorHandle}
      channelID={channelID}
      onItemClick={() => {}}
      onChannelClick={() => {}}
      onHandleClick={() => {}}
      onUnsubscribe={() => {}}
      onBack={() => {}}
      sidebar={null}
      rightSidebar={null}
    />,
  )
}

describe('integration: channel pin', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it("pins the whole channel — every item lands in bob's scope + pinStore", async () => {
    const { alice, bob, channel } = await setup()
    renderChannel(alice.handle, channel.channelID)

    await waitFor(() =>
      expect(screen.getByText('post one')).toBeInTheDocument(),
    )
    expect(await bob.sdk.account()).toMatchObject({ pinnedData: 0 })

    const pinBtn = await screen.findByTitle(/Pin this channel to your storage/)
    expect(pinBtn).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(pinBtn)

    // Both items mirror into bob's pinStore + Sia scope.
    await waitFor(() => expect(usePinStore.getState().pinned).toHaveLength(2))
    const pinnedBodies = usePinStore
      .getState()
      .pinned.map((p) => p.item.summary)
      .sort()
    expect(pinnedBodies).toEqual(['post one', 'post two'])
    expect((await bob.sdk.account()).pinnedData).toBeGreaterThan(0)

    // Icon flips to the pinned state.
    await waitFor(() =>
      expect(screen.getByTitle(/Unpin this channel/)).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
  })

  it('catches up after a new post arrives (edited → pin the new one)', async () => {
    const { alice, bob, channel, sub } = await setup()
    renderChannel(alice.handle, channel.channelID)

    await screen.findByText('post one')
    await userEvent.click(
      await screen.findByTitle(/Pin this channel to your storage/),
    )
    await waitFor(() => expect(usePinStore.getState().pinned).toHaveLength(2))

    // Alice publishes a third post; the JetStream-driven refresh lands it.
    await tickMs()
    await publishTextPost(alice, channel, 'post three')
    await act(async () => {
      await useFeedStore.getState().refreshChannel(sub)
    })

    // Bob is now behind: the icon offers a catch-up.
    const catchUp = await screen.findByTitle(/Catch up — pin new items/)
    await userEvent.click(catchUp)

    await waitFor(() => expect(usePinStore.getState().pinned).toHaveLength(3))
    expect(
      usePinStore
        .getState()
        .pinned.map((p) => p.item.summary)
        .sort(),
    ).toEqual(['post one', 'post three', 'post two'])
    void bob
  })

  it('unpins the whole channel via the confirm modal', async () => {
    const { alice, bob, channel } = await setup()
    renderChannel(alice.handle, channel.channelID)

    await screen.findByText('post one')
    await userEvent.click(
      await screen.findByTitle(/Pin this channel to your storage/),
    )
    await waitFor(() => expect(usePinStore.getState().pinned).toHaveLength(2))
    expect((await bob.sdk.account()).pinnedData).toBeGreaterThan(0)

    // Clicking the pinned icon opens the confirm modal, not an instant unpin.
    await userEvent.click(await screen.findByTitle(/Unpin this channel/))
    const confirm = await screen.findByRole('button', { name: 'Unpin all' })
    await userEvent.click(confirm)

    await waitFor(() => expect(usePinStore.getState().pinned).toHaveLength(0))
    expect((await bob.sdk.account()).pinnedData).toBe(0)
    // Icon returns to the pinnable state.
    await waitFor(() =>
      expect(
        screen.getByTitle(/Pin this channel to your storage/),
      ).toBeInTheDocument(),
    )
  })
})
