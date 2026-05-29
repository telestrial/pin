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
// core/jetstream replacement
// ---------------------------------------------------------------------------

// Local copy of the channel lexicons so this module doesn't import core/atproto
// (which would re-trigger the @atproto/api mock factory mid-resolution).
const CHANNEL_COLLECTIONS = new Set([
  'dev.sia.pin.channel',
  'dev.sia.dispatch.channel',
])

type JetstreamListeners = {
  onCommit: (e: { did: string; rkey: string; operation: string }) => void
  onConnected?: () => void
  onDisconnected?: () => void
}

export function fakeJetstreamModule() {
  return {
    connectJetstream: (
      initialDids: string[],
      listeners: JetstreamListeners,
    ) => {
      const store = getCurrentWorld().records
      if (!store) return { close: () => {}, update: () => {} }

      let dids = new Set(initialDids)
      let unsubscribe: (() => void) | null = null
      let closed = false

      function attach() {
        if (closed || dids.size === 0 || unsubscribe) return
        listeners.onConnected?.()
        unsubscribe = store!.subscribe((e) => {
          if (!dids.has(e.did)) return
          if (!CHANNEL_COLLECTIONS.has(e.collection)) return
          listeners.onCommit({
            did: e.did,
            rkey: e.rkey,
            operation: e.operation,
          })
        })
      }

      function detach() {
        if (unsubscribe) {
          unsubscribe()
          unsubscribe = null
          listeners.onDisconnected?.()
        }
      }

      attach()

      return {
        close() {
          if (closed) return
          closed = true
          detach()
        },
        update(newDids: string[]) {
          if (closed) return
          dids = new Set(newDids)
          if (dids.size === 0) detach()
          else attach()
        },
      }
    },
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
