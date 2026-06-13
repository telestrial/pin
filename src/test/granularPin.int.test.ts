// Author-side granular pinning: eager, reference-safe cleanup on retract.
//
// A retract is a decision you made, so the bytes leave your storage now (not on
// the next orphan-sweep pass) — but a file shared with another of your posts or
// held by a standalone library pin must survive. These tests exercise the core
// channels functions through the Phase 3 fakes (which need the @atproto/api
// module mock, hence the int tier).

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

import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import {
  appendItemToChannel,
  buildItemRef,
  deletePublishedItem,
  removeAttachmentFromItem,
} from '../core/channels'
import { uploadItem } from '../core/sia'
import type { AttachmentRef, ItemRef } from '../core/types'
import {
  authorCreateChannel,
  createFakeApp,
  type FakeAccount,
  resetAllStores,
} from './setupFakeApp'

// Publish a post with N attachments through the real core/sia + core/channels
// paths. Returns the item plus the attachment objectIDs for scope assertions.
async function publishPostWithAttachments(
  author: FakeAccount,
  channel: { channelID: string; channelKey: string },
  body: string,
  files: { mime: string; size: number }[],
): Promise<{ item: ItemRef; bodyObjectID: string; attachmentObjectIDs: string[] }> {
  const sdk = author.sdk as unknown as Sdk
  const agent = author.agent as unknown as Agent

  const attachments: AttachmentRef[] = []
  const attachmentObjectIDs: string[] = []
  for (const f of files) {
    const up = await uploadItem(sdk, new Uint8Array(f.size))
    attachments.push({
      url: up.itemURL,
      mimeType: f.mime,
      byteSize: f.size,
      objectID: up.id,
      contentHash: up.contentHash,
    })
    attachmentObjectIDs.push(up.id)
  }

  const bytes = new TextEncoder().encode(body)
  const uploaded = await uploadItem(sdk, bytes)
  const item: ItemRef = {
    ...buildItemRef(uploaded, {
      type: 'text',
      title: '',
      summary: body,
      mimeType: 'text/markdown',
      bytes,
    }),
    attachments,
  }
  await appendItemToChannel(agent, channel, item)
  return { item, bodyObjectID: uploaded.id, attachmentObjectIDs }
}

describe('integration: author-side granular pinning', () => {
  beforeEach(() => {
    resetAllStores()
  })

  async function setup() {
    const app = createFakeApp()
    const alice = app.createAccount({ did: 'did:plc:alice', handle: 'alice.test' })
    const channel = await authorCreateChannel(alice, { name: "Alice's voice" })
    return { app, alice, channel }
  }

  it('retracting a post eagerly deletes the body AND its attachments', async () => {
    const { app, alice, channel } = await setup()
    const { item } = await publishPostWithAttachments(alice, channel, 'hi', [
      { mime: 'image/png', size: 200 },
      { mime: 'application/pdf', size: 300 },
    ])
    // body + 2 attachments in alice's scope.
    expect(app.world.scopeOf('did:plc:alice').size).toBe(3)

    await deletePublishedItem(
      alice.sdk as unknown as Sdk,
      alice.agent as unknown as Agent,
      channel,
      item.id,
    )

    // Eager: body and both attachments gone immediately — no waiting on a sweep.
    expect(app.world.scopeOf('did:plc:alice').size).toBe(0)
  })

  it('retract protects an attachment still referenced elsewhere', async () => {
    const { app, alice, channel } = await setup()
    const { item, attachmentObjectIDs } = await publishPostWithAttachments(
      alice,
      channel,
      'hi',
      [{ mime: 'image/png', size: 200 }],
    )
    const sharedFileID = attachmentObjectIDs[0]
    expect(app.world.scopeOf('did:plc:alice').size).toBe(2)

    // Simulate the file being held by another of alice's posts / a library pin.
    await deletePublishedItem(
      alice.sdk as unknown as Sdk,
      alice.agent as unknown as Agent,
      channel,
      item.id,
      new Set([sharedFileID]),
    )

    // Body released; the protected attachment survives.
    expect(app.world.scopeOf('did:plc:alice').has(sharedFileID)).toBe(true)
    expect(app.world.scopeOf('did:plc:alice').size).toBe(1)
  })

  it('removeAttachmentFromItem drops one file from the post and deletes its bytes', async () => {
    const { app, alice, channel } = await setup()
    const { item, bodyObjectID, attachmentObjectIDs } =
      await publishPostWithAttachments(alice, channel, 'hi', [
        { mime: 'image/png', size: 200 },
        { mime: 'image/png', size: 250 },
      ])
    const [fileA, fileB] = attachmentObjectIDs
    expect(app.world.scopeOf('did:plc:alice').size).toBe(3)

    const fileAURL = item.attachments?.[0].url as string
    const { item: edited } = await removeAttachmentFromItem(
      alice.sdk as unknown as Sdk,
      alice.agent as unknown as Agent,
      channel,
      item.id,
      fileAURL,
    )

    // Manifest entry keeps body + the other attachment; fileA's bytes are gone.
    expect(edited.attachments).toHaveLength(1)
    expect(edited.editedAt).toBeDefined()
    expect(app.world.scopeOf('did:plc:alice').has(fileA)).toBe(false)
    expect(app.world.scopeOf('did:plc:alice').has(fileB)).toBe(true)
    expect(app.world.scopeOf('did:plc:alice').has(bodyObjectID)).toBe(true)
    expect(app.world.scopeOf('did:plc:alice').size).toBe(2)
  })

  it('removeAttachmentFromItem keeps bytes a sibling reference protects', async () => {
    const { app, alice, channel } = await setup()
    const { item, attachmentObjectIDs } = await publishPostWithAttachments(
      alice,
      channel,
      'hi',
      [{ mime: 'image/png', size: 200 }],
    )
    const fileA = attachmentObjectIDs[0]
    const fileAURL = item.attachments?.[0].url as string

    const { item: edited } = await removeAttachmentFromItem(
      alice.sdk as unknown as Sdk,
      alice.agent as unknown as Agent,
      channel,
      item.id,
      fileAURL,
      new Set([fileA]),
    )

    // Dropped from the post, but the protected bytes survive in alice's scope.
    expect(edited.attachments).toHaveLength(0)
    expect(app.world.scopeOf('did:plc:alice').has(fileA)).toBe(true)
  })
})
