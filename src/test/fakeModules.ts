// Module-mock factories for integration tests, intentionally lean to avoid
// circular imports. vi.mock factories run at module-resolution time and
// CANNOT transitively depend on the production code they're replacing.
//
// Test files use these as factories:
//
//   vi.mock('@atproto/api', async () =>
//     (await import('./fakeModules')).fakeAtprotoApiModule(),
//   )
//
// State (the current FakeWorld) lives here too, so the factories don't have
// to reach into a heavier module. setupFakeApp.ts pulls in production stores
// and is loaded lazily inside test bodies — never at mock-resolution time.

import type { FakeWorld } from './fakeSdk'

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
// @atproto/api replacement
// ---------------------------------------------------------------------------

type AtprotoCallArgs = {
  repo: string
  collection: string
  rkey: string
  record?: unknown
  validate?: boolean
}

class FakeAtpAgent {
  constructor(_opts: { service: string }) {
    void _opts
  }

  readonly com = {
    atproto: {
      repo: {
        getRecord: async ({ repo, collection, rkey }: AtprotoCallArgs) => {
          const store = getCurrentWorld().records
          if (!store) throw atprotoNotFound()
          const rec = store.get(repo, collection, rkey)
          if (!rec) throw atprotoNotFound()
          return { data: rec }
        },
        listRecords: async ({ repo, collection }: AtprotoCallArgs) => {
          const store = getCurrentWorld().records
          if (!store) return { data: { records: [] } }
          const records = store
            .list(repo, collection)
            .map((r) => ({ uri: r.uri, cid: r.cid, value: r.value }))
          return { data: { records } }
        },
        describeRepo: async ({ repo }: { repo: string }) => {
          // repo may be a DID (registry key) or a handle (registry value).
          const handles = getCurrentWorld().handles
          let did = repo
          let handle = handles.get(repo)
          if (!handle) {
            for (const [d, h] of handles) {
              if (h === repo) {
                did = d
                handle = h
                break
              }
            }
          }
          if (!handle) throw atprotoNotFound()
          return { data: { did, handle, didDoc: {}, collections: [] } }
        },
        putRecord: async (_args: AtprotoCallArgs) => {
          throw new Error(
            'Unauthenticated AtpAgent cannot putRecord — use a FakeAgent for the authenticated path.',
          )
        },
        deleteRecord: async (_args: AtprotoCallArgs) => {
          throw new Error(
            'Unauthenticated AtpAgent cannot deleteRecord — use a FakeAgent for the authenticated path.',
          )
        },
      },
    },
  }
}

class FakeAgentStub {
  constructor() {
    throw new Error(
      'new Agent() is not used by Pin in test mode; FakeAgent is constructed via createFakeApp instead.',
    )
  }
}

function atprotoNotFound(): Error {
  const err: Error & { status?: number } = new Error('Record not found')
  err.status = 400
  return err
}

export function fakeAtprotoApiModule() {
  return {
    AtpAgent: FakeAtpAgent,
    Agent: FakeAgentStub,
  }
}

// ---------------------------------------------------------------------------
// @siafoundation/sia-storage replacement
// ---------------------------------------------------------------------------

class FakePinnedObjectStub {
  // No-op constructor. core/sia.ts uses `new PinnedObject()` as the first
  // arg to sdk.upload(); FakeSdk.upload ignores that argument and mints
  // its own object handle. The stub just has to construct without WASM.
  constructor() {}
  id(): string {
    return ''
  }
  size(): number {
    return 0
  }
  free(): void {}
  slabs(): unknown[] {
    return []
  }
  metadata(): Uint8Array {
    return new Uint8Array()
  }
}

class FakeSdkStub {
  private constructor() {}
}

class FakeBuilderStub {
  static new(): never {
    throw new Error('Builder not implemented in test mode')
  }
}

export function fakeSiaStorageModule() {
  return {
    Sdk: FakeSdkStub,
    PinnedObject: FakePinnedObjectStub,
    Builder: FakeBuilderStub,
    AppKey: class {},
    initSia: async () => {},
    generateRecoveryPhrase: () => 'fake recovery phrase',
    validateRecoveryPhrase: () => {},
  }
}
