// Module-mock factories for integration tests, intentionally lean to avoid
// circular imports. vi.mock factories run at module-resolution time and
// CANNOT transitively depend on the production code they're replacing.
//
// Test files use these as factories:
//
//   vi.mock('../lib/pkarr', async () =>
//     (await import('./fakeModules')).fakePkarrModule(),
//   )
//
// State (the current FakeWorld) lives here too, so the factories don't have
// to reach into a heavier module. setupFakeApp.ts pulls in production stores
// and is loaded lazily inside test bodies — never at mock-resolution time.
//
// Sia is NOT mocked here. It used to be, back when the client was a thin wrapper
// over a JS SDK that a factory could swap out. The implementation is Rust now, so
// there is no module to intercept — tests inject a `FakeSiaClient` at the
// `SiaClient` seam instead, which is where the app's dependency always was.

import {
  decrypt_for_channel,
  encrypt_for_channel,
  pkarr_chunk_txt,
  pkarr_rejoin_txt,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import type { FakeWorld } from './fakeSia'

let currentWorld: FakeWorld | null = null

export function setCurrentWorld(world: FakeWorld | null): void {
  currentWorld = world
}

export function getCurrentWorld(): FakeWorld {
  if (!currentWorld) {
    throw new Error(
      'No fake world configured. Call createFakeApp() in your test setup.',
    )
  }
  return currentWorld
}

// ---------------------------------------------------------------------------
// lib/pkarr replacement
// ---------------------------------------------------------------------------

// Deterministic identity from a 32-byte seed: hex of the seed is the "public
// key". Same seed (K-derived locator seed, or AppKey-derived did:dht seed) →
// same key, so channelLocator publish/resolve round-trip through world.pkarr.
type FakeTxt = { name: string; value: string }

function fakePublicKey(seed: Uint8Array): string {
  return Array.from(seed)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ---------------------------------------------------------------------------
// lib/channelLocatorNative replacement
// ---------------------------------------------------------------------------

// The channel round-trip is sequenced in Rust now (pin_channel), and BOTH of its halves
// went with it: it uses the Rust Sia session rather than the `SiaClient` tests inject,
// and it reaches pkarr itself. So neither of the old interception points can see it, and
// the fake has to stand in for the whole round-trip.
//
// It models the same thing the real one does, over the FakeWorld: a pointer keyed by the
// K-derived locator seed, and the manifest as an object in the author's scope.
//
// The seal is REAL — the same Rust AES the production path uses. Only Sia and pkarr are
// faked, because those are the network. Faking the format too would make the cached blob
// something no other code could open, and a test that checks the cache holds a genuinely
// sealed manifest would fail against a fake rather than against the code.
export function fakeChannelLocatorNativeModule() {
  const locatorKeyFor = (channelKey: Uint8Array) =>
    `loc-${fakePublicKey(channelKey)}`
  // A channel's tallies live under their OWN pkarr key, not the manifest's. Modelled
  // that way here too: sharing one key would let a test pass over a arrangement where
  // publishing counts overwrote the pointer to the posts.
  const talliesKeyFor = (channelKey: Uint8Array) =>
    `eng-${fakePublicKey(channelKey)}`

  return {
    publishLocator: async (channelKey: Uint8Array, manifestJson: string) => {
      const world = getCurrentWorld()
      const id = world.nextObjectID()
      const blob = encrypt_for_channel(channelKey, manifestJson)
      world.objects.set(id, {
        id,
        bytes: new TextEncoder().encode(blob),
        createdAt: new Date(),
      })
      const itemURL = `sia://fake/${id}#k=${id}`
      world.pkarr.set(locatorKeyFor(channelKey), [
        { name: '_c0', value: itemURL },
      ])
      return { locatorKey: locatorKeyFor(channelKey), objectId: id, itemURL }
    },

    resolveLocator: async (channelKey: Uint8Array) => {
      const world = getCurrentWorld()
      const records = world.pkarr.get(locatorKeyFor(channelKey))
      const itemURL = records?.find((r) => r.name === '_c0')?.value
      if (!itemURL) return null
      const id = itemURL.slice('sia://fake/'.length, itemURL.indexOf('#'))
      const bytes = world.objects.get(id)?.bytes
      // The pointer outliving its object is a real state (grace deletion), and the
      // caller treats it as a hard read failure rather than an absent channel.
      if (!bytes) throw new Error(`Object not found: ${itemURL}`)
      const blob = new TextDecoder().decode(bytes)
      return { manifestJson: decrypt_for_channel(channelKey, blob), blob }
    },

    republishPointer: async (channelKey: Uint8Array, itemURL: string) => {
      getCurrentWorld().pkarr.set(locatorKeyFor(channelKey), [
        { name: '_c0', value: itemURL },
      ])
    },

    openBlob: async (channelKey: Uint8Array, blob: string) =>
      decrypt_for_channel(channelKey, blob),

    resolveTalliesUrl: async (channelKey: Uint8Array) =>
      getCurrentWorld()
        .pkarr.get(talliesKeyFor(channelKey))
        ?.find((r) => r.name === '_e0')?.value ?? null,

    fetchTallies: async (channelKey: Uint8Array, itemURL: string) => {
      const world = getCurrentWorld()
      const id = itemURL.slice('sia://fake/'.length, itemURL.indexOf('#'))
      const bytes = world.objects.get(id)?.bytes
      if (!bytes) throw new Error(`Object not found: ${itemURL}`)
      return decrypt_for_channel(channelKey, new TextDecoder().decode(bytes))
    },
  }
}

/** Publish a channel's counts the way its author's Curator would, so a test can read
 *  them back through the path a screen uses. Sealed under K for real — only Sia and
 *  pkarr are faked. */
export function publishFakeTallies(
  channelKey: Uint8Array,
  tallies: Record<string, unknown>,
): void {
  const world = getCurrentWorld()
  const id = world.nextObjectID()
  world.objects.set(id, {
    id,
    bytes: new TextEncoder().encode(
      encrypt_for_channel(channelKey, JSON.stringify(tallies)),
    ),
    createdAt: new Date(),
  })
  world.pkarr.set(`eng-${fakePublicKey(channelKey)}`, [
    { name: '_e0', value: `sia://fake/${id}#k=${id}` },
  ])
}

export function fakePkarrModule() {
  // The REAL chunking, from Rust, not a copy. What's faked here is the network; the
  // record format is a contract with whatever published it, and a fake that split or
  // rejoined differently would let a test pass over data no production reader could read.
  const chunkForTxt = async (
    prefix: string,
    value: string,
  ): Promise<FakeTxt[]> => {
    await ensureWasm()
    return JSON.parse(pkarr_chunk_txt(prefix, value)) as FakeTxt[]
  }
  const reassembleTxt = async (
    records: FakeTxt[],
    prefix: string,
  ): Promise<string> => {
    await ensureWasm()
    return pkarr_rejoin_txt(JSON.stringify(records), prefix)
  }
  const identityFromSeed = async (seed: Uint8Array) => ({
    publicKey: fakePublicKey(seed),
  })
  return {
    chunkForTxt,
    reassembleTxt,
    identityFromSeed,
    // Publish is keyed by SEED now, not by a keypair object — the signing key never
    // leaves Rust, so the seed is what crosses every boundary.
    publishRecords: async (seed: Uint8Array, records: FakeTxt[]) => {
      getCurrentWorld().pkarr.set(fakePublicKey(seed), records)
    },
    resolveDidDht: async (didOrKey: string) => {
      const key = didOrKey.startsWith('did:dht:')
        ? didOrKey.slice('did:dht:'.length)
        : didOrKey
      return getCurrentWorld().pkarr.get(key) ?? []
    },
    deriveDidDht: async (appKeyBytes: Uint8Array) => {
      const { publicKey } = await identityFromSeed(appKeyBytes)
      return { did: `did:dht:${publicKey}`, publicKey }
    },
  }
}

// ---------------------------------------------------------------------------
// lib/docs replacement
// ---------------------------------------------------------------------------

// The doc engine is Rust (pin-core wasm / the native Curator), and opening it binds
// a real iroh endpoint — which no integration test should be doing. This stands in
// with a plain map, which is all the record layer is from the app's side: put, get,
// delete, list by collection prefix.
//
// Shared rather than re-declared per test file because publish state now rides the
// doc, so ANY test that publishes a channel goes through here. The store is module
// -level so a test can reset it between cases.
// Exported so a test can inspect or seed what the app wrote — the doc is a record
// store, and asserting on records is most of what these tests are for.
export const fakeDocStore = new Map<string, Uint8Array>()

export function fakeDocsModule() {
  return {
    openDocs: async () => 'fake-namespace',
    putRecord: async (collection: string, rkey: string, value: Uint8Array) => {
      fakeDocStore.set(`${collection}/${rkey}`, value)
    },
    getRecord: async (collection: string, rkey: string) =>
      fakeDocStore.get(`${collection}/${rkey}`),
    deleteRecord: async (collection: string, rkey: string) => {
      fakeDocStore.delete(`${collection}/${rkey}`)
    },
    listRecords: async (collection: string) =>
      [...fakeDocStore.keys()]
        .filter((k) => k.startsWith(`${collection}/`))
        .map((k) => k.slice(collection.length + 1)),
    // Splits — and skips what it can't split — the way `pin_derive::RecordKey` does
    // in both real engines, so the fake can't behave better than production.
    listAll: async () =>
      [...fakeDocStore.keys()].flatMap((k) => {
        const i = k.indexOf('/')
        if (i <= 0 || i === k.length - 1) return []
        return [{ collection: k.slice(0, i), rkey: k.slice(i + 1) }]
      }),
    subscribeDocChanges: () => () => {},
    startPullLoop: async () => {},
  }
}
