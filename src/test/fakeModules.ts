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
const TXT_MAX = 255

function fakePublicKey(seed: Uint8Array): string {
  return Array.from(seed)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function fakePkarrModule() {
  const chunkForTxt = (prefix: string, value: string): FakeTxt[] => {
    const out: FakeTxt[] = []
    for (let i = 0, n = 0; i < value.length; i += TXT_MAX, n++) {
      out.push({ name: `${prefix}${n}`, value: value.slice(i, i + TXT_MAX) })
    }
    return out
  }
  const reassembleTxt = (records: FakeTxt[], prefix: string): string => {
    const re = new RegExp(`^${prefix}(\\d+)(?:\\.|$)`)
    return records
      .map((r) => ({ m: r.name.match(re), value: r.value }))
      .filter((x): x is { m: RegExpMatchArray; value: string } => x.m !== null)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
      .map((x) => x.value)
      .join('')
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
