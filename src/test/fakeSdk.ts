// In-memory fake of @siafoundation/sia-storage's Sdk surface, scoped per
// account. Cast to `Sdk` at the test boundary via `as unknown as Sdk`.
//
// Shared state lives on a FakeWorld instance — pass the same world to two
// FakeSdks to model two accounts, and cross-account flows
// (sharedObject from B's URL called on A's sdk → mirror via pinObject)
// work the way the real SDK does: share URLs are identity-agnostic.

const SLAB_BYTES = 40 * 1024 * 1024 // ~40 MiB, real Sia slab capacity
const DEFAULT_MAX_PINNED = 5 * 1024 * 1024 * 1024 // 5 GiB

// Forward-declared placeholder so FakeWorld can carry an ATProto record store
// in a later phase. fakeAgent.ts will provide the real shape.
export type FakeRecordStoreLike = unknown

export class FakePinnedObject {
  private readonly _id: string
  private readonly _bytes: Uint8Array
  private readonly _createdAt: Date

  constructor(id: string, bytes: Uint8Array, createdAt: Date) {
    this._id = id
    this._bytes = bytes
    this._createdAt = createdAt
  }

  id(): string {
    return this._id
  }

  size(): number {
    return this._bytes.length
  }

  createdAt(): Date {
    return this._createdAt
  }

  encodedSize(): number {
    // 3× redundancy is the real SDK's default (10 data + 20 parity shards).
    return Math.max(1, Math.ceil(this._bytes.length / SLAB_BYTES)) * SLAB_BYTES * 3
  }

  // Methods we don't model yet — call sites tolerate empty results.
  slabs(): unknown[] {
    return []
  }

  metadata(): Uint8Array {
    return new Uint8Array()
  }

  free(): void {}

  // Internal accessor for the fake stack to peek bytes without going
  // through download(). Not on the real Sdk surface.
  _bytesRef(): Uint8Array {
    return this._bytes
  }
}

type FakeObjectRecord = {
  id: string
  bytes: Uint8Array
  createdAt: Date
}

export class FakeWorld {
  // Sia universe — every uploaded object across every account.
  readonly objects = new Map<string, FakeObjectRecord>()
  // accountID → set of pinned object IDs. An "account" is whatever string
  // a test uses to identify an isolated AppKey scope.
  readonly scopes = new Map<string, Set<string>>()
  // Per-account storage cap; default applied if a scope writes without one set.
  readonly accountMax = new Map<string, number>()
  // Monotonic object ID counter — deterministic across a test run.
  private _objectCounter = 0
  // ATProto universe — populated when an agent wraps this world.
  // Tests don't need this directly; the agent reads/writes it.
  records?: FakeRecordStoreLike

  nextObjectID(): string {
    this._objectCounter++
    return this._objectCounter.toString(16).padStart(16, '0')
  }

  // Test helpers.
  scopeOf(accountID: string): Set<string> {
    let s = this.scopes.get(accountID)
    if (!s) {
      s = new Set()
      this.scopes.set(accountID, s)
    }
    return s
  }

  bytesOf(objectID: string): Uint8Array | undefined {
    return this.objects.get(objectID)?.bytes
  }
}

export function createFakeWorld(): FakeWorld {
  return new FakeWorld()
}

type AccountSnapshot = {
  pinnedData: number
  pinnedSize: number
  maxPinnedData: number
  remainingStorage: number
}

export class FakeSdk {
  readonly accountID: string
  private readonly world: FakeWorld

  constructor(accountID: string, world: FakeWorld) {
    this.accountID = accountID
    this.world = world
  }

  async upload(
    _existing: unknown,
    source: ReadableStream<Uint8Array>,
  ): Promise<FakePinnedObject> {
    const bytes = await readStream(source)
    const id = this.world.nextObjectID()
    const obj = new FakePinnedObject(id, bytes, new Date())
    this.world.objects.set(id, { id, bytes, createdAt: obj.createdAt() })
    this.world.scopeOf(this.accountID).add(id)
    return obj
  }

  uploadPacked(): FakePackedUpload {
    return new FakePackedUpload(this.world, this.accountID)
  }

