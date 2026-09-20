// Restoring the doc from the durable snapshot, and the three answers that read has.
//
// On web the doc is a fresh MemStore every session, so what a boot can establish about
// the snapshot decides what the loops may then publish. Two of the three answers look
// identical from a record count — an identity that has published nothing, and a snapshot
// nobody could reach — and every loop that publishes current state treats the first as
// "endorses nothing" and would treat the second the same way. That conflation is the
// shape behind the orphan sweep and the cross-device settings wipe.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)

// Records what hydration writes, so a test can say the doc was left alone. The wasm doc
// engine never loads in jsdom; the restore path is a Sia download, a decrypt, and these
// writes.
const written: { c: string; k: string }[] = []
// What the doc already holds when the restore runs. A test fills this to stand for a
// record a peer synced in, or one the settings mirror wrote from localStorage.
const held: { collection: string; rkey: string }[] = []
vi.mock('../lib/docs', () => ({
  getRecord: async () => undefined,
  listAll: async () => held,
  putRecord: async (c: string, k: string) => {
    written.push({ c, k })
  },
  openDocs: async () => '',
}))

import {
  deriveSettingsLocatorSeed,
  deriveSnapshotKey,
  encryptForChannel,
} from '../core/crypto'
import type { SiaClient } from '../core/siaClient'
import { hydrateFromSia } from '../lib/docsMirror'
import { chunkForTxt } from '../lib/pkarr'
import { pkarrTransport } from '../lib/pkarrTransport'
import {
  addressOf,
  rememberWithdrawn,
  withdrawnAddresses,
} from '../lib/withdrawn'
import { createFakeApp, resetAllStores } from './setupFakeApp'

const POINTER_KEY = 'pin:docsnapshot:pointer'
// Mirrors docsMirror's private SETTINGS_POINTER_PREFIX.
const SETTINGS_POINTER_PREFIX = '_s'

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

describe('integration: restoring the doc from the snapshot', () => {
  const appKey = new Uint8Array(32).fill(1)
  let client: SiaClient

  beforeEach(() => {
    resetAllStores()
    localStorage.clear()
    written.length = 0
    held.length = 0
    client = createFakeApp().createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    }).client
  })

  /** Publish a snapshot holding these records, exactly as the snapshot loop does: a
   *  [{c,k,v}] array encrypted under the snapshot key, behind the durable locator. */
  async function publishSnapshot(records: { c: string; k: string }[]) {
    const entries = records.map((r) => ({
      ...r,
      v: b64(new TextEncoder().encode(`${r.c}/${r.k}`)),
    }))
    const ciphertext = await encryptForChannel(
      await deriveSnapshotKey(appKey),
      JSON.stringify(entries),
    )
    const uploaded = await client.uploadItem(
      new TextEncoder().encode(ciphertext),
    )
    await (await pkarrTransport()).publish(
      await deriveSettingsLocatorSeed(appKey),
      await chunkForTxt(SETTINGS_POINTER_PREFIX, uploaded.itemURL),
    )
    return uploaded.itemURL
  }

  it('restores every record a published snapshot holds', async () => {
    await publishSnapshot([
      { c: 'settings', k: 'self' },
      { c: 'endorse', k: 'like:subject-one' },
    ])

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'restored', records: 2 })
    expect(written).toEqual([
      { c: 'settings', k: 'self' },
      { c: 'endorse', k: 'like:subject-one' },
    ])
  })

  it('leaves a record the doc already holds', async () => {
    // A restore fills gaps. Both routes that put content in this doc before the restore
    // runs — a peer syncing in, the settings mirror writing from localStorage — carry
    // current state, and a write here would outrank them on timestamp alone.
    await publishSnapshot([
      { c: 'settings', k: 'self' },
      { c: 'endorse', k: 'like:subject-one' },
    ])
    held.push({ collection: 'settings', rkey: 'self' })

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'restored', records: 1 })
    expect(written).toEqual([{ c: 'endorse', k: 'like:subject-one' }])
  })

  it('leaves a withdrawn record out, and keeps remembering it', async () => {
    // The restore reads a snapshot taken BEFORE the withdrawal, so the record is still in
    // it. Putting it back would republish an endorsement its actor took back — and the
    // endorsement catch-up cannot undo that, being additive by design.
    await publishSnapshot([
      { c: 'endorse', k: 'like:subject-one' },
      { c: 'endorse', k: 'pin:subject-two' },
    ])
    rememberWithdrawn('endorse', 'like:subject-one')

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'restored', records: 1 })
    expect(written).toEqual([{ c: 'endorse', k: 'pin:subject-two' }])
    // Still remembered: this snapshot carries the record, and so would the next restore
    // to read it.
    expect(withdrawnAddresses()).toContain(
      addressOf('endorse', 'like:subject-one'),
    )
  })

  it('forgets a withdrawal the snapshot no longer carries', async () => {
    // A snapshot taken after the deletion landed. Nothing can put the record back now,
    // so the ledger has nothing left to protect and this read is what settles it.
    await publishSnapshot([{ c: 'endorse', k: 'pin:subject-two' }])
    rememberWithdrawn('endorse', 'like:subject-one')

    await hydrateFromSia(client, appKey)

    expect(withdrawnAddresses()).not.toContain(
      addressOf('endorse', 'like:subject-one'),
    )
  })

  it('answers none when the locator says this identity has published no snapshot', async () => {
    // Nothing published and no pointer held: a brand-new account. The locator answering
    // with nothing IS an answer, and the only one a loop may act on.
    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'none' })
    expect(written).toEqual([])
  })

  it('answers unknown when the snapshot a pointer names will not download', async () => {
    // The dangerous case, and the one a record count cannot tell from the case above:
    // a snapshot exists and this boot could not read it.
    localStorage.setItem(
      POINTER_KEY,
      JSON.stringify({ id: 'obj', url: 'sia://gone#encryption_key=ff' }),
    )

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(written).toEqual([])
  })

  it('falls back to the locator when the cached pointer names a reclaimed object', async () => {
    // A pointer outlives the object it names: the snapshot loop supersedes and prunes,
    // and a device that was away holds the URL of a generation already reclaimed. Asking
    // the locator only when NO pointer was held left that boot reading its own cache
    // against a corpse forever.
    await publishSnapshot([{ c: 'endorse', k: 'like:subject-one' }])
    localStorage.setItem(
      POINTER_KEY,
      JSON.stringify({ id: 'old', url: 'sia://reclaimed#encryption_key=ff' }),
    )

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'restored', records: 1 })
    expect(written).toEqual([{ c: 'endorse', k: 'like:subject-one' }])
  })

  it('leaves the pointer cache alone when the recovered snapshot will not read', async () => {
    // Caching what resolved before reading through it is what made one bad answer
    // permanent. The locator's answer earns the cache by working.
    const url = await publishSnapshot([{ c: 'settings', k: 'self' }])
    const original = JSON.stringify({
      id: 'old',
      url: 'sia://gone#encryption_key=ff',
    })
    localStorage.setItem(POINTER_KEY, original)
    vi.spyOn(client, 'downloadItem').mockRejectedValue(new Error('host down'))

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(localStorage.getItem(POINTER_KEY)).toBe(original)
    expect(url).toBeTruthy()
  })

  it('answers unknown when the locator itself will not answer', async () => {
    // No pointer and no reachable DHT. Distinct from the locator saying nothing, which
    // is what makes this retryable where `none` is settled.
    const transport = await pkarrTransport()
    vi.spyOn(transport, 'resolve').mockRejectedValueOnce(new Error('no relay'))

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(written).toEqual([])
  })
})
