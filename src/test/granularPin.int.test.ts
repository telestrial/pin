// Author-side granular pinning: reference-safe cleanup on retract.
//
// The core channels functions compute the reference-safe orphan list (the body
// + attachments whose bytes nothing surviving still references) and hand it
// back; the journal's delete-objects handler does the actual byte reclaim. A
// file shared with another of your posts or held by a standalone library pin
// must be excluded from the list. These tests exercise the core functions (and
// the core→handler hand-off) through the Phase 3 fakes (sia-storage module
// mock, hence the int tier).

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)

import {
  appendItemToChannel,
  buildItemRef,
  createChannel,
  deletePublishedItem,
  removeAttachmentFromItem,
  unpinChannel,
} from '../core/channels'
import type { AttachmentRef, ChannelManifest, ItemRef } from '../core/types'
import { runDeleteObjects } from '../lib/actions/deleteObjects'
import type { DeleteObjectsAction } from '../stores/actionQueue'
import { createFakeApp, type FakeAccount, resetAllStores } from './setupFakeApp'

// Upload a post's content bytes (attachments + body) into the author's Sia
// scope and append the item to the in-hand manifest. The manifest stays
// in-memory (NOT committed to a locator) — these tests exercise the PURE core
// enumeration + the cleanup handler, so scope holds only content objects and
// the scope-size math stays clean. Returns the new manifest + the ids.
async function publishPostWithAttachments(
  author: FakeAccount,
  manifest: ChannelManifest,
  body: string,
  files: { mime: string; size: number }[],
): Promise<{
  item: ItemRef
  manifest: ChannelManifest
  bodyObjectID: string
  attachmentObjectIDs: string[]
}> {
  const client = author.client

  const attachments: AttachmentRef[] = []
  const attachmentObjectIDs: string[] = []
  for (const f of files) {
    const up = await client.uploadItem(new Uint8Array(f.size))
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
  const uploaded = await client.uploadItem(bytes)
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
  return {
    item,
    manifest: appendItemToChannel(manifest, item),
    bodyObjectID: uploaded.id,
    attachmentObjectIDs,
  }
}

describe('integration: author-side granular pinning', () => {
  beforeEach(() => {
    resetAllStores()
  })

  async function setup() {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    // Build the channel WITHOUT committing a locator, so alice's scope holds
    // only the content objects the enumeration tests assert on.
    const channel = await createChannel(alice.client, {
      name: "Alice's voice",
      description: '',
    })
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
    const { item, manifest, bodyObjectID, attachmentObjectIDs } =
      await publishPostWithAttachments(alice, channel.manifest, 'hi', [
        { mime: 'image/png', size: 200 },
        { mime: 'application/pdf', size: 300 },
      ])
    expect(app.world.scopeOf('did:plc:alice').size).toBe(3)

    const { orphanedObjectIDs } = deletePublishedItem(manifest, item.id)

    // Core computes the reference-safe prune but does NOT delete — that's the
    // journal's job. Scope is unchanged until the cleanup runs.
    expect(new Set(orphanedObjectIDs)).toEqual(
      new Set([bodyObjectID, ...attachmentObjectIDs]),
    )
    expect(app.world.scopeOf('did:plc:alice').size).toBe(3)
  })

  it('the orphan list, run through the cleanup handler, empties the scope', async () => {
    const { app, alice, channel } = await setup()
    const { item, manifest } = await publishPostWithAttachments(
      alice,
      channel.manifest,
      'hi',
      [
        { mime: 'image/png', size: 200 },
        { mime: 'application/pdf', size: 300 },
      ],
    )
    expect(app.world.scopeOf('did:plc:alice').size).toBe(3)

    const { orphanedObjectIDs } = deletePublishedItem(manifest, item.id)
    await runDeleteObjects(cleanup(orphanedObjectIDs), {
      client: alice.client,
      markDone: () => {},
    })

    // The full author-retract path — core prune → journal cleanup — reclaims
    // every content byte. No sweep involved.
    expect(app.world.scopeOf('did:plc:alice').size).toBe(0)
  })

  it('retract excludes a protected attachment from the orphan list', async () => {
    const { alice, channel } = await setup()
    const { item, manifest, bodyObjectID, attachmentObjectIDs } =
      await publishPostWithAttachments(alice, channel.manifest, 'hi', [
        { mime: 'image/png', size: 200 },
      ])
    const sharedFileID = attachmentObjectIDs[0]

    // Simulate the file being held by another of alice's posts / a library pin.
    const { orphanedObjectIDs } = deletePublishedItem(
      manifest,
      item.id,
      new Set([sharedFileID]),
    )

    // Body orphaned; the protected attachment is left out of the list.
    expect(orphanedObjectIDs).toEqual([bodyObjectID])
  })

  it('removeAttachmentFromItem returns the removed file as the orphan list', async () => {
    const { alice, channel } = await setup()
    const { item, manifest, attachmentObjectIDs } =
      await publishPostWithAttachments(alice, channel.manifest, 'hi', [
        { mime: 'image/png', size: 200 },
        { mime: 'image/png', size: 250 },
      ])
    const fileA = attachmentObjectIDs[0]
    const fileAURL = item.attachments?.[0].url as string

    const { item: edited, orphanedObjectIDs } = removeAttachmentFromItem(
      manifest,
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
    const { item, manifest, attachmentObjectIDs } =
      await publishPostWithAttachments(alice, channel.manifest, 'hi', [
        { mime: 'image/png', size: 200 },
      ])
    const fileA = attachmentObjectIDs[0]
    const fileAURL = item.attachments?.[0].url as string

    const { item: edited, orphanedObjectIDs } = removeAttachmentFromItem(
      manifest,
      item.id,
      fileAURL,
      new Set([fileA]),
    )

    // Dropped from the post, but the protected bytes are left out of the list.
    expect(edited.attachments).toHaveLength(0)
    expect(orphanedObjectIDs).toEqual([])
  })

  it('unpinChannel enumerates the channel bytes as the orphan list (core does not delete)', async () => {
    const { app, alice, channel } = await setup()
    const { manifest, bodyObjectID, attachmentObjectIDs } =
      await publishPostWithAttachments(alice, channel.manifest, 'hi', [
        { mime: 'image/png', size: 200 },
      ])
    expect(app.world.scopeOf('did:plc:alice').size).toBe(2)

    const { objectIDs, urls } = unpinChannel(manifest)

    // Bytes are enumerated for the journal, not deleted by core.
    expect(new Set(objectIDs)).toEqual(
      new Set([bodyObjectID, ...attachmentObjectIDs]),
    )
    expect(urls).toEqual([])
    expect(app.world.scopeOf('did:plc:alice').size).toBe(2)
  })

  it('unpinChannel orphan list, run through the cleanup handler, empties the scope', async () => {
    const { app, alice, channel } = await setup()
    const { manifest } = await publishPostWithAttachments(
      alice,
      channel.manifest,
      'hi',
      [{ mime: 'image/png', size: 200 }],
    )
    const { objectIDs } = unpinChannel(manifest)
    await runDeleteObjects(cleanup(objectIDs), {
      client: alice.client,
      markDone: () => {},
    })
    expect(app.world.scopeOf('did:plc:alice').size).toBe(0)
  })

  it('unpinChannel excludes protected object IDs from the orphan list', async () => {
    const { alice, channel } = await setup()
    const { manifest, bodyObjectID, attachmentObjectIDs } =
      await publishPostWithAttachments(alice, channel.manifest, 'hi', [
        { mime: 'image/png', size: 200 },
      ])
    const sharedFileID = attachmentObjectIDs[0]

    const { objectIDs } = unpinChannel(manifest, new Set([sharedFileID]))

    // The protected attachment is left out; the body is still orphaned.
    expect(objectIDs).toEqual([bodyObjectID])
  })
})
