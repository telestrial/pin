// The full-account Sia wipe, exercised against a FakeSiaClient (hence the int
// tier). did:dht/pkarr records aren't wiped — they TTL out — so there's nothing
// atproto to exercise here anymore.

import { beforeEach, describe, expect, it } from 'vitest'

import { createFakeApp, resetAllStores } from '../test/setupFakeApp'
import { wipeAllSiaObjects } from './reset'

const DID = 'did:plc:alice'

describe('integration: full-account wipe', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('wipeAllSiaObjects deletes every object in scope and reports counts', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: DID, handle: 'alice.test' })
    const client = alice.client

    await client.uploadItem(new Uint8Array(100))
    await client.uploadItem(new Uint8Array(200))
    await client.uploadItem(new Uint8Array(300))
    expect(app.world.scopeOf(DID).size).toBe(3)

    const res = await wipeAllSiaObjects(client)
    expect(res).toEqual({ deleted: 3, failed: 0 })
    expect(app.world.scopeOf(DID).size).toBe(0)
  })

  it('wipeAllSiaObjects is a no-op on an empty scope', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({ did: DID, handle: 'alice.test' })
    const res = await wipeAllSiaObjects(alice.client)
    expect(res).toEqual({ deleted: 0, failed: 0 })
  })
})
