import type { Sdk } from '@siafoundation/sia-storage'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AttachmentRef, ItemRef } from '../core/types'
import { itemRefFromAttachment } from '../lib/filePin'
import { LIBRARY_CHANNEL } from '../lib/pinUpload'
import { createFakeWorld, FakeSdk } from '../test/fakeSdk'
import { objectIDsReferencedBy, type PinnedItemRef, usePinStore } from './pin'

function asSdk(fake: FakeSdk): Sdk {
  return fake as unknown as Sdk
}

async function uploadAndShare(
  fake: FakeSdk,
  bytes: Uint8Array,
): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  const obj = await fake.upload(null, stream)
  return fake.shareObject(obj, new Date())
}

function pinEntry(
  objectID: string,
  attachmentObjectIDs: string[] = [],
): PinnedItemRef {
  return {
    item: {
      id: objectID,
      itemURL: `url-${objectID}`,
      type: 'file',
      title: '',
      publishedAt: '',
      mimeType: '',
      byteSize: 0,
    },
    channel: { authorHandle: '', channelID: 'c', name: 'n' },
    objectID,
    attachmentObjectIDs,
    pinnedAt: '',
  }
}

describe('objectIDsReferencedBy', () => {
  it('collects body + attachment object IDs across pins', () => {
    const set = objectIDsReferencedBy([pinEntry('a', ['b', 'c']), pinEntry('d')])
    expect([...set].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is empty for no pins', () => {
    expect(objectIDsReferencedBy([]).size).toBe(0)
  })

  it('tolerates entries without attachmentObjectIDs (legacy)', () => {
    const p = pinEntry('a')
    delete (p as { attachmentObjectIDs?: string[] }).attachmentObjectIDs
    expect([...objectIDsReferencedBy([p])]).toEqual(['a'])
  })
})

// Granular pinning: a file's bytes can be held by both a whole-post pin and a
// standalone library pin (content-addressed, same Sia object). Unpin must be
// reference-aware — delete only bytes no other pin still holds.
describe('reference-aware unpin (granular pinning)', () => {
  beforeEach(() => {
    usePinStore.getState().reset()
    localStorage.clear()
  })

  async function setup() {
    const world = createFakeWorld()
    const alice = new FakeSdk('alice', world)
    const bob = new FakeSdk('bob', world)
    const bodyURL = await uploadAndShare(alice, new Uint8Array(100))
    const fileURL = await uploadAndShare(alice, new Uint8Array(500))
    const att: AttachmentRef = {
      url: fileURL,
      mimeType: 'image/png',
      filename: 'pic.png',
      byteSize: 500,
    }
    const post: ItemRef = {
      id: 'post',
      itemURL: bodyURL,
      type: 'text',
      title: '',
      summary: 'hi',
      publishedAt: '2026-01-01T00:00:00.000Z',
      mimeType: 'text/markdown',
      byteSize: 100,
      attachments: [att],
    }
    return { world, bob, bodyURL, fileURL, att, post }
  }

  it('keeps file bytes when a standalone file pin still holds them', async () => {
    const { world, bob, bodyURL, fileURL, att, post } = await setup()
    const store = usePinStore.getState()

    // Bob pins the whole post (body + file) → 2 objects in his scope.
    await store.pin(asSdk(bob), {
      item: post,
      channel: { authorHandle: 'alice', channelID: 'chan', name: 'Alice' },
    })
    expect(world.scopeOf('bob').size).toBe(2)

    // Bob also pins the file standalone into his library. pinObject is
    // idempotent at Sia (same bytes), but a second pinStore entry is created.
    await store.pin(asSdk(bob), {
      item: itemRefFromAttachment(att),
      channel: LIBRARY_CHANNEL,
    })
    expect(world.scopeOf('bob').size).toBe(2)
    expect(usePinStore.getState().pinned).toHaveLength(2)

    // Unpin the whole post. Body is released; the file survives because the
    // library pin still references it.
    await store.unpin(asSdk(bob), bodyURL)
    const remaining = usePinStore.getState().pinned
    expect(remaining).toHaveLength(1)
    expect(remaining[0].item.itemURL).toBe(fileURL)
    expect(world.scopeOf('bob').size).toBe(1)
    expect(world.scopeOf('bob').has(remaining[0].objectID)).toBe(true)

    // Unpin the file too → its bytes are now released.
    await store.unpin(asSdk(bob), fileURL)
    expect(usePinStore.getState().pinned).toHaveLength(0)
    expect(world.scopeOf('bob').size).toBe(0)
  })

  it('releases an attachment when no other pin references it', async () => {
    const { world, bob, bodyURL, post } = await setup()
    const store = usePinStore.getState()

    await store.pin(asSdk(bob), {
      item: post,
      channel: { authorHandle: 'alice', channelID: 'chan', name: 'Alice' },
    })
    expect(world.scopeOf('bob').size).toBe(2)

    // No standalone file pin holds the attachment → whole-post unpin releases
    // both body and attachment (today's behavior, preserved).
    await store.unpin(asSdk(bob), bodyURL)
    expect(world.scopeOf('bob').size).toBe(0)
    expect(usePinStore.getState().pinned).toHaveLength(0)
  })
})
