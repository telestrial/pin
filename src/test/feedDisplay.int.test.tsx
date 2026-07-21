// Integration test: author publishes a post → subscriber sees it in the feed.
//
// First integration test in the suite — sets the harness pattern for the rest.
// Drives production components (HomeFeed) against the Phase 3 fakes via the
// vi.mock'd @siafoundation/sia-storage module.
//
// Alice (author) publishes a text post through the real core/channels +
// core/sia code paths (backed by FakeSdk). Bob (subscriber)
// renders HomeFeed with alice's subscription seeded into his auth store;
// the feed populates from the channel locator and the post body
// renders inline.

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock must come before the imports below — Vitest hoists these calls.
// The factories use dynamic import() so the helper module is loaded lazily
// at runtime (after hoist), when getCurrentWorld() can return a live world.
vi.mock('@siafoundation/sia-storage', async () =>
  (await import('./fakeModules')).fakeSiaStorageModule(),
)
vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
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
})
