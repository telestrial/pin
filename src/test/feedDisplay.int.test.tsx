// Integration test: author publishes a post → subscriber sees it in the feed.
//
// First integration test in the suite — sets the harness pattern for the rest.
// Drives production components (HomeFeed) against a FakeSiaClient injected at the
// SiaClient seam, which is where the app's Sia dependency actually lives.
//
// Alice (author) publishes a text post through the real core/channels code path.
// Bob (subscriber) renders HomeFeed with alice's subscription seeded into his auth
// store; the feed populates from the channel locator and the post body renders
// inline.

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock must come before the imports below — Vitest hoists these calls.
// The factory uses dynamic import() so the helper module is loaded lazily
// at runtime (after hoist), when getCurrentWorld() can return a live world.
vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)

import { HomeFeed } from '../components/HomeFeed'
import type { SubscriptionRef } from '../core/types'
import {
  authorCreateChannel,
  createFakeApp,
  mountAs,
  publishTextPost,
  resetAllStores,
} from './setupFakeApp'

describe('integration: subscriber feed display', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it("Alice publishes a post; Bob's feed renders it after his app mounts", async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    const bob = app.createAccount({
      did: 'did:plc:bob',
      handle: 'bob.test',
    })

    // Alice creates a channel and publishes a post — through the real
    // production code paths (core/channels + core/sia), backed by FakeSdk.
    const channel = await authorCreateChannel(alice, {
      name: "Alice's voice",
      description: 'Things worth keeping',
    })

    await publishTextPost(
      alice,
      { channelID: channel.channelID, channelKey: channel.channelKey },
      'hello from alice',
    )

    // Bob mounts the app with alice's channel subscribed.
    const bobsSub: SubscriptionRef = {
      authorHandle: alice.handle,
      authorDID: alice.did,
      channelID: channel.channelID,
      channelKey: channel.channelKey,
      addedAt: new Date().toISOString(),
    }
    mountAs(bob, { subscriptions: [bobsSub] })

    render(
      <HomeFeed
        onItemClick={() => {}}
        onChannelClick={() => {}}
        onHandleClick={() => {}}
      />,
    )

    // Feed populates via useFeedStore.refresh on mount; the post body
    // renders as markdown inside PostBody.
    await waitFor(() => {
      expect(screen.getByText('hello from alice')).toBeInTheDocument()
    })

    // Identity surfaces too: channel name + author handle.
    expect(screen.getByText("Alice's voice")).toBeInTheDocument()
    expect(screen.getByText('@alice.test')).toBeInTheDocument()
  })

  it('shows a circulated comment under the post it was made on', async () => {
    // The row is the POST, which is the context the remark needs and the only identity a
    // feed row has chrome for — a commenter has no channel. What was actually circulated
    // sits beneath it, attributed, with its own gesture.
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    const carol = app.createAccount({
      did: 'did:plc:carol',
      handle: 'carol.test',
    })

    const channel = await authorCreateChannel(alice, {
      name: "Alice's voice",
      description: '',
    })
    await publishTextPost(
      alice,
      { channelID: channel.channelID, channelKey: channel.channelKey },
      'the original post',
    )

    const sub: SubscriptionRef = {
      authorHandle: alice.handle,
      authorDID: alice.did,
      channelID: channel.channelID,
      channelKey: channel.channelKey,
      addedAt: new Date().toISOString(),
    }
    mountAs(carol, { subscriptions: [sub] })

    render(
      <HomeFeed
        onItemClick={() => {}}
        onChannelClick={() => {}}
        onHandleClick={() => {}}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('the original post')).toBeInTheDocument()
    })

    // Put a resolved comment portal in front of the collation, the way a resolution pass
    // would, and rebuild the entries from it.
    const { useFeedStore } = await import('../stores/feed')
    const { entriesForManifest } = await import('../core/feed')
    const manifest = useFeedStore.getState().manifests[channel.channelID]
    const entries = entriesForManifest(sub, manifest, {})
    useFeedStore.setState({
      entries: entries.map((e) => ({
        ...e,
        repost: { channel: e.channel, at: new Date().toISOString() },
        comment: {
          actor: 'did:dht:bob',
          createdAt: '2026-08-24T09:00:00.000Z',
          body: 'worth repeating',
          sig: 'sig-bob',
          bodyURL: 'sia://body#encryption_key=k',
          attachments: [
            {
              url: 'sia://shot#encryption_key=k',
              mimeType: 'image/png',
              filename: 'shot.png',
              byteSize: 1234,
              contentHash: 'bafkreishot',
            },
          ],
        },
      })),
    })

    // Both are on screen: the post as the row, the remark under it.
    await waitFor(() => {
      expect(screen.getByText('worth repeating')).toBeInTheDocument()
    })
    expect(screen.getByText('the original post')).toBeInTheDocument()

    // And the remark is WHOLE, not a text-only rendering of one: whose it is, the files it
    // carries, and both gestures. A comment met in the feed and the same comment met in its
    // thread must not be two different things.
    // The unresolved-identity fallback, which is what a DID with no published name reads
    // as anywhere in the app.
    expect(await screen.findByText(/^@did:dht:/)).toBeInTheDocument()
    expect(
      await screen.findByText('shot.png — unavailable'),
    ).toBeInTheDocument()
    // Two pins on screen: the post's and the remark's. Keeping a post and keeping something
    // said under it are different claims, so the remark must not borrow the post's.
    expect(screen.getAllByTitle(/Pin to your storage/).length).toBe(2)
  })
})
