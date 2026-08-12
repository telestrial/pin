// Web durability, READ side: re-hydrate the (ephemeral) browser iroh-docs doc from its
// Sia snapshot on load.
//
// TAKING the snapshot is the Curator's (crates/pin-curator/src/snapshot.rs) — one
// writer, reading the doc. What lives here is everything needed to get it back: find
// the pointer, download, decrypt, put the records into a fresh doc.
//
// Originally: The browser has no persistent iroh-docs store
// (MemStore only), so the doc's contents are mirrored to Sia (durable) and put
// back into a fresh doc when the app boots. All in TS over the Sia SDK the app
// already has — no Rust Curator / did:dht needed (that's Phase D).
//
// Pointer: "which Sia object is the latest snapshot" is recorded TWICE, for two
// different jobs. In the DOC, as publish state — the record of what this identity
// published, which has to travel: it's what the Curator's keep-alive republishes
// from, and what a second device needs to reclaim the object this one superseded.
// And in localStorage, as a device-local READ cache, so the boot-time settings read
// stays a plain Sia download with no doc and no pin-core engine behind it. Cache and
// record, not two copies of one thing.

import { settings_pointer_prefix } from '../../crates/pin-core/pkg/pin_core.js'
import {
  decryptForChannel,
  deriveSettingsLocatorSeed,
  deriveSnapshotKey,
} from '../core/crypto'
import type { SiaClient } from '../core/siaClient'
import { ensureWasm } from '../core/wasm'
import { putRecord } from './docs'
import { identityFromSeed, reassembleTxt } from './pkarr'
import { pkarrTransport } from './pkarrTransport'

const POINTER_KEY = 'pin:docsnapshot:pointer'

/** TXT prefix for the chunked Sia-snapshot URL in the settings-locator document.
 *  From Rust: the Curator's keep-alive republishes this record, so the prefix is a
 *  convention that crosses implementations. */
async function pointerPrefix(): Promise<string> {
  await ensureWasm()
  return settings_pointer_prefix()
}

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

function b64decode(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// Resolve the durable settings pointer off the DHT → the current Sia snapshot URL.
// null when nothing's published / resolvable. The recovery read path for a device
// with no localStorage pointer (a restore, or a wiped-pointer catastrophe boot).
async function resolveSettingsPointer(
  appKeyBytes: Uint8Array,
): Promise<string | null> {
  const seed = await deriveSettingsLocatorSeed(appKeyBytes)
  const { publicKey } = await identityFromSeed(seed)
  const records = await (await pkarrTransport()).resolve(publicKey)
  return (await reassembleTxt(records, await pointerPrefix())) || null
}

/** Point the boot cache at a snapshot the Curator took.
 *
 *  The Curator owns the snapshot now, and it has no localStorage to write this to — but
 *  the cache can't simply go away: on web the doc is in memory, so at boot there is no
 *  doc to read a pointer out of, which is the circularity this cache exists to break.
 *  So the pointer is projected back out of the doc while the app runs (see
 *  `useSnapshotPointer`) and read from here at boot. */
export function cacheSnapshotPointer(p: Pointer): void {
  writePointer(p)
}

// no pointer and recovery is off or finds nothing.
async function fetchSnapshotEntries(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  recoverViaLocator = false,
): Promise<SnapshotEntry[]> {
  let url = readPointer()?.url ?? null
  if (!url && recoverViaLocator) {
    url = await resolveSettingsPointer(appKeyBytes)
    // Cache the recovered URL (id unknown — only the URL lives on the DHT; the
    // next full snapshot supersedes it with a prunable pointer).
    if (url) writePointer({ id: '', url })
  }
  if (!url) return []
  const key = await deriveSnapshotKey(appKeyBytes)
  const bytes = await client.downloadItem(url)
  const ciphertext = new TextDecoder().decode(bytes)
  return JSON.parse(await decryptForChannel(key, ciphertext)) as SnapshotEntry[]
}

/** Re-hydrate the fresh doc from the latest Sia snapshot (into pin-core). Call
 *  after openDocs, before any reads. Returns how many records were restored. */
export async function hydrateFromSia(
  client: SiaClient,
  appKeyBytes: Uint8Array,
): Promise<number> {
  const entries = await fetchSnapshotEntries(client, appKeyBytes)
  for (const e of entries) {
    await putRecord(e.c, e.k, b64decode(e.v))
  }
  return entries.length
}

/** Read one record's bytes straight from the latest Sia snapshot, WITHOUT the
 *  pin-core engine (no wasm, no relay). The boot read path: settings / channels
 *  can be sourced from the durable snapshot cheaply. Pass `recoverViaLocator` to
 *  fall back to the durable DHT locator when there's no local pointer (a restore /
 *  wiped-pointer boot — never a brand-new account). undefined if there's no
 *  snapshot or the record isn't in it. */
export async function readRecordFromSnapshot(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  collection: string,
  rkey: string,
  recoverViaLocator = false,
): Promise<Uint8Array | undefined> {
  const entries = await fetchSnapshotEntries(
    client,
    appKeyBytes,
    recoverViaLocator,
  )
  const hit = entries.find((e) => e.c === collection && e.k === rkey)
  return hit ? b64decode(hit.v) : undefined
}
