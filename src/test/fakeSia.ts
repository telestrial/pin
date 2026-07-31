// In-memory fake of the `SiaClient` seam, scoped per account.
//
// This fakes the surface the APP talks to, not the SDK underneath it. That is now
// the only injection point that can work: the real implementation is Rust reached
// through wasm, so there is no JS module left to intercept — but `SiaClient` was
// always the seam the app depends on, and the store already holds one, so tests
// inject there instead of mocking a module out from under production code.
//
// Shared state lives on a FakeWorld. Pass the same world to two clients to model two
// accounts, and cross-account flows work the way real Sia does: a share URL is
// identity-agnostic, so B can read A's URL, and pinning it mirrors the bytes into B's
// own scope. That property is what the custody tests are actually about.

import { computeContentHash } from '../core/contentHash'
import type { AccountSnapshot } from '../core/pin'
import type { UploadedItem } from '../core/sia'
import type { PinnedObjectInfo, SiaClient } from '../core/siaClient'

const DEFAULT_MAX_PINNED = 5 * 1024 * 1024 * 1024 // 5 GiB

type FakeObjectRecord = {
  id: string
  bytes: Uint8Array
  createdAt: Date
}

export class FakeWorld {
  // Sia universe — every uploaded object across every account.
  readonly objects = new Map<string, FakeObjectRecord>()
  // accountID → set of pinned object IDs. An "account" is whatever string a test
  // uses to identify an isolated AppKey scope.
  readonly scopes = new Map<string, Set<string>>()
  // Per-account storage cap; a default applies if none is set.
  readonly accountMax = new Map<string, number>()
  // Monotonic object ID counter — deterministic across a test run.
  private _objectCounter = 0
  // DID → handle. Test bookkeeping for building SubscriptionRefs.
  readonly handles = new Map<string, string>()
  // pkarr universe — publicKey → its published TXT records. Backs the fake
  // lib/pkarr so channel-locator publish/resolve round-trips in memory.
  readonly pkarr = new Map<string, { name: string; value: string }[]>()

  nextObjectID(): string {
    this._objectCounter++
    return this._objectCounter.toString(16).padStart(16, '0')
  }

  scopeOf(accountID: string): Set<string> {
    let scope = this.scopes.get(accountID)
    if (!scope) {
      scope = new Set()
      this.scopes.set(accountID, scope)
    }
    return scope
  }

  bytesOf(objectID: string): Uint8Array | undefined {
    return this.objects.get(objectID)?.bytes
  }
}

export function createFakeWorld(): FakeWorld {
  return new FakeWorld()
}

/** The share URL shape, mirroring real Sia's key-in-the-fragment form. The fake
 *  doesn't encrypt, so the fragment just carries the id — but the SHAPE matters,
 *  because parsing it is what the app does. */
function shareURLFor(objectID: string): string {
  return `sia://fake/${objectID}#k=${objectID}`
}

