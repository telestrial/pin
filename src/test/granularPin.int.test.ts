// Author-side granular pinning: reference-safe cleanup on retract.
//
// The core channels functions compute the reference-safe orphan list (the body
// + attachments whose bytes nothing surviving still references) and hand it
// back; the journal's delete-objects handler does the actual byte reclaim. A
// file shared with another of your posts or held by a standalone library pin
// must be excluded from the list. These tests exercise the core functions (and
// the core→handler hand-off) through the Phase 3 fakes (which need the
// @atproto/api module mock, hence the int tier).

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
import { runDeleteObjects } from '../lib/actions/deleteObjects'
import type { DeleteObjectsAction } from '../stores/actionQueue'
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

  // Construct a minimal delete-objects action to drive the cleanup handler with
  // a real orphan list (the handler only reads intent + ledger).
  function cleanup(objectIDs: string[]): DeleteObjectsAction {
    return {
      intent: { objectIDs, urls: [] },
      ledger: {},
    } as unknown as DeleteObjectsAction
  }

  it('retract returns the body + all attachments as the orphan list (core does not delete)', async () => {
    const { app, alice, channel } = await setup()
    const { item, bodyObjectID, attachmentObjectIDs } =
      await publishPostWithAttachments(alice, channel, 'hi', [
        { mime: 'image/png', size: 200 },
        { mime: 'application/pdf', size: 300 },
      ])
    expect(app.world.scopeOf('did:plc:alice').size).toBe(3)

    const { orphanedObjectIDs } = await deletePublishedItem(
      alice.agent as unknown as Agent,
      channel,
      item.id,
    )

    // Core computes the reference-safe prune but does NOT delete — that's the
    // journal's job. Scope is unchanged until the cleanup runs.
    expect(new Set(orphanedObjectIDs)).toEqual(
      new Set([bodyObjectID, ...attachmentObjectIDs]),
    )
    expect(app.world.scopeOf('did:plc:alice').size).toBe(3)
  })

  it('the orphan list, run through the cleanup handler, empties the scope', async () => {
    const { app, alice, channel } = await setup()
    const { item } = await publishPostWithAttachments(alice, channel, 'hi', [
      { mime: 'image/png', size: 200 },
      { mime: 'application/pdf', size: 300 },
    ])
    expect(app.world.scopeOf('did:plc:alice').size).toBe(3)

    const { orphanedObjectIDs } = await deletePublishedItem(
      alice.agent as unknown as Agent,
      channel,
      item.id,
    )
    await runDeleteObjects(cleanup(orphanedObjectIDs), {
      sdk: alice.sdk as unknown as Sdk,
      markDone: () => {},
    })

    // The full author-retract path — core prune → journal cleanup — reclaims
    // every byte. No sweep involved.
    expect(app.world.scopeOf('did:plc:alice').size).toBe(0)
  })

  it('retract excludes a protected attachment from the orphan list', async () => {
    const { alice, channel } = await setup()
    const { item, bodyObjectID, attachmentObjectIDs } =
      await publishPostWithAttachments(alice, channel, 'hi', [
        { mime: 'image/png', size: 200 },
      ])
    const sharedFileID = attachmentObjectIDs[0]

    // Simulate the file being held by another of alice's posts / a library pin.
    const { orphanedObjectIDs } = await deletePublishedItem(
      alice.agent as unknown as Agent,
      channel,
      item.id,
      new Set([sharedFileID]),
    )

    // Body orphaned; the protected attachment is left out of the list.
    expect(orphanedObjectIDs).toEqual([bodyObjectID])
  })

  it('removeAttachmentFromItem returns the removed file as the orphan list', async () => {
    const { alice, channel } = await setup()
    const { item, attachmentObjectIDs } = await publishPostWithAttachments(
      alice,
      channel,
      'hi',
      [
        { mime: 'image/png', size: 200 },
        { mime: 'image/png', size: 250 },
      ],
    )
    const fileA = attachmentObjectIDs[0]
    const fileAURL = item.attachments?.[0].url as string

    const { item: edited, orphanedObjectIDs } = await removeAttachmentFromItem(
      alice.agent as unknown as Agent,
      channel,
      item.id,
      fileAURL,
    )

    // Manifest entry keeps body + the other attachment; fileA is the orphan.
    expect(edited.attachments).toHaveLength(1)
    expect(edited.editedAt).toBeDefined()
    expect(orphanedObjectIDs).toEqual([fileA])
  })

  it('removeAttachmentFromItem omits a protected sibling from the orphan list', async () => {
    const { alice, channel } = await setup()
    const { item, attachmentObjectIDs } = await publishPostWithAttachments(
      alice,
      channel,
      'hi',
      [{ mime: 'image/png', size: 200 }],
    )
    const fileA = attachmentObjectIDs[0]
    const fileAURL = item.attachments?.[0].url as string

    const { item: edited, orphanedObjectIDs } = await removeAttachmentFromItem(
      alice.agent as unknown as Agent,
      channel,
      item.id,
      fileAURL,
      new Set([fileA]),
    )

    // Dropped from the post, but the protected bytes are left out of the list.
    expect(edited.attachments).toHaveLength(0)
    expect(orphanedObjectIDs).toEqual([])
  })
})
