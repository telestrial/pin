// Full-account wipe primitives, exercised through the Phase 3 fakes (which
// need the @atproto/api + sia-storage module mocks, hence the int tier).

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@atproto/api', async () =>
  (await import('../test/fakeModules')).fakeAtprotoApiModule(),
)
vi.mock('./jetstream', async () =>
  (await import('../test/fakeModules')).fakeJetstreamModule(),
)
vi.mock('@siafoundation/sia-storage', async () =>
  (await import('../test/fakeModules')).fakeSiaStorageModule(),
)

import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { createFakeApp, resetAllStores } from '../test/setupFakeApp'
import { CHANNEL_LEXICON } from './atproto'
import { SUBSCRIPTION_LEXICON } from './follow'
import { PROFILE_LEXICON } from './profile'
import { PIN_LEXICONS, wipeAllPinRecords, wipeAllSiaObjects } from './reset'
import { SETTINGS_LEXICON } from './settingsRecord'
import { uploadItem } from './sia'

const DID = 'did:plc:alice'

describe('integration: full-account wipe', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('wipeAllSiaObjects deletes every object in scope and reports counts', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: DID, handle: 'alice.test' })
    const sdk = alice.sdk as unknown as Sdk

    await uploadItem(sdk, new Uint8Array(100))
    await uploadItem(sdk, new Uint8Array(200))
    await uploadItem(sdk, new Uint8Array(300))
    expect(app.world.scopeOf(DID).size).toBe(3)

    const res = await wipeAllSiaObjects(sdk)
    expect(res).toEqual({ deleted: 3, failed: 0 })
    expect(app.world.scopeOf(DID).size).toBe(0)
  })

  it('wipeAllSiaObjects is a no-op on an empty scope', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: DID, handle: 'alice.test' })
    const res = await wipeAllSiaObjects(alice.sdk as unknown as Sdk)
    expect(res).toEqual({ deleted: 0, failed: 0 })
  })

  it('wipeAllPinRecords deletes records across every Pin lexicon', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: DID, handle: 'alice.test' })
    const agent = alice.agent as unknown as Agent

    const put = (collection: string, rkey: string) =>
      agent.com.atproto.repo.putRecord({
        repo: DID,
        collection,
        rkey,
        record: { $type: collection },
      })
    await put(CHANNEL_LEXICON, 'chan0000000000aa')
    await put(CHANNEL_LEXICON, 'chan0000000000bb')
    await put(PROFILE_LEXICON, 'self')
    await put(SUBSCRIPTION_LEXICON, 'sub0000000000cc')
    await put(SETTINGS_LEXICON, 'self')

    const res = await wipeAllPinRecords(agent)
    expect(res.deleted).toBe(5)
    expect(res.failed).toBe(0)

    for (const collection of PIN_LEXICONS) {
      const list = await agent.com.atproto.repo.listRecords({
        repo: DID,
        collection,
      })
      expect(list.data.records).toHaveLength(0)
    }
  })
})