function objectIDFromShareURL(url: string): string {
  const match = url.match(/^sia:\/\/fake\/([^#]+)#/)
  if (!match) throw new Error(`Bad share URL: ${url}`)
  return match[1]
}

export class FakeSiaClient implements SiaClient {
  readonly accountID: string
  private readonly world: FakeWorld

  constructor(accountID: string, world: FakeWorld) {
    this.accountID = accountID
    this.world = world
  }

  // -- byte ops --------------------------------------------------------------

  async uploadItem(
    bytes: Uint8Array,
    onShard?: () => void,
  ): Promise<UploadedItem> {
    const uploaded = await this.store(bytes)
    // One shard per object is enough to prove the callback is wired; the real
    // count depends on erasure-coding parameters the fake doesn't model.
    onShard?.()
    return uploaded
  }

  /** Bin-packing is not modelled — each input still becomes its own object with its
   *  own URL, which is the part callers depend on. What packing changes is slab
   *  accounting, and the fake gives every object its own slab regardless. */
  async uploadItemsPacked(
    items: Uint8Array[],
    onShard?: () => void,
  ): Promise<UploadedItem[]> {
    const out: UploadedItem[] = []
    for (const bytes of items) {
      out.push(await this.store(bytes))
      onShard?.()
    }
    return out
  }

  async downloadItem(url: string): Promise<Uint8Array> {
    const record = this.world.objects.get(objectIDFromShareURL(url))
    if (!record) throw new Error(`Object not found: ${url}`)
    return record.bytes
  }

  // -- pin / custody ---------------------------------------------------------

  /** Mirror a share URL's bytes into this account's scope. Works on any account's
   *  URL — that identity-agnosticism is the property custody rests on. */
  async pinFromShareURL(url: string): Promise<{ objectID: string }> {
    const objectID = objectIDFromShareURL(url)
    if (!this.world.objects.has(objectID)) {
      throw new Error(`Object not found: ${objectID}`)
    }
    this.world.scopeOf(this.accountID).add(objectID)
    return { objectID }
  }

  async resolveObjectID(url: string): Promise<string> {
    const objectID = objectIDFromShareURL(url)
    if (!this.world.objects.has(objectID)) {
      throw new Error(`Object not found: ${objectID}`)
    }
    return objectID
  }

  async deleteObject(id: string): Promise<void> {
    this.world.scopeOf(this.accountID).delete(id)
    // Bytes survive while any account still pins them; they leave the universe only
    // when the last pinner lets go. Real Sia gives the indexer a beat before
    // collecting — the fake is eager, which makes the assertion deterministic.
    let stillPinned = false
    for (const scope of this.world.scopes.values()) {
      if (scope.has(id)) {
        stillPinned = true
        break
      }
    }
    if (!stillPinned) this.world.objects.delete(id)
  }

  async pruneSlabs(): Promise<void> {}

  // -- accounting ------------------------------------------------------------

  async accountSnapshot(): Promise<AccountSnapshot> {
    let pinnedData = 0
    for (const id of this.world.scopeOf(this.accountID)) {
      pinnedData += this.world.objects.get(id)?.bytes.length ?? 0
    }
    const maxPinnedData =
      this.world.accountMax.get(this.accountID) ?? DEFAULT_MAX_PINNED
    return {
      pinnedData,
      // 3x redundancy — the real default of 10 data + 20 parity shards.
      pinnedSize: pinnedData * 3,
      // The fake gives each object a single slab covering all its bytes, so the
      // sum-of-slab-lengths the real walk computes equals the byte total here.
      rawContentBytes: pinnedData,
      maxPinnedData,
      remainingStorage: Math.max(0, maxPinnedData - pinnedData),
      fetchedAt: new Date().toISOString(),
    }
  }

  async listPinnedObjects(): Promise<PinnedObjectInfo[]> {
    const out: PinnedObjectInfo[] = []
    for (const id of this.world.scopeOf(this.accountID)) {
      const record = this.world.objects.get(id)
      if (record) out.push(describe(record))
    }
    return out
  }

  /** Scoped to this account, like the real lookup: an object you don't pin is not
   *  yours to inspect. `null` rather than a throw, since repack asks about
   *  references that may already be gone. */
  async getObjectSlabs(objectID: string): Promise<PinnedObjectInfo | null> {
    if (!this.world.scopeOf(this.accountID).has(objectID)) return null
    const record = this.world.objects.get(objectID)
    return record ? describe(record) : null
  }

  // -- identity --------------------------------------------------------------

  appKeyPublicKey(): string {
    return `appkey-${this.accountID}`
  }

  // -- internals -------------------------------------------------------------

  /** Register bytes in the universe and pin them under this account. Upload and
   *  packed-upload both take custody, matching the client contract — the caller
   *  never pins separately. */
  private async store(bytes: Uint8Array): Promise<UploadedItem> {
    const id = this.world.nextObjectID()
    const record: FakeObjectRecord = { id, bytes, createdAt: new Date() }
    this.world.objects.set(id, record)
    this.world.scopeOf(this.accountID).add(id)
    return {
      id,
      itemURL: shareURLFor(id),
      byteSize: bytes.length,
      // The real hash, so cache keys and drift detection behave as they do live.
      contentHash: await computeContentHash(bytes),
    }
  }
}

/** One object as the plain descriptor its consumers read. A single slab whose
 *  `length` is the whole object is enough for the sum-the-lengths accounting the
 *  storage meter and repack scope perform. */
function describe(record: FakeObjectRecord): PinnedObjectInfo {
  return {
    id: record.id,
    createdAt: record.createdAt.toISOString(),
    // Structurally what consumers read; the SDK's own `Slab` carries sector detail
    // no test asserts on, so the cast keeps the fake from restating it.
    slabs: [
      {
        encryptionKey: `slab-${record.id}`,
        offset: 0,
        length: record.bytes.length,
        sectors: [],
      },
    ] as unknown as PinnedObjectInfo['slabs'],
  }
}
