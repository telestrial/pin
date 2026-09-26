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
import type { PinnedObjectInfo, SiaClient } from '../core/siaClient'
import { hydrateFromSia } from '../lib/docsMirror'
import { chunkForTxt } from '../lib/pkarr'
import { pkarrTransport } from '../lib/pkarrTransport'
import {
  addressOf,
  rememberWithdrawn,
  withdrawnAddresses,
} from '../lib/withdrawn'
import type { FakeWorld } from './fakeSia'
import { snapshotTag } from './fakeSia'
import { createFakeApp, resetAllStores } from './setupFakeApp'
import { fakeShareURL } from './shareURL'

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
  const ALICE = 'did:plc:alice'
  let client: SiaClient
  let world: FakeWorld

  beforeEach(() => {
    resetAllStores()
    localStorage.clear()
    written.length = 0
    held.length = 0
    const app = createFakeApp()
    world = app.world
    client = app.createAccount({ did: ALICE, handle: 'alice.test' }).client
  })

  /** Put a snapshot in this identity's scope, exactly as the snapshot loop leaves one:
   *  a [{c,k,v}] array encrypted under the snapshot key, in a TAGGED object.
   *
   *  Tagged because that is what the Curator uploads, and an untagged object is what
   *  every other upload in the account produces — so a fake snapshot that skipped the
   *  tag would be invisible to the rung under test while looking like a snapshot to the
   *  test that planted it. `createdAt` is explicit, since which of two generations is
   *  current is the thing being decided. */
  async function holdSnapshot(
    records: { c: string; k: string }[],
    at = new Date('2026-09-26T12:00:00Z'),
  ) {
    const entries = records.map((r) => ({
      ...r,
      v: b64(new TextEncoder().encode(`${r.c}/${r.k}`)),
    }))
    const ciphertext = await encryptForChannel(
      await deriveSnapshotKey(appKey),
      JSON.stringify(entries),
    )
    const id = world.putTagged(
      ALICE,
      new TextEncoder().encode(ciphertext),
      snapshotTag(`fp-${at.toISOString()}`),
      at,
    )
    return { id, url: fakeShareURL(id) }
  }

  /** The same, with the durable locator published at it — the full state a snapshot
   *  pass leaves behind. */
  async function publishSnapshot(
    records: { c: string; k: string }[],
    at?: Date,
  ) {
    const object = await holdSnapshot(records, at)
    await (await pkarrTransport()).publish(
      await deriveSettingsLocatorSeed(appKey),
      await chunkForTxt(SETTINGS_POINTER_PREFIX, object.url),
    )
    return object
  }

  /** Put one object in this identity's scope, so an unreadable snapshot is a snapshot
   *  that could not be read rather than one that cannot exist. */
  async function holdSomething() {
    await client.uploadItem(new TextEncoder().encode('held'))
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

  it('answers unknown when a snapshot is held and every read of it fails', async () => {
    // The dangerous case, and the one a record count cannot tell from the case above:
    // a snapshot exists and this boot could not read it. The SCOPE is what says it
    // exists — the object is tagged and sitting right there — so a read that fails is a
    // host or a network, and publishing over it is the wipe.
    //
    // Both reads are stopped, because in production one outage takes both: the pointer
    // rung and the scope rung differ in how they name the object, never in what has to
    // be reachable to fetch it.
    await publishSnapshot([{ c: 'settings', k: 'self' }])
    vi.spyOn(client, 'downloadItem').mockRejectedValue(new Error('host down'))
    vi.spyOn(client, 'downloadObjectByID').mockRejectedValue(
      new Error('host down'),
    )

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(written).toEqual([])
  })

  it('restores from the scope when no pointer names the snapshot', async () => {
    // The rung that does not expire, doing the job the others cannot. No pointer is
    // cached and nothing is published on the DHT — the state every account reaches two
    // hours after its last instance stops republishing — and the object is still in the
    // identity's own scope, saying what it is.
    await holdSnapshot([{ c: 'endorse', k: 'like:subject-one' }])

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'restored', records: 1 })
    expect(written).toEqual([{ c: 'endorse', k: 'like:subject-one' }])
  })

  it('restores the newest snapshot when the scope holds several', async () => {
    // THE CLOBBERING CASE. A superseded generation restored over current state would be
    // mirrored straight back out by the snapshot loop, so which one is newest is not a
    // preference. Ordering is by the indexer's `createdAt`; a fingerprint cannot do it,
    // since it says which doc state an object holds and never which of two came later.
    //
    // Planted out of order, so neither "the first one" nor "the last one" passes.
    await holdSnapshot([{ c: 'settings', k: 'oldest' }], new Date('2026-07-01'))
    await holdSnapshot([{ c: 'settings', k: 'newest' }], new Date('2026-09-26'))
    await holdSnapshot([{ c: 'settings', k: 'middle' }], new Date('2026-08-15'))

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'restored', records: 1 })
    expect(written).toEqual([{ c: 'settings', k: 'newest' }])
  })

  it('answers unknown when a held snapshot cannot be placed in time', async () => {
    // Tagged objects the indexer gave no readable stamp. It cannot actually produce
    // this — `created_at` is its own — but picking one anyway is the clobbering case
    // decided by a coin toss, so the read stays retryable instead.
    //
    // Both objects are REAL and readable, and the listing is doctored only in the
    // stamps. A first version planted ids naming nothing, so taking one failed the
    // download and reported `unknown` anyway — the assertion held with the guard
    // deleted, which is a test passing for the reason it exists to rule out.
    const older = await holdSnapshot(
      [{ c: 'settings', k: 'older' }],
      new Date('2026-07-01'),
    )
    const newer = await holdSnapshot(
      [{ c: 'settings', k: 'newer' }],
      new Date('2026-09-26'),
    )
    vi.spyOn(client, 'listPinnedObjects').mockResolvedValue([
      {
        id: older.id,
        createdAt: 'not a date',
        metadata: snapshotTag('fp-older'),
        slabs: [],
      },
      {
        id: newer.id,
        createdAt: '',
        metadata: snapshotTag('fp-newer'),
        slabs: [],
      },
    ] as PinnedObjectInfo[])

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
    vi.spyOn(client, 'downloadObjectByID').mockRejectedValue(
      new Error('host down'),
    )

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(localStorage.getItem(POINTER_KEY)).toBe(original)
    expect(url).toBeTruthy()
  })

  it('answers none when the DHT will not answer and the scope holds no snapshot', async () => {
    // A COMPLETED SCOPE WALK OUTRANKS AN UNREACHABLE DHT, and this is where the scope
    // rung changes the answer rather than merely finding one sooner. The snapshot
    // object would be in this identity's own scope, so a walk that answered and turned
    // up nothing tagged has established there is none — whatever the relays are doing.
    //
    // This was an `unknown` with nowhere to go: the locator was the only thing that
    // could speak for the snapshot, and the loops that republish the locator are held
    // on this very read.
    await holdSomething()
    const transport = await pkarrTransport()
    vi.spyOn(transport, 'resolve').mockRejectedValueOnce(new Error('no relay'))

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'none' })
    expect(written).toEqual([])
  })

  it('restores through an unreachable DHT when the scope holds the snapshot', async () => {
    // The same unreachable relay over an account that HAS published. The locator cannot
    // be asked and does not need to be.
    await holdSnapshot([{ c: 'settings', k: 'self' }])
    const transport = await pkarrTransport()
    vi.spyOn(transport, 'resolve').mockRejectedValue(new Error('no relay'))

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'restored', records: 1 })
  })

  it('answers none when the scope that would hold the snapshot holds nothing', async () => {
    // A reclaimed account: the objects are gone, and the pointer and the locator both
    // name one of them. Read as unknown this is a lockout — the loops that would publish
    // a fresh snapshot are held until the restore settles, and the only thing that could
    // settle it is a snapshot none of them may write. The scope is what settles it
    // instead, positively: the snapshot lives there, so nothing there is no snapshot.
    localStorage.setItem(
      POINTER_KEY,
      JSON.stringify({ id: 'obj', url: 'sia://gone#encryption_key=ff' }),
    )

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'none' })
    expect(written).toEqual([])
  })

  it('answers none when the snapshot the locator names has been reclaimed', async () => {
    // THE LOCKOUT. A reset takes the snapshot object along with everything else and the
    // locator outlives it, so the pointer resolves and the object behind it does not.
    // Any activity afterwards refills the scope, and the scope question can only ask
    // whether the scope holds NOTHING — so it says "not empty", the snapshot stays
    // unreadable, and the three loops held on this never release. The one thing that
    // could end that is a fresh snapshot, and the snapshot loop is one of the three.
    const snapshot = await publishSnapshot([{ c: 'settings', k: 'self' }])
    await client.deleteObject(snapshot.id)
    await holdSomething()

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'none' })
    expect(written).toEqual([])
  })

  it('declines an empty listing as proof that the snapshot is gone', async () => {
    // An empty list contains no id, so it would answer "gone" for any snapshot ever
    // published — which is the served-empty hiccup the scope question cross-checks
    // against a byte total. Emptiness is that question's to settle, not this one's, and
    // here the bytes say somebody has been here, so neither may.
    const snapshot = await publishSnapshot([{ c: 'settings', k: 'self' }])
    await client.deleteObject(snapshot.id)
    vi.spyOn(client, 'listPinnedObjects').mockResolvedValue([])
    vi.spyOn(client, 'accountSnapshot').mockResolvedValue({
      pinnedData: 0,
      pinnedSize: 0,
      rawContentBytes: 4096,
      maxPinnedData: 0,
      remainingStorage: 0,
      fetchedAt: '2026-09-21T00:00:00.000Z',
    })

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(written).toEqual([])
  })

  it('stays unknown when the scope will not say whether the snapshot is gone', async () => {
    // Asking is itself a read, so it inherits the rule: an indexer that did not answer
    // has not said the object is absent. Only a true releases the loops, so every way
    // of not knowing has to come back false.
    const snapshot = await publishSnapshot([{ c: 'settings', k: 'self' }])
    await client.deleteObject(snapshot.id)
    await holdSomething()
    vi.spyOn(client, 'listPinnedObjects').mockRejectedValue(
      new Error('indexer down'),
    )

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(written).toEqual([])
  })

  it('finds the live snapshot when a cached pointer names a reclaimed one', async () => {
    // A cached pointer can name a generation the snapshot loop superseded and pruned,
    // so that object IS gone — and it says nothing about the current snapshot, which is
    // alive. Concluding "nothing to restore" from the dead one and publishing an empty
    // doc over the live one is the wipe, through a new door.
    //
    // The scope closes that door by construction: a stale pointer is one way of naming
    // an object, and the one thing this rung does not do is take its word for what the
    // account holds.
    const superseded = await client.uploadItem(
      new TextEncoder().encode('an older snapshot'),
    )
    await client.deleteObject(superseded.id)
    await publishSnapshot([{ c: 'settings', k: 'self' }])
    localStorage.setItem(
      POINTER_KEY,
      JSON.stringify({ id: superseded.id, url: superseded.itemURL }),
    )
    vi.spyOn(client, 'downloadItem').mockRejectedValue(new Error('host down'))

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'restored', records: 1 })
    expect(written).toEqual([{ c: 'settings', k: 'self' }])
  })

  it('stays unknown when the scope itself will not enumerate', async () => {
    // The direction that matters. A scope that did not answer is not an empty scope, and
    // reading it as one would turn every outage into a published withdrawal of
    // everything — the orphan sweep's shape, reached through this door.
    await holdSomething()
    localStorage.setItem(
      POINTER_KEY,
      JSON.stringify({ id: 'obj', url: 'sia://gone#encryption_key=ff' }),
    )
    vi.spyOn(client, 'listPinnedObjects').mockRejectedValue(
      new Error('indexer down'),
    )

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(written).toEqual([])
  })

  it('is not misled by a locator that answers with nothing', async () => {
    // A locator answering with nothing and an identity that published nothing are the
    // same bytes: a relay rate-limiting the tab returns no packet and no error, and a
    // browser reads the relays while a desktop publishes to Mainline, so a locator that
    // exists can be invisible to whoever is asking. Read as `none` that releases the
    // loops to publish an empty doc over a full one — the cross-device wipe.
    //
    // The scope is what makes the relay's silence harmless: the snapshot is an object
    // in this identity's own scope, so it is found whatever the DHT says.
    await holdSnapshot([{ c: 'settings', k: 'self' }])
    await holdSomething()

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome).toEqual({ kind: 'restored', records: 1 })
  })

  it('stays unknown when the listing throws and the byte total says zero', async () => {
    // A HALF-ANSWERING INDEXER, and the one case the byte total cannot cover. Every
    // other way the walk fails is caught downstream, because an account with objects
    // reports bytes and so declines to call itself empty — which is why turning the
    // throw into an empty list failed no test until this one existed. Here the two
    // reads disagree the other way: the listing did not answer at all, and the total
    // says zero, so believing it releases the loops over an account that may be full.
    vi.spyOn(client, 'listPinnedObjects').mockRejectedValue(
      new Error('indexer down'),
    )
    vi.spyOn(client, 'accountSnapshot').mockResolvedValue({
      pinnedData: 0,
      pinnedSize: 0,
      rawContentBytes: 0,
      maxPinnedData: 0,
      remainingStorage: 0,
      fetchedAt: '2026-09-26T00:00:00.000Z',
    })

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(written).toEqual([])
  })

  it('stays unknown when the listing is empty but the byte total is not', async () => {
    // The two reads disagreeing is exactly the hiccup the second one is there for, and
    // the safe reading of a disagreement is the one that publishes nothing.
    localStorage.setItem(
      POINTER_KEY,
      JSON.stringify({ id: 'obj', url: 'sia://gone#encryption_key=ff' }),
    )
    vi.spyOn(client, 'listPinnedObjects').mockResolvedValue([])
    vi.spyOn(client, 'accountSnapshot').mockResolvedValue({
      pinnedData: 0,
      pinnedSize: 0,
      rawContentBytes: 4096,
      maxPinnedData: 0,
      remainingStorage: 0,
      fetchedAt: '2026-09-21T00:00:00.000Z',
    })

    const outcome = await hydrateFromSia(client, appKey)

    expect(outcome.kind).toBe('unknown')
    expect(written).toEqual([])
  })
})
