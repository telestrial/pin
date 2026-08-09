// The settings snapshot's pointer lives in the doc, not just in localStorage.
//
// Two jobs need it and only one of them is device-local. The READ path can stay on a
// localStorage cache — it's the boot-time settings read, deliberately kept free of the
// doc and the wasm engine. But the RECORD of what was published has to travel: it's
// what the Curator's keep-alive republishes from, and what a second device needs to
// reclaim the object this one superseded. Publish state is that record.
//
// So the load-bearing property here isn't "a pointer is written" — it's that the
// reclaim survives losing the local cache, which is the same thing as saying another
// device could have done it.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { snapshotToSia } from '../lib/docsMirror'
import { readPublished, settingsPublishKey } from '../lib/publishState'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

describe('integration: the settings snapshot records its pointer in the doc', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    localStorage.clear()
  })

  it('writes publish state under the rkey the keep-alive loop reads', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })

    const pointer = await snapshotToSia(alice.client, FAKE_APP_KEY_HEX)

    // The rkey comes from Rust on both sides, so this can't drift — but the record
    // has to actually be there, and it has to name the object we just uploaded.
    const rkey = await settingsPublishKey()
    expect(rkey).toBe('settings')
    const state = await readPublished(FAKE_APP_KEY_HEX, rkey)
    expect(state?.id).toBe(pointer.id)
    expect(state?.url).toBe(pointer.url)
  })

  it('reclaims the superseded snapshot even with no local cache', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })

    const first = await snapshotToSia(alice.client, FAKE_APP_KEY_HEX)
    expect(app.world.objects.has(first.id)).toBe(true)

    // Stand in for a DIFFERENT device: it holds the synced doc, so it has publish
    // state, but it has never written this browser's localStorage. Before publish
    // state travelled, this is exactly the case where the superseded object was
    // stranded with nothing left to reclaim it — the orphan sweep having been removed
    // on the positive-id principle.
    localStorage.clear()

    const second = await snapshotToSia(alice.client, FAKE_APP_KEY_HEX)
    expect(second.id).not.toBe(first.id)
    expect(app.world.objects.has(first.id)).toBe(false)
    expect(app.world.objects.has(second.id)).toBe(true)
  })
})
