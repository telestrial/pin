// `pinItem` — taking custody of a whole item: the body plus every attachment.
//
// Only the client-level surface is covered here. The accounting walk that used to be
// tested alongside it (`fetchRawContentBytes`, `fetchAccountSnapshot`) has moved into
// Rust, where the fast tiers can't reach it; what those tests asserted about scope
// isolation and release now lives as a SiaClient contract in test/fakeSia.test.ts.

import { describe, expect, it } from 'vitest'
import { createFakeWorld, FakeSiaClient } from '../test/fakeSia'
import { pinItem } from './pin'
import type { ItemRef } from './types'

function twoAccounts() {
  const world = createFakeWorld()
  return {
    world,
    alice: new FakeSiaClient('alice', world),
    bob: new FakeSiaClient('bob', world),
  }
}

/** Upload into the author's scope and return the share URL a reader would hold —
 *  the cross-account mirror path `pinItem` walks. */
async function share(
  author: FakeSiaClient,
  byteLength: number,
): Promise<string> {
  const { itemURL } = await author.uploadItem(new Uint8Array(byteLength))
  return itemURL
}

function makeItem(itemURL: string, attachmentURLs: string[] = []): ItemRef {
  return {
    id: 'item',
    itemURL,
    type: 'text',
    title: '',
    summary: '',
    publishedAt: '2026-01-01T00:00:00.000Z',
    mimeType: 'text/markdown',
    byteSize: 100,
    attachments: attachmentURLs.map((url) => ({
      url,
      mimeType: 'application/octet-stream',
      byteSize: 1,
    })),
  }
}

describe('pinItem', () => {
  // What makes a pinned copy whole: the images and audio survive with the post, so
  // custody still holds after the author retracts.
  it('mirrors body and every attachment into the caller scope', async () => {
    const { world, alice, bob } = twoAccounts()
    const item = makeItem(await share(alice, 100), [
      await share(alice, 200),
      await share(alice, 300),
    ])

    const { objectID, attachmentObjectIDs } = await pinItem(bob, item)

    expect(attachmentObjectIDs).toHaveLength(2)
    expect(world.scopeOf('bob').size).toBe(3)
    expect(world.scopeOf('bob').has(objectID)).toBe(true)
    for (const id of attachmentObjectIDs) {
      expect(world.scopeOf('bob').has(id)).toBe(true)
    }
  })

  it('pins body-only when there are no attachments', async () => {
    const { world, alice, bob } = twoAccounts()

    const { attachmentObjectIDs } = await pinItem(
      bob,
      makeItem(await share(alice, 100)),
    )

    expect(attachmentObjectIDs).toHaveLength(0)
    expect(world.scopeOf('bob').size).toBe(1)
  })

  // Pre-schema entries still sit in old manifests; one of them must not cost the
  // reader the rest of the item.
  it('skips malformed attachments rather than crashing', async () => {
    const { world, alice, bob } = twoAccounts()
    const item = makeItem(await share(alice, 100), [await share(alice, 200)])
    item.attachments = [
      ...(item.attachments ?? []),
      'bare-string-url' as unknown as never,
      { mimeType: 'image/png' } as unknown as never,
    ]

    const { attachmentObjectIDs } = await pinItem(bob, item)

    expect(attachmentObjectIDs).toHaveLength(1)
    expect(world.scopeOf('bob').size).toBe(2)
  })

  it('leaves the author holding their copy, so release is independent', async () => {
    const { world, alice, bob } = twoAccounts()
    const item = makeItem(await share(alice, 100), [await share(alice, 200)])
    expect(world.scopeOf('alice').size).toBe(2)

    const { objectID, attachmentObjectIDs } = await pinItem(bob, item)
    for (const id of [objectID, ...attachmentObjectIDs]) {
      await bob.deleteObject(id)
    }

    expect(world.scopeOf('bob').size).toBe(0)
    expect(world.scopeOf('alice').size).toBe(2)
  })
})