  async pinObject(obj: FakePinnedObject): Promise<void> {
    if (!this.world.objects.has(obj.id())) {
      throw new Error(`Object not found: ${obj.id()}`)
    }
    this.world.scopeOf(this.accountID).add(obj.id())
  }

  shareObject(obj: FakePinnedObject, _validUntil: Date): string {
    // The fragment "k" is the per-object encryption key in real Sia URLs;
    // we just stash the object ID there since the fake doesn't actually
    // encrypt bytes.
    return `sia://fake/${obj.id()}#k=${obj.id()}`
  }

  async sharedObject(url: string): Promise<FakePinnedObject> {
    const m = url.match(/^sia:\/\/fake\/([^#]+)#/)
    if (!m) throw new Error(`Bad share URL: ${url}`)
    const id = m[1]
    const rec = this.world.objects.get(id)
    if (!rec) throw new Error(`Object not found: ${id}`)
    return new FakePinnedObject(rec.id, rec.bytes, rec.createdAt)
  }

  download(obj: FakePinnedObject): ReadableStream<Uint8Array> {
    const rec = this.world.objects.get(obj.id())
    if (!rec) throw new Error(`Object not found: ${obj.id()}`)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(rec.bytes)
        controller.close()
      },
    })
  }

  async deleteObject(id: string): Promise<void> {
    this.world.scopeOf(this.accountID).delete(id)
    // If no other account holds this, drop it from the universe. Real Sia
    // gives the indexer a beat before garbage collection; the fake is eager.
    let stillReferenced = false
    for (const set of this.world.scopes.values()) {
      if (set.has(id)) {
        stillReferenced = true
        break
      }
    }
    if (!stillReferenced) this.world.objects.delete(id)
  }

  async account(): Promise<AccountSnapshot> {
    const scope = this.world.scopeOf(this.accountID)
    let pinnedData = 0
    for (const id of scope) {
      const rec = this.world.objects.get(id)
      if (rec) pinnedData += rec.bytes.length
    }
    const max = this.world.accountMax.get(this.accountID) ?? DEFAULT_MAX_PINNED
    return {
      pinnedData,
      pinnedSize: pinnedData * 3,
      maxPinnedData: max,
      remainingStorage: Math.max(0, max - pinnedData),
    }
  }

  appKey(): { publicKey(): string } {
    return { publicKey: () => `appkey-${this.accountID}` }
  }

  // Stubs — implement on demand as later phases need them. Documented so
  // the grow-on-demand intent is visible at call sites.
  async pruneSlabs(): Promise<void> {}

  async objectEvents(): Promise<unknown[]> {
    return []
  }

  async object(): Promise<FakePinnedObject> {
    throw new Error('FakeSdk.object: not implemented yet (grow on demand)')
  }

  async updateObjectMetadata(): Promise<void> {
    throw new Error(
      'FakeSdk.updateObjectMetadata: not implemented yet (grow on demand)',
    )
  }
}

export class FakePackedUpload {
  private streams: ReadableStream<Uint8Array>[] = []
  private readonly world: FakeWorld

  constructor(world: FakeWorld, _accountID: string) {
    this.world = world
    // accountID intentionally unused — packed.finalize() returns handles
    // and leaves pinning to the caller, matching the real SDK contract
    // (sia.ts:uploadItemsPacked calls pinObject after finalize).
    void _accountID
  }

  async add(source: ReadableStream<Uint8Array>): Promise<void> {
    this.streams.push(source)
  }

  async finalize(): Promise<FakePinnedObject[]> {
    const out: FakePinnedObject[] = []
    for (const s of this.streams) {
      const bytes = await readStream(s)
      const id = this.world.nextObjectID()
      const obj = new FakePinnedObject(id, bytes, new Date())
      this.world.objects.set(id, { id, bytes, createdAt: obj.createdAt() })
      // Real packed upload pins implicitly via the indexer slab; caller still
      // calls pinObject on each handle (sia.ts:uploadItemsPacked), so the
      // scope add happens then. We don't pre-pin here — matches real flow.
      out.push(obj)
    }
    return out
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
