// The pin list as doc records: what you keep has to travel, and the Curator has to be
// able to read it before it can repack anything.
//
// The two properties worth locking are the ones a mirror gets wrong quietly. A pin
// whose bytes moved must keep the SAME record — repack rewrites itemURL and objectID,
// and a key built from either would leave the old record orphaned and the new pin
// unrecorded. And an unpinned item's record must actually go, or the Curator keeps
// repacking bytes nobody holds.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import type { ItemRef } from '../core/types'
import { readPinRecords, syncPinRecords } from '../lib/pinRecords'
import type { PinnedItemRef } from '../stores/pin'
import { fakeDocStore as docStore } from './fakeModules'
import { FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

function item(overrides: Partial<ItemRef> = {}): ItemRef {
  return {
    id: 'obj-1',
    itemURL: 'sia://obj-1#encryption_key=k1',
    type: 'text',
    title: 'A post',
    summary: 'body',
    publishedAt: '2026-08-09T12:00:00.000Z',
    mimeType: 'text/markdown',
    byteSize: 4,
    ...overrides,
  }
}

function pin(overrides: Partial<PinnedItemRef> = {}): PinnedItemRef {
  return {
    item: item(),
    channel: { authorHandle: '', channelID: 'chan1', name: 'Theirs' },
    objectID: 'obj-1',
    pinnedAt: '2026-08-09T12:00:01.000Z',
    ...overrides,
  }
}

const keysIn = () => [...docStore.keys()].filter((k) => k.startsWith('pin/'))

describe('integration: pins are recorded in the doc', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('round-trips a pin through a sealed record', async () => {
    const held = pin()
    await syncPinRecords(FAKE_APP_KEY_HEX, [held])

    expect(keysIn()).toEqual(['pin/chan1:2026-08-09T12:00:00.000Z'])
    // Sealed, not plaintext: the record names a Sia object by share URL, and the
    // fragment of a share URL is that object's decryption key.
    const raw = new TextDecoder().decode(
      docStore.get('pin/chan1:2026-08-09T12:00:00.000Z') as Uint8Array,
    )
    expect(raw).not.toContain('encryption_key')

    expect(await readPinRecords(FAKE_APP_KEY_HEX)).toEqual([held])
  })

  it('keeps one record when repack moves a pin to new bytes', async () => {
    const before = pin()
    await syncPinRecords(FAKE_APP_KEY_HEX, [before])

    // Exactly what repack's replaceMany does: same logical item, new object.
    const after = pin({
      objectID: 'obj-2',
      item: item({ id: 'obj-2', itemURL: 'sia://obj-2#encryption_key=k2' }),
    })
    const result = await syncPinRecords(FAKE_APP_KEY_HEX, [after])

    expect(result).toEqual({ written: 1, deleted: 0 })
    expect(keysIn()).toHaveLength(1)
    const [recorded] = await readPinRecords(FAKE_APP_KEY_HEX)
    expect(recorded.objectID).toBe('obj-2')
  })

  it('writes nothing when the pins have not moved', async () => {
    const held = pin()
    await syncPinRecords(FAKE_APP_KEY_HEX, [held])
    // A quiet reconcile must not rewrite records: every write announces a change to
    // every instance syncing this doc.
    expect(await syncPinRecords(FAKE_APP_KEY_HEX, [held])).toEqual({
      written: 0,
      deleted: 0,
    })
  })

  it('removes the record when the pin is released', async () => {
    await syncPinRecords(FAKE_APP_KEY_HEX, [pin()])
    const result = await syncPinRecords(FAKE_APP_KEY_HEX, [])
    expect(result).toEqual({ written: 0, deleted: 1 })
    expect(keysIn()).toEqual([])
  })

  it('separates library pins that share a channel', async () => {
    const a = pin({
      channel: { authorHandle: '', channelID: 'library', name: 'Library' },
      item: item({ publishedAt: '2026-08-09T12:00:00.000Z' }),
    })
    const b = pin({
      channel: { authorHandle: '', channelID: 'library', name: 'Library' },
      objectID: 'obj-9',
      item: item({
        id: 'obj-9',
        itemURL: 'sia://obj-9#encryption_key=k9',
        publishedAt: '2026-08-09T12:00:00.001Z',
      }),
    })
    await syncPinRecords(FAKE_APP_KEY_HEX, [a, b])
    expect(keysIn()).toHaveLength(2)
  })
})
