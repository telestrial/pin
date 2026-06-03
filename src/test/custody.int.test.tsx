// Cross-account custody scenarios: pin, drift on edit, re-pin on drift,
// retract. Each test drives the production HomeFeed against the Phase 3
// fakes; the assertions check both the visible UI state (PinButton title,
// drift indicator) and the underlying world state (bob's scope, pinStore).
//
// "Custody" is the architectural promise of Pin: when you pin, you take
// stewardship of those bytes. Author edits and retracts don't reach into
// your library — your snapshot persists.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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

import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { deletePublishedItem } from '../core/channels'
import type { SubscriptionRef } from '../core/types'
import { HomeFeed } from '../components/HomeFeed'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import {
  authorCreateChannel,
  createFakeApp,
  editTextPost,
  type FakeAccount,
  mountAs,
  publishTextPost,
  resetAllStores,
} from './setupFakeApp'

// Setup helper used by every test in this file: alice publishes one
// post to a fresh channel; bob's auth store is seeded with the
// subscription; HomeFeed renders ready for assertions.
async function setupAlicePublishesBobSubscribes(): Promise<{
  alice: FakeAccount
  bob: FakeAccount
  channel: { channelID: string; channelKey: string }
  sub: SubscriptionRef
  postBody: string
  postItemID: string
}> {
  const app = createFakeApp()
  const alice = app.createAccount({
    did: 'did:plc:alice',
    handle: 'alice.test',
  })
  const bob = app.createAccount({ did: 'did:plc:bob', handle: 'bob.test' })
  const channel = await authorCreateChannel(alice, {
    name: "Alice's voice",
  })
  const postBody = 'hello from alice'
  const item = await publishTextPost(
    alice,
    { channelID: channel.channelID, channelKey: channel.channelKey },
    postBody,
  )
  const sub: SubscriptionRef = {
    authorHandle: alice.handle,
    authorDID: alice.did,
    channelID: channel.channelID,
    channelKey: channel.channelKey,
    addedAt: new Date().toISOString(),
  }
  mountAs(bob, { subscriptions: [sub] })
  return {
    alice,
    bob,
    channel: { channelID: channel.channelID, channelKey: channel.channelKey },
    sub,
    postBody,
    postItemID: item.id,
  }
}

