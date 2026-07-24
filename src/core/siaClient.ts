// SiaClient — the coarse Sia operation surface the app talks to, so the
// underlying implementation can be swapped without touching call sites.
//
// WHY THIS EXISTS: today Sia runs as the WASM SDK inside the page. On desktop
// (Tauri/WebView2) that WASM `download` path fails ("readable byte streams not
// supported"), and the documented direction is to run Sia natively in the Rust
// backend. This interface is the seam: web keeps the WASM SDK
// (`makeWasmSiaClient`), desktop gets a Tauri-IPC implementation later — both
// satisfy `SiaClient`, so nothing downstream changes.
//
// DESIGN RULE — coarse ops, no live handles cross the boundary. A live
// `PinnedObject` can't marshal over IPC, so every method takes/returns PLAIN
// serializable data (URLs, ids, byte arrays, descriptors). Object handles stay
// inside a single method on one side. The metering/repack/reset walks used to
// hold a handle only to read `.slabs()`/`.createdAt()`/`.id()` — all plain data —
// so they collapse to `listPinnedObjects()` / `getObjectSlabs()` returning
// descriptors. That's what lets the whole surface be handle-free.
//
// (Progress callbacks — `onShard` — are the one thing that can't marshal
// directly; the WASM client calls them inline, a future Tauri client will drive
// them via Tauri events. Kept in the signature; the seam absorbs it.)

import type { Sdk, Slab } from '@siafoundation/sia-storage'
import { type AccountSnapshot, fetchAccountSnapshot, pinItemBytes } from './pin'
import {
  downloadItem,
  type UploadedItem,
  uploadItem,
  uploadItemsPacked,
} from './sia'

// A pinned object reduced to the plain data its consumers actually read —
// serializable, so it survives an IPC round-trip. `slabs` is the SDK's own slab
// shape (a data type; the type-only import is erased at build, no WASM at runtime
// for a non-WASM implementation).
export type PinnedObjectInfo = {
  id: string
  // ISO 8601 — the handle's Date, serialized.
  createdAt: string
  slabs: Slab[]
}

export interface SiaClient {
  // --- byte ops -----------------------------------------------------------
  uploadItem(bytes: Uint8Array, onShard?: () => void): Promise<UploadedItem>
  uploadItemsPacked(
    items: Uint8Array[],
    onShard?: () => void,
  ): Promise<UploadedItem[]>
  downloadItem(url: string): Promise<Uint8Array>

  // --- pin / custody ------------------------------------------------------
  // sharedObject(url) + pinObject — mirror a share URL's bytes into this scope.
  pinFromShareURL(url: string): Promise<{ objectID: string }>
  // sharedObject(url).id() — resolve a share URL to its object id (no pin).
  resolveObjectID(url: string): Promise<string>
  deleteObject(id: string): Promise<void>
  pruneSlabs(): Promise<void>

  // --- accounting / enumeration (plain descriptors, no live handles) ------
  accountSnapshot(): Promise<AccountSnapshot>
  // The objectEvents walk, deduped to the current (non-deleted) set. Powers the
  // storage meter, the repack scope, full-reset enumeration, the slab inspector.
  listPinnedObjects(): Promise<PinnedObjectInfo[]>
  // One object's slabs by id (repack's per-ref lookup). null if not found.
  getObjectSlabs(objectID: string): Promise<PinnedObjectInfo | null>

  // --- identity -----------------------------------------------------------
  appKeyPublicKey(): string
}

const EVENTS_PAGE_LIMIT = 200
// Defensive cap — 200 × 50 = 10000 events covers any plausible scope.
const EVENTS_MAX_PAGES = 50

// Walk objectEvents, keep the latest event per id, drop deleted ones, return
// plain descriptors. This is the single home for the walk the metering / repack /
// reset / slab-inspector sites all need.
async function walkPinnedObjects(sdk: Sdk): Promise<PinnedObjectInfo[]> {
  // biome-ignore lint/suspicious/noExplicitAny: SDK ObjectEvent / cursor types aren't exported
  const latestByID = new Map<string, any>()
  // biome-ignore lint/suspicious/noExplicitAny: SDK cursor type isn't exported
  let cursor: any = null
  for (let page = 0; page < EVENTS_MAX_PAGES; page++) {
    const events = await sdk.objectEvents(cursor, EVENTS_PAGE_LIMIT)
    if (events.length === 0) break
    for (const ev of events) {
      const prev = latestByID.get(ev.id)
      if (!prev || ev.updatedAt > prev.updatedAt) latestByID.set(ev.id, ev)
    }
    if (events.length < EVENTS_PAGE_LIMIT) break
    const last = events[events.length - 1]
    cursor = { id: last.id, after: last.updatedAt }
  }
  const out: PinnedObjectInfo[] = []
  for (const ev of latestByID.values()) {
    if (ev.deleted) continue
    const obj = ev.object
    if (!obj) continue
    try {
      out.push({
        id: ev.id,
        createdAt: toISO(obj.createdAt()),
        slabs: obj.slabs(),
      })
    } catch {
      // Best-effort: one object's slabs()/createdAt() failure shouldn't sink the
      // whole walk. The next refresh gets another chance.
    }
  }
  return out
}

function toISO(d: unknown): string {
  if (d instanceof Date) return d.toISOString()
  if (typeof d === 'string') return d
  return new Date(d as number).toISOString()
}

// The web implementation: wrap the WASM `Sdk`. Delegates byte + pin ops to the
// existing core/sia + core/pin helpers, inlines the rest. This is what the app
// uses in the browser and in the desktop WebView until the Tauri-native client
// lands.
export function makeWasmSiaClient(sdk: Sdk): SiaClient {
  return {
    uploadItem: (bytes, onShard) => uploadItem(sdk, bytes, onShard),
    uploadItemsPacked: (items, onShard) =>
      uploadItemsPacked(sdk, items, onShard),
    downloadItem: (url) => downloadItem(sdk, url),

    pinFromShareURL: (url) => pinItemBytes(sdk, url),
    resolveObjectID: async (url) => (await sdk.sharedObject(url)).id(),
    deleteObject: (id) => sdk.deleteObject(id),
    pruneSlabs: () => sdk.pruneSlabs(),

    accountSnapshot: () => fetchAccountSnapshot(sdk),
    listPinnedObjects: () => walkPinnedObjects(sdk),
    getObjectSlabs: async (objectID) => {
      try {
        const obj = await sdk.object(objectID)
        return {
          id: objectID,
          createdAt: toISO(obj.createdAt()),
          slabs: obj.slabs(),
        }
      } catch {
        return null
      }
    },

    appKeyPublicKey: () => sdk.appKey().publicKey(),
  }
}
