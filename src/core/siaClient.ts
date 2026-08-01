// SiaClient — the coarse Sia operation surface the app talks to.
//
// Two implementations satisfy it, and both now run the SAME Rust code underneath
// (crates/pin-sia): the browser reaches it compiled to wasm through pin-core, the
// desktop reaches it natively over Tauri IPC. What differs is the hop, not the
// behaviour — so the walk, the descriptors and the connect flow can't drift between
// them the way a TypeScript client and a Rust backend could.
//
// DESIGN RULE — coarse ops, no live handles cross the boundary. An object handle
// can't marshal over IPC, so every method takes and returns PLAIN serializable data
// (URLs, ids, byte arrays, descriptors). That constraint is why the metering, repack
// and reset walks read descriptors instead of holding handles, and it's what lets one
// interface serve both hops.
//
// (Progress callbacks are the exception that has to be bridged rather than passed:
// the wasm client hands JS functions across wasm-bindgen; a Tauri client would drive
// them via events.)
//
// HAZARD worth knowing about, because it has already bitten: the descriptors arrive as
// JSON, and `JSON.parse` is typed `any`, so a field the Rust side spells differently
// deserializes to `undefined` with neither compiler objecting. The annotations below
// state the expected shape but cannot verify it; the actual guard is a test over in
// pin-sia that asserts the serialized key names.

import {
  sia_account_snapshot,
  sia_delete_object,
  sia_download_item,
  sia_get_object_slabs,
  sia_list_pinned_objects,
  sia_pin_from_share_url,
  sia_prune_slabs,
  sia_public_key,
  sia_resolve_object_id,
  sia_upload_item,
  sia_upload_items_packed,
} from '../../crates/pin-core/pkg/pin_core.js'
import type { AccountSnapshot } from './pin'
import type { UploadedItem } from './sia'
import { ensureWasm } from './wasm'

/** One slab's contribution to an object.
 *
 *  `length` is the byte slice this object occupies in the slab; summing it across an
 *  object gives that object's content size, and across a scope gives what the storage
 *  meter shows. `minShards` is how many sectors are needed to recover the data, which
 *  is what repack multiplies by the shard size to get a slab's usable capacity.
 *
 *  Mirrors `sia_storage::Slab`'s serde output, which is what arrives over either hop. */
export type Slab = {
  encryptionKey: string
  minShards: number
  sectors: unknown[]
  offset: number
  length: number
}

/** A pinned object reduced to the plain data its consumers actually read —
 *  serializable, so it survives the hop to whichever implementation is in use. */
export type PinnedObjectInfo = {
  id: string
  // ISO 8601.
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
  // Mirror a share URL's bytes into this scope.
  pinFromShareURL(url: string): Promise<{ objectID: string }>
  // Resolve a share URL to its object id, without taking custody.
  resolveObjectID(url: string): Promise<string>
  deleteObject(id: string): Promise<void>
  pruneSlabs(): Promise<void>

  // --- accounting / enumeration (plain descriptors, no live handles) ------
  accountSnapshot(): Promise<AccountSnapshot>
  // Everything currently held in this scope. Powers the storage meter, the repack
  // scope, full-reset enumeration and the slab inspector.
  listPinnedObjects(): Promise<PinnedObjectInfo[]>
  // One object's slabs by id (repack's per-ref lookup). null if not held.
  getObjectSlabs(objectID: string): Promise<PinnedObjectInfo | null>

  // --- identity -----------------------------------------------------------
  appKeyPublicKey(): string
}

/** Read the public key for an AppKey without connecting.
 *
 *  Separate from the client because `appKeyPublicKey` is synchronous while wasm init
 *  is not, so the value has to be in hand before the client is built. */
export async function readAppKeyPublicKey(appKeyHex: string): Promise<string> {
  await ensureWasm()
  return sia_public_key(appKeyHex)
}

/** The browser implementation: pin-sia compiled to wasm.
 *
 *  The session lives in Rust and is connected separately (see lib/connectSiaClient),
 *  so this holds no handle — only the public key, which the synchronous accessor
 *  needs and which cannot be fetched on demand.
 *
 *  Every method awaits `ensureWasm()` first. That's a resolved promise after the
 *  first call, and making each entry point self-sufficient means no caller has to
 *  remember an initialization step. */
export function makeWasmSiaClient(publicKey: string): SiaClient {
  return {
    uploadItem: async (bytes, onShard) => {
      await ensureWasm()
      return JSON.parse(await sia_upload_item(bytes, onShard)) as UploadedItem
    },
    uploadItemsPacked: async (items, onShard) => {
      await ensureWasm()
      return JSON.parse(
        await sia_upload_items_packed(items, onShard),
      ) as UploadedItem[]
    },
    downloadItem: async (url) => {
      await ensureWasm()
      return sia_download_item(url)
    },

    pinFromShareURL: async (url) => {
      await ensureWasm()
      return { objectID: await sia_pin_from_share_url(url) }
    },
    resolveObjectID: async (url) => {
      await ensureWasm()
      return sia_resolve_object_id(url)
    },
    deleteObject: async (id) => {
      await ensureWasm()
      return sia_delete_object(id)
    },
    pruneSlabs: async () => {
      await ensureWasm()
      return sia_prune_slabs()
    },

    accountSnapshot: async () => {
      await ensureWasm()
      return JSON.parse(await sia_account_snapshot()) as AccountSnapshot
    },
    listPinnedObjects: async () => {
      await ensureWasm()
      return JSON.parse(await sia_list_pinned_objects()) as PinnedObjectInfo[]
    },
    getObjectSlabs: async (objectID) => {
      await ensureWasm()
      const found = await sia_get_object_slabs(objectID)
      return found === undefined
        ? null
        : (JSON.parse(found) as PinnedObjectInfo)
    },

    appKeyPublicKey: () => publicKey,
  }
}
