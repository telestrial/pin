// Option B web durability: snapshot the (ephemeral) browser iroh-docs doc to Sia
// and re-hydrate it on load. The browser has no persistent iroh-docs store
// (MemStore only), so the doc's contents are mirrored to Sia (durable) and put
// back into a fresh doc when the app boots. All in TS over the Sia SDK the app
// already has — no Rust keeper / did:dht needed (that's Phase D).
//
// Pointer: "which Sia object is the latest snapshot" is cached in localStorage
// (the data lives on Sia; the pointer is cache). A cold/wiped device has no
// pointer, so hydrate is a no-op today — the objectEvents cold-recovery walk
// (find the newest pin:docsnapshot-tagged object) is a deferred follow-up.

import type { Sdk } from '@siafoundation/sia-storage'
import {
  decryptForChannel,
  deriveSnapshotKey,
  encryptForChannel,
} from '../core/crypto'
import { downloadItem, uploadItem } from '../core/sia'
import { getRecord, listAll, putRecord } from './docs'

const POINTER_KEY = 'pin:docsnapshot:pointer'

// collection, rkey, value(base64). Short keys keep the snapshot JSON compact.
type SnapshotEntry = { c: string; k: string; v: string }
type Pointer = { id: string; url: string }

function readPointer(): Pointer | null {
  try {
    const s = localStorage.getItem(POINTER_KEY)
    return s ? (JSON.parse(s) as Pointer) : null
  } catch {
    return null
  }
}

function writePointer(p: Pointer): void {
  try {
    localStorage.setItem(POINTER_KEY, JSON.stringify(p))
  } catch {
    // localStorage unavailable / quota — the pointer is a cache, safe to skip.
  }
}

function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function b64decode(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** Snapshot the whole doc to Sia (encrypted), update the pointer, prune the
 *  previous snapshot. Call (debounced) after writes. */
export async function snapshotToSia(
  sdk: Sdk,
  appKeyBytes: Uint8Array,
): Promise<Pointer> {
  const key = await deriveSnapshotKey(appKeyBytes)
  const entries: SnapshotEntry[] = []
  for (const { collection, rkey } of await listAll()) {
    const value = await getRecord(collection, rkey)
    if (value) entries.push({ c: collection, k: rkey, v: b64encode(value) })
  }
  const ciphertext = await encryptForChannel(key, JSON.stringify(entries))
  const uploaded = await uploadItem(sdk, new TextEncoder().encode(ciphertext))

  const prev = readPointer()
  writePointer({ id: uploaded.id, url: uploaded.itemURL })

  // Best-effort prune of the superseded snapshot object (the new one is already
  // pointed at, so a failed prune only leaves a reclaimable orphan).
  if (prev && prev.id !== uploaded.id) {
    await sdk
      .deleteObject(prev.id)
      .then(() => sdk.pruneSlabs())
      .catch(() => {})
  }
  return { id: uploaded.id, url: uploaded.itemURL }
}

/** Re-hydrate the fresh doc from the latest Sia snapshot. Call after openDocs,
 *  before any reads. Returns how many records were restored (0 if none). */
export async function hydrateFromSia(
  sdk: Sdk,
  appKeyBytes: Uint8Array,
): Promise<number> {
  const ptr = readPointer()
  if (!ptr) return 0 // cold device: objectEvents fallback deferred
  const key = await deriveSnapshotKey(appKeyBytes)
  const bytes = await downloadItem(sdk, ptr.url)
  const ciphertext = new TextDecoder().decode(bytes)
  const entries = JSON.parse(
    await decryptForChannel(key, ciphertext),
  ) as SnapshotEntry[]
  for (const e of entries) {
    await putRecord(e.c, e.k, b64decode(e.v))
  }
  return entries.length
}
