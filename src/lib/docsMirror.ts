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

/** What a read of the durable snapshot established.
 *
 *  Three answers, because two of them read alike and the likeness is what nearly wiped
 *  an account: `none` is having established that this identity has published no
 *  snapshot, and `unknown` is nobody having answered. Only `unknown` can be retried
 *  into an answer, and anything that writes state derived from a snapshot has to refuse
 *  it — an inability to read must never become a write. */
export type SnapshotRead =
  | { kind: 'read'; entries: SnapshotEntry[] }
  | { kind: 'none' }
  | { kind: 'unknown'; error: string }

/** Read the current snapshot, saying which of the three it got.
 *
 *  Never throws: each of the three ways to come back empty is a value here, since the
 *  caller is the one that knows whether it may act on an absence.
 *
 *  `recoverViaLocator` is what makes `none` mean anything. A caller passing false and
 *  holding no pointer has declined to look — which is the brand-new-account gate, where
 *  the point is to skip the DHT round trip — so it gets `none` without having asked
 *  anybody. A caller that needs the distinction passes true. */
async function readSnapshot(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  recoverViaLocator: boolean,
): Promise<SnapshotRead> {
  let url = readPointer()?.url ?? null
  if (!url && recoverViaLocator) {
    try {
      url = await resolveSettingsPointer(appKeyBytes)
    } catch (e) {
      return { kind: 'unknown', error: `settings locator: ${String(e)}` }
    }
    // Cache the recovered URL (id unknown — only the URL lives on the DHT; the
    // next full snapshot supersedes it with a prunable pointer).
    if (url) writePointer({ id: '', url })
  }
  if (!url) return { kind: 'none' }
  try {
    const key = await deriveSnapshotKey(appKeyBytes)
    const bytes = await client.downloadItem(url)
    const ciphertext = new TextDecoder().decode(bytes)
    return {
      kind: 'read',
      entries: JSON.parse(
        await decryptForChannel(key, ciphertext),
      ) as SnapshotEntry[],
    }
  } catch (e) {
    return { kind: 'unknown', error: `snapshot ${url}: ${String(e)}` }
  }
}

/** What a hydration attempt did, carrying the same three answers `readSnapshot` gives.
 *
 *  `none` and `unknown` both leave the doc as they found it, and they are the reason
 *  this reports a shape rather than a count: a count of zero is both of them at once. */
export type HydrateOutcome =
  | { kind: 'restored'; records: number }
  | { kind: 'none' }
  | { kind: 'unknown'; error: string }

/** Re-hydrate the fresh doc from the latest Sia snapshot (into pin-core). Call
 *  after openDocs, before any reads.
 *
 *  Always resolves the locator, since a device holding no pointer is the case this
 *  exists for. */
export async function hydrateFromSia(
  client: SiaClient,
  appKeyBytes: Uint8Array,
): Promise<HydrateOutcome> {
  const read = await readSnapshot(client, appKeyBytes, true)
  if (read.kind !== 'read') return read
  for (const e of read.entries) {
    await putRecord(e.c, e.k, b64decode(e.v))
  }
  return { kind: 'restored', records: read.entries.length }
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
  const read = await readSnapshot(client, appKeyBytes, recoverViaLocator)
  // Throws where the old read threw, so the settings boot path keeps treating an
  // unreadable snapshot as a failure it can retry.
  if (read.kind === 'unknown') throw new Error(read.error)
  if (read.kind === 'none') return undefined
  const hit = read.entries.find((e) => e.c === collection && e.k === rkey)
  return hit ? b64decode(hit.v) : undefined
}
