// The full-account Sia wipe, exercised through the Phase 3 fakes (sia-storage
// module mock, hence the int tier). did:dht/pkarr records aren't wiped (they
// TTL out), so there's nothing atproto to exercise here anymore.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@siafoundation/sia-storage', async () =>
  (await import('../test/fakeModules')).fakeSiaStorageModule(),
)

import type { Sdk } from '@siafoundation/sia-storage'
import { createFakeApp, resetAllStores } from '../test/setupFakeApp'
import { wipeAllSiaObjects } from './reset'
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
})
