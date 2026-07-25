// The durable settings pointer. A pkarr locator (AppKey-keyed) names the current
// Sia settings snapshot, so a device with NO localStorage pointer — a restore on a
// fresh device, or a wiped-pointer boot (the orphan-sweep-retro catastrophe) —
// recovers the whole account from the recovery phrase alone. And a brand-new
// account (recovery off) must NOT resolve: there's nothing to recover, so a new
// user pays no DHT round-trip. This locks both.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@siafoundation/sia-storage', async () =>
  (await import('./fakeModules')).fakeSiaStorageModule(),
)
vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
// docsMirror imports the wasm doc engine at the top; the recovery READ path never
// touches it (it's a plain Sia download + decrypt), so stub it — keeps wasm out of
// jsdom without weakening what we're testing.
vi.mock('../lib/docs', () => ({
  getRecord: async () => undefined,
  listAll: async () => [],
  putRecord: async () => {},
  openDocs: async () => '',
}))

import {
  deriveSettingsLocatorSeed,
  deriveSnapshotKey,
  encryptForChannel,
} from '../core/crypto'
import type { SiaClient } from '../core/siaClient'
import { readRecordFromSnapshot } from '../lib/docsMirror'
import { chunkForTxt } from '../lib/pkarr'
import { pkarrTransport } from '../lib/pkarrTransport'
import { createFakeApp, resetAllStores } from './setupFakeApp'

const POINTER_KEY = 'pin:docsnapshot:pointer'
// Mirrors docsMirror's private SETTINGS_POINTER_PREFIX.
const SETTINGS_POINTER_PREFIX = '_s'

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

describe('integration: settings recovery via pkarr locator', () => {
  const appKey = new Uint8Array(32).fill(1)
  const SETTINGS_BLOB = 'encrypted-settings-blob'
  let client: SiaClient

  beforeEach(async () => {
    resetAllStores()
    localStorage.clear()
    const app = createFakeApp()
    client = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    }).client

    // Build an encrypted snapshot holding one settings record + upload it to Sia,
    // exactly as snapshotToSia would (a [{c,k,v}] array encrypted under the
    // snapshot key).
    const entries = [
      {
        c: 'settings',
        k: 'self',
        v: b64(new TextEncoder().encode(SETTINGS_BLOB)),
      },
    ]
    const snapKey = await deriveSnapshotKey(appKey)
    const ciphertext = await encryptForChannel(snapKey, JSON.stringify(entries))
    const uploaded = await client.uploadItem(
      new TextEncoder().encode(ciphertext),
    )

    // Publish the durable locator naming that snapshot object (what snapshotToSia
    // does after upload).
    const seed = await deriveSettingsLocatorSeed(appKey)
    await (await pkarrTransport()).publish(
      seed,
      chunkForTxt(SETTINGS_POINTER_PREFIX, uploaded.itemURL),
    )

    // Simulate a device with no local pointer (fresh device / wipe).
    localStorage.removeItem(POINTER_KEY)
  })

  it('recovers the settings record from the DHT locator when recovery is allowed', async () => {
    const bytes = await readRecordFromSnapshot(
      client,
      appKey,
      'settings',
      'self',
      true,
    )
    expect(bytes).toBeDefined()
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(SETTINGS_BLOB)
  })

  it('does NOT resolve the locator when recovery is off (brand-new-account gate)', async () => {
    const bytes = await readRecordFromSnapshot(
      client,
      appKey,
      'settings',
      'self',
      false,
    )
    expect(bytes).toBeUndefined()
  })
})
