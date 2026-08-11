// A pin is a mixed gesture, and this is where both halves are checked together.
//
// Pinning mirrors bytes into this identity's Sia scope — private, recorded as a sealed
// `pin/` record — AND says the thing was worth keeping, which is public and countable.
// Two records, because they are two facts with two audiences: nobody but you needs the
// share URL, and a count needs a signed public claim.
//
// The property this locks is why a fresh post reads 1 and not 0. Publishing already put
// the bytes in the author's scope, so the author IS pin #1; the number counts parties
// paying to keep the thing alive, not parties who liked it. And a retract takes the
// author's own endorsement with it, so the count falls to whoever is still holding a
// copy — which is exactly who is keeping it alive at that point.
//
// WHAT THIS TIER CANNOT SHOW: two identities' endorsements summing to 2. The fakes give
// every account the same AppKey and one shared doc store, so both would sign as the same
// actor and land on the same rkey, where in production each identity has its own doc.
// Summing across actors is the fold's property (and ultimately a live cross-device
// check); what's here is that each side writes its own half correctly.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import {
  endorsement_verify,
  engagement_subject,
} from '../../crates/pin-core/pkg/pin_core.js'
import { buildItemRef } from '../core/channels'
import {
  deleteItemFromChannel,
  publishItemToChannel,
} from '../lib/channelWrites'
import { useFeedStore } from '../stores/feed'
import { endorsedItemFor, usePinStore } from '../stores/pin'
import { fakeDocStore as docStore } from './fakeModules'
import {
  authorCreateChannel,
  createFakeApp,
  type FakeAccount,
  mountAs,
  resetAllStores,
} from './setupFakeApp'

const endorsements = () =>
  [...docStore.keys()]
    .filter((k) => k.startsWith('endorse/'))
    .map((k) => k.slice('endorse/'.length))
    .sort()
const record = (rkey: string) =>
  JSON.parse(new TextDecoder().decode(docStore.get(`endorse/${rkey}`)!))

/** Fire-and-forget writes run after the action returns, so wait for the record. */
async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function author(): Promise<{
  alice: FakeAccount
  channel: { channelID: string; channelKey: string }
}> {
  const app = createFakeApp()
  const alice = app.createAccount({
    did: 'did:plc:alice',
    handle: 'alice.test',
  })
  const channel = await authorCreateChannel(alice, { name: "Alice's voice" })
  mountAs(alice, {
    myChannels: [
      {
        channelID: channel.channelID,
        channelKey: channel.channelKey,
        name: "Alice's voice",
      },
    ],
  })
  return { alice, channel }
}

async function post(
  alice: FakeAccount,
  channel: { channelID: string; channelKey: string },
) {
  const bytes = new TextEncoder().encode('hello')
  const uploaded = await alice.client.uploadItem(bytes)
  const item = await buildItemRef(uploaded, {
    type: 'text',
    title: '',
    summary: 'hello',
    mimeType: 'text/markdown',
    bytes,
  })
  // The production write path, not the test helper's direct commit — this is the one
  // that endorses.
  await publishItemToChannel(alice.client, channel, item)
  return item
}

