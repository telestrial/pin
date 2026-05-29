// Integration test: author publishes a post → subscriber sees it in the feed.
//
// First integration test in the suite — sets the harness pattern for the rest.
// Drives production components (HomeFeed) against the Phase 3 fakes via three
// vi.mock'd modules: @atproto/api, ../core/jetstream, @siafoundation/sia-storage.
//
// Alice (author) publishes a text post through the real core/channels +
// core/sia code paths (now backed by FakeSdk + FakeAgent). Bob (subscriber)
// renders HomeFeed with alice's subscription seeded into his auth store;
// the feed populates from the encrypted ATProto record and the post body
// renders inline.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// vi.mock must come before the imports below — Vitest hoists these calls.
// The factories use dynamic import() so the helper module is loaded lazily
// at runtime (after hoist), when getCurrentWorld() can return a live world.
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

import {
  appendItemToChannel,
  buildItemRef,
  createChannel,
} from '../core/channels'
import { uploadItem } from '../core/sia'
import type { SubscriptionRef } from '../core/types'
import { HomeFeed } from '../components/HomeFeed'
import {
  createFakeApp,
  type FakeAccount,
  mountAs,
  resetAllStores,
} from './setupFakeApp'

async function publishTextPost(
  author: FakeAccount,
  channel: { channelID: string; channelKey: string },
  body: string,
): Promise<void> {
  const sdk = author.sdk as unknown as Parameters<typeof uploadItem>[0]
  const agent = author.agent as unknown as Parameters<
    typeof appendItemToChannel
  >[0]
  const uploaded = await uploadItem(sdk, new TextEncoder().encode(body))
  const item = buildItemRef(uploaded, {
    type: 'text',
    title: '',
    summary: body,
    mimeType: 'text/markdown',
    bytes: new TextEncoder().encode(body),
  })
  await appendItemToChannel(agent, channel, item)
}

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
    // production code paths (core/channels + core/sia), now backed by
    // FakeSdk + FakeAgent.
    const channel = await createChannel(
      alice.sdk as unknown as Parameters<typeof createChannel>[0],
      alice.agent as unknown as Parameters<typeof createChannel>[1],
      alice.handle,
      { name: "Alice's voice", description: 'Things worth keeping' },
    )

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
