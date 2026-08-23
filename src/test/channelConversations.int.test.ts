// The words' floor, from the reader's side: a channel's published conversations reach a
// screen through the same cache-then-resolve path its counts do.
//
// The Curator's loops normally fill that cache — the engagement loop for a channel this
// identity owns, channelsync for a subscribed one. Neither runs here, which is the point:
// what these cover is the FALL-THROUGH, the rung that answers when no pass has come round
// yet. A just-pasted subscribe URL is exactly that case.

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

import { createChannel } from '../core/channels'
import { channelKeyFromBase64 } from '../core/crypto'
import {
  readConversation,
  warmChannelConversations,
} from '../lib/channelConversations'
import { commitChannelManifest } from '../lib/channelLocator'
import { readTally, warmChannelTallies } from '../lib/channelTallies'
import {
  fakeDocStore as docStore,
  publishFakeConversations,
  publishFakeTallies,
} from './fakeModules'
import { createFakeApp, FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

const PUBLISHED_AT = '2026-08-22T10:00:00.000Z'

/** One comment, in the shape a fold publishes. */
function comment(body: string, createdAt: string) {
  return {
    kind: 'comment',
    actor: 'did:dht:bob',
    subject: 'ignored-here',
    version: 'bafkreiabc',
    createdAt,
    sig: `sig-${createdAt}`,
    body,
  }
}

async function aChannelWithComments(did: string, bodies: string[]) {
  const app = createFakeApp()
  const alice = app.createAccount({ did, handle: `${did}.test` })
  const created = await createChannel(alice.client, {
    name: 'Talkative',
    description: '',
  })
  await commitChannelManifest(
    alice.client,
    FAKE_APP_KEY_HEX,
    created.channelID,
    created.channelKey,
    created.manifest,
  )

  const k = channelKeyFromBase64(created.channelKey)
  const { engagement_subject } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  const subject = engagement_subject(created.channelID, PUBLISHED_AT, undefined)
  publishFakeConversations(k, {
    [subject]: {
      comments: bodies.map((b, i) => comment(b, `2026-08-22T1${i}:00:00.000Z`)),
      updatedAt: PUBLISHED_AT,
    },
  })
  return { ...created, subject }
}

describe('integration: a channel’s published conversation reaches a reader', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('caches every subject the author published, read back by the item it belongs to', async () => {
    const channel = await aChannelWithComments('did:plc:conv1', [
      'first',
      'second',
    ])

    await warmChannelConversations(
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
    )

    // Read by the item, not by the subject: a screen knows what it is rendering and the
    // subject is derived from that. A mismatch between how the cache is keyed on write and
    // on read would be invisible to both compilers.
    const conversation = await readConversation(FAKE_APP_KEY_HEX, {
      channelID: channel.channelID,
      publishedAt: PUBLISHED_AT,
    })
    expect(conversation?.comments.map((c) => c.body)).toEqual([
      'first',
      'second',
    ])
  })

  it('carries each comment as its author signed it', async () => {
    // Verbatim, so a reader can check the signature against the actor's own key rather than
    // trusting whoever published the page — which is what makes the words attributable to
    // the person who wrote them.
    const channel = await aChannelWithComments('did:plc:conv2', ['as written'])
    await warmChannelConversations(
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
    )

    const held = await readConversation(FAKE_APP_KEY_HEX, {
      channelID: channel.channelID,
      publishedAt: PUBLISHED_AT,
    })
    const one = held?.comments[0]
    expect(one?.actor).toBe('did:dht:bob')
    expect(one?.sig).toBe(`sig-${one?.createdAt}`)
    expect(one?.kind).toBe('comment')
  })

  it('reports nothing for an item nobody has commented on', async () => {
    const channel = await aChannelWithComments('did:plc:conv3', ['somewhere'])
    await warmChannelConversations(
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
    )

    // A different item in the same channel. Absent reads the same as none to a screen, so
    // this must be null rather than the neighbouring item's conversation.
    expect(
      await readConversation(FAKE_APP_KEY_HEX, {
        channelID: channel.channelID,
        publishedAt: '2026-08-22T11:00:00.000Z',
      }),
    ).toBeNull()
  })

  it('reports nothing for a channel whose author has published none', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:conv4',
      handle: 'conv4.test',
    })
    const created = await createChannel(alice.client, {
      name: 'Quiet',
      description: '',
    })
    await commitChannelManifest(
      alice.client,
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
      created.manifest,
    )

    // The common case by a wide margin, and it must read as nothing rather than throwing.
    await warmChannelConversations(
      FAKE_APP_KEY_HEX,
      created.channelID,
      created.channelKey,
    )
    expect(
      await readConversation(FAKE_APP_KEY_HEX, {
        channelID: created.channelID,
        publishedAt: PUBLISHED_AT,
      }),
    ).toBeNull()
  })

  it('keeps counts and conversations apart', async () => {
    // Two objects behind two pointers. Sharing either would make publishing the words
    // overwrite the numbers, and a feed row would start carrying every comment body.
    const channel = await aChannelWithComments('did:plc:conv5', ['said'])
    const k = channelKeyFromBase64(channel.channelKey)
    publishFakeTallies(k, {
      [channel.subject]: {
        kinds: { comment: { count: 1, setRoot: 'root', sampleActors: [] } },
        updatedAt: PUBLISHED_AT,
      },
    })

    await warmChannelTallies(
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
    )
    await warmChannelConversations(
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
    )

    const item = { channelID: channel.channelID, publishedAt: PUBLISHED_AT }
    expect(
      (await readTally(FAKE_APP_KEY_HEX, item))?.kinds.comment?.count,
    ).toBe(1)
    expect(
      (await readConversation(FAKE_APP_KEY_HEX, item))?.comments,
    ).toHaveLength(1)
  })
})