describe('integration: a pin is recorded as an endorsement too', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('starts a fresh post at one pin, the author', async () => {
    const { alice, channel } = await author()
    const item = await post(alice, channel)

    await settle(() => endorsements().length > 0)
    const subject = engagement_subject(channel.channelID, item.publishedAt)
    expect(endorsements()).toEqual([`pin:${subject}`])

    const held = record(`pin:${subject}`)
    expect(held.kind).toBe('pin')
    expect(held.version).toBe(item.contentHash)
    expect(() => endorsement_verify(JSON.stringify(held))).not.toThrow()
  })

  it('carries no reference for a channel that is not public', async () => {
    // A channel created without an explicit visibility is UNKNOWN, and unknown is never
    // treated as public. So the record is the hash alone: it says this identity endorsed
    // something, and nothing about which channel or that the channel exists.
    const { alice, channel } = await author()
    await post(alice, channel)

    await settle(() => endorsements().length > 0)
    const held = record(endorsements()[0])
    expect(held.ref).toBeUndefined()
    expect(JSON.stringify(held)).not.toContain(channel.channelID)
  })

  it('drops the author’s endorsement when the post is retracted', async () => {
    // The count then falls to whoever still holds a copy — and the post survives because
    // of them. This is the custody model as a number.
    const { alice, channel } = await author()
    const item = await post(alice, channel)
    await settle(() => endorsements().length > 0)

    await deleteItemFromChannel(alice.client, channel, item.id)
    await settle(() => endorsements().length === 0)
    expect(endorsements()).toEqual([])
  })

  it('keeps one endorsement across an edit, moved to the new version', async () => {
    const { alice, channel } = await author()
    const item = await post(alice, channel)
    await settle(() => endorsements().length > 0)
    const before = record(endorsements()[0])

    const bytes = new TextEncoder().encode('hello, fixed')
    const uploaded = await alice.client.uploadItem(bytes)
    const edited = await buildItemRef(uploaded, {
      type: 'text',
      title: '',
      summary: 'hello, fixed',
      mimeType: 'text/markdown',
      bytes,
    })
    const { editPublishedItem } = await import('../lib/channelWrites')
    await editPublishedItem(alice.client, channel, item.id, {
      ...edited,
      publishedAt: item.publishedAt,
    })

    await settle(() => record(endorsements()[0]).version !== before.version)
    // One record still: the subject is (channelID, publishedAt), which an edit preserves
    // on purpose, so an endorsement doesn't evaporate because the author fixed a typo.
    expect(endorsements()).toHaveLength(1)
    expect(record(endorsements()[0]).version).toBe(edited.contentHash)
  })

  it('endorses a pin of somebody else’s post, alongside the private pin record', async () => {
    const { alice, channel } = await author()
    const item = await post(alice, channel)
    await settle(() => endorsements().length > 0)
    docStore.clear()

    // Pinning a channel this identity doesn't own: the subscriber half of the gesture.
    await usePinStore.getState().pin(alice.client, {
      item,
      channel: {
        authorHandle: '',
        channelID: channel.channelID,
        name: "Alice's voice",
      },
    })

    const subject = engagement_subject(channel.channelID, item.publishedAt)
    await settle(() => docStore.has(`endorse/pin:${subject}`))

    // Both halves, and they are genuinely different records: the public one carries no
    // share URL, because the private one is the only place a decryption key belongs.
    expect(endorsements()).toEqual([`pin:${subject}`])
    const sealed = new TextDecoder().decode(
      docStore.get(`pin/${channel.channelID}:${item.publishedAt}`)!,
    )
    expect(sealed).not.toContain('encryption_key')
    expect(JSON.stringify(record(`pin:${subject}`))).not.toContain(
      'encryption_key',
    )

    await usePinStore.getState().unpin(alice.client, item.itemURL)
    await settle(() => !docStore.has(`endorse/pin:${subject}`))
    expect(endorsements()).toEqual([])
  })

  it('does not endorse a library pin yet', async () => {
    // A file uploaded straight to the library was never published, so nothing another
    // party could identify. An attachment lifted out of someone's post is the case that
    // changes: it gets its OWN subject and count rather than a share of the post's, since
    // keeping one file alive is not keeping the post alive.
    expect(
      endorsedItemFor({
        item: { publishedAt: '2026-08-11T12:00:00.000Z' },
        channel: { channelID: 'library' },
        // biome-ignore lint/suspicious/noExplicitAny: only the two fields read here matter
      } as any),
    ).toBeNull()
    expect(
      endorsedItemFor({
        item: { publishedAt: '2026-08-11T12:00:00.000Z', contentHash: 'bafy' },
        channel: { channelID: 'chan1' },
        // biome-ignore lint/suspicious/noExplicitAny: as above
      } as any),
    ).toEqual({
      channelID: 'chan1',
      publishedAt: '2026-08-11T12:00:00.000Z',
      contentHash: 'bafy',
    })
  })
})

// Keeps the feed store import honest: the reference lookup reads manifests from it, and
// a test that never touched it would not notice the lookup breaking.
describe('integration: the reference names a public channel’s author', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('names the author once the channel is public and its manifest is held', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    const channel = await authorCreateChannel(alice, { name: 'Public voice' })
    mountAs(alice, {
      myChannels: [
        {
          channelID: channel.channelID,
          channelKey: channel.channelKey,
          name: 'Public voice',
        },
      ],
    })
    // A public channel with a did:dht author is the navigable case: the reference costs
    // nothing, because everything in it is already in the author's directory.
    const publicManifest = {
      ...channel.manifest,
      visibility: 'public' as const,
      authorDidDht:
        'did:dht:iyypk375c71qwjem5isiramudutoogo1t9gogz8f587sfkt9db4o',
    }
    useFeedStore.getState().setManifest(channel.channelID, publicManifest)

    const bytes = new TextEncoder().encode('public post')
    const uploaded = await alice.client.uploadItem(bytes)
    const item = await buildItemRef(uploaded, {
      type: 'text',
      title: '',
      summary: 'public post',
      mimeType: 'text/markdown',
      bytes,
    })
    await publishItemToChannel(alice.client, channel, item)

    await settle(() => endorsements().length > 0)
    const held = record(endorsements()[0])
    expect(held.ref).toEqual({
      didDht: publicManifest.authorDidDht,
      channelID: channel.channelID,
      publishedAt: item.publishedAt,
    })
    // A reference has to hash to the subject it claims, or a reader ignores it — which is
    // what makes it safe to carry outside the signature.
    expect(() => endorsement_verify(JSON.stringify(held))).not.toThrow()
  })
})