describe('integration: custody', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it("Bob pins Alice's post; bytes appear in bob's scope and pinStore", async () => {
    const { alice, bob, postBody } = await setupAlicePublishesBobSubscribes()

    render(<HomeFeed onItemClick={() => {}} onChannelClick={() => {}} onHandleClick={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText(postBody)).toBeInTheDocument()
    })

    // Before the click: pinnable, nothing in bob's pinned list, no bytes
    // in bob's scope yet (he only subscribed; subscribing is read-only).
    const pinButton = screen.getByTitle('Pin to your storage')
    expect(pinButton).toHaveAttribute('aria-pressed', 'false')
    expect(usePinStore.getState().pinned).toHaveLength(0)

    // Pre-pin: bob's account has no pinned bytes. (Alice's pinned object
    // is in alice's scope on the world; bob hasn't mirrored it yet.)
    const bobBefore = await bob.sdk.account()
    expect(bobBefore.pinnedData).toBe(0)
    // Sanity: alice's bytes ARE in the world, in alice's scope.
    const aliceSnap = await alice.sdk.account()
    expect(aliceSnap.pinnedData).toBeGreaterThan(0)

    await userEvent.click(pinButton)

    // After the click: pinStore has bob's snapshot; button flips to
    // "Unpin from your storage" and aria-pressed=true.
    await waitFor(() => {
      expect(usePinStore.getState().pinned).toHaveLength(1)
    })
    expect(usePinStore.getState().pinned[0].item.summary).toBe(postBody)
    expect(usePinStore.getState().pinned[0].channel.authorHandle).toBe(
      alice.handle,
    )

    // The pinned bytes mirror into bob's scope on the world. Bob's account
    // snapshot now reflects the same byte size alice's does (they share
    // the object — capability addressing).
    const bobAfter = await bob.sdk.account()
    expect(bobAfter.pinnedData).toBe(aliceSnap.pinnedData)

    // UI updated to pinned state.
    expect(screen.getByTitle('Unpin from your storage')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it("Alice edits her post; Bob's PinButton flips to the drift state", async () => {
    const { alice, channel, sub, postItemID } =
      await setupAlicePublishesBobSubscribes()

    render(<HomeFeed onItemClick={() => {}} onChannelClick={() => {}} onHandleClick={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText('hello from alice')).toBeInTheDocument(),
    )

    // Bob pins the original.
    const initialPin = screen.getByTitle('Pin to your storage')
    await userEvent.click(initialPin)
    await waitFor(() =>
      expect(usePinStore.getState().pinned).toHaveLength(1),
    )
    const originalPinnedURL = usePinStore.getState().pinned[0].item.itemURL

    // Alice edits the post (new bytes, new URL, new contentHash; same
    // publishedAt preserved by editItem).
    await editTextPost(alice, channel, postItemID, 'hello from alice (updated)')

    // Mimic the JetStream-driven refresh that would fire in production
    // when alice's manifest commit lands.
    await act(async () => {
      await useFeedStore.getState().refreshChannel(sub)
    })

    // The new body is rendered; the drift state shows up on the PinButton
    // (title flips to "Update your pinned copy to the current version").
    await waitFor(() =>
      expect(
        screen.getByText('hello from alice (updated)'),
      ).toBeInTheDocument(),
    )
    expect(
      screen.getByTitle('Update your pinned copy to the current version'),
    ).toBeInTheDocument()

    // Bob's pinned entry still points at the ORIGINAL bytes — that's the
    // custody promise. The author's edit doesn't reach into his library.
    const stillPinned = usePinStore.getState().pinned[0]
    expect(stillPinned.item.itemURL).toBe(originalPinnedURL)
    expect(stillPinned.item.summary).toBe('hello from alice')
  })

  it("Re-clicking pin on a drifted post swaps Bob's snapshot to the current version", async () => {
    const { alice, channel, sub, postItemID } =
      await setupAlicePublishesBobSubscribes()

    render(<HomeFeed onItemClick={() => {}} onChannelClick={() => {}} onHandleClick={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText('hello from alice')).toBeInTheDocument(),
    )

    await userEvent.click(screen.getByTitle('Pin to your storage'))
    await waitFor(() =>
      expect(usePinStore.getState().pinned).toHaveLength(1),
    )
    const originalPinnedURL = usePinStore.getState().pinned[0].item.itemURL

    await editTextPost(alice, channel, postItemID, 'v2 body')
    await act(async () => {
      await useFeedStore.getState().refreshChannel(sub)
    })

    // Re-pin: click the drifted button.
    const driftedButton = await screen.findByTitle(
      'Update your pinned copy to the current version',
    )
    await userEvent.click(driftedButton)

    // Snapshot swaps in place: same pinned entry, new bytes (v2).
    await waitFor(() => {
      const pinned = usePinStore.getState().pinned
      expect(pinned).toHaveLength(1)
      expect(pinned[0].item.itemURL).not.toBe(originalPinnedURL)
      expect(pinned[0].item.summary).toBe('v2 body')
    })

    // After the swap the button is no longer in the drift state — it's
    // back to plain "Unpin from your storage" (or stays pinned with no
    // drift dot, depending on title).
    await waitFor(() => {
      expect(screen.getByTitle('Unpin from your storage')).toBeInTheDocument()
    })
  })

  it("Alice retracts; the post disappears from Bob's feed but his pinned snapshot persists", async () => {
    const { alice, channel, sub, postItemID } =
      await setupAlicePublishesBobSubscribes()

    render(<HomeFeed onItemClick={() => {}} onChannelClick={() => {}} onHandleClick={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText('hello from alice')).toBeInTheDocument(),
    )

    // Bob pins, gets custody.
    await userEvent.click(screen.getByTitle('Pin to your storage'))
    await waitFor(() =>
      expect(usePinStore.getState().pinned).toHaveLength(1),
    )

    // Alice retracts. core/channels.deletePublishedItem filters the item
    // from her manifest AND deletes the object from her Sia scope. Bob's
    // independent pin keeps the bytes alive because he's still a pinner.
    await deletePublishedItem(
      alice.sdk as unknown as Sdk,
      alice.agent as unknown as Agent,
      channel,
      postItemID,
    )

    // Mimic the JetStream-driven refresh.
    await act(async () => {
      await useFeedStore.getState().refreshChannel(sub)
    })

    // The post is gone from bob's feed.
    await waitFor(() =>
      expect(screen.queryByText('hello from alice')).not.toBeInTheDocument(),
    )

    // But bob's pinned snapshot persists — the architectural custody
    // promise. The bytes are still in the world (bob is a pinner) and in
    // bob's pinStore entry. He could re-share them.
    const pinned = usePinStore.getState().pinned
    expect(pinned).toHaveLength(1)
    expect(pinned[0].item.summary).toBe('hello from alice')
  })
})
