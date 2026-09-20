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
import { listAll, putRecord } from './docs'
import { identityFromSeed, reassembleTxt } from './pkarr'
import { pkarrTransport } from './pkarrTransport'
import { addressOf, forgetWithdrawn, withdrawnAddresses } from './withdrawn'

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
  const cached = readPointer()?.url ?? null
  if (cached) {
    const read = await downloadSnapshot(client, appKeyBytes, cached)
    if (read.kind === 'read' || !recoverViaLocator) return read
  }
  if (!recoverViaLocator) return { kind: 'none' }

  // Either nothing is cached, or what was cached names an object that has been
  // superseded and reclaimed. Both want the same question put to the locator: which
  // snapshot is current. Asking only on absence left a boot retrying one dead pointer
  // out of localStorage, 83 times in the recorded case.
  let current: string | null
  try {
    current = await resolveSettingsPointer(appKeyBytes)
  } catch (e) {
    return { kind: 'unknown', error: `settings locator: ${String(e)}` }
  }
  if (!current) {
    // Holding a pointer means this identity has snapshotted at least once, so a
    // locator naming nothing is a locator that failed to answer.
    return cached
      ? { kind: 'unknown', error: 'settings locator names no snapshot' }
      : { kind: 'none' }
  }
  if (current === cached) {
    return { kind: 'unknown', error: `snapshot ${current}: unreadable` }
  }

  const read = await downloadSnapshot(client, appKeyBytes, current)
  // Cached once it has been read THROUGH, so a pointer that answers nothing is never
  // the one a later boot starts from. Id unknown — only the URL lives on the DHT, and
  // the next full snapshot supersedes it with a prunable pointer.
  if (read.kind === 'read') writePointer({ id: '', url: current })
  return read
}

/** One snapshot object, decrypted, or why it could not be. */
async function downloadSnapshot(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  url: string,
): Promise<SnapshotRead> {
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
 *  exists for.
 *
 *  ADDITIVE: a record the doc already holds is left alone. The doc reaches this with
 *  content in it by two routes — a peer of the same identity syncing in over iroh-docs,
 *  and the settings and pin mirrors writing from localStorage — and both carry CURRENT
 *  state where a snapshot is as old as the last mirror. A write here would win either
 *  one, because it carries a newer timestamp than whatever landed a moment ago, so a
 *  restore would undo a change made on another device. Filling the gaps is the job, and
 *  the count is what was actually put back. */
export async function hydrateFromSia(
  client: SiaClient,
  appKeyBytes: Uint8Array,
): Promise<HydrateOutcome> {
  const read = await readSnapshot(client, appKeyBytes, true)
  if (read.kind !== 'read') return read
  // The doc's own key format, which is what `listAll` splits and `record_key` composes.
  const held = new Set(
    (await listAll()).map((k) => `${k.collection}/${k.rkey}`),
  )
  const withdrawn = withdrawnAddresses()
  const inSnapshot = new Set<string>()
  let records = 0
  for (const e of read.entries) {
    const address = addressOf(e.c, e.k)
    inSnapshot.add(address)
    // A record this identity took back. The snapshot predates the withdrawal, so putting
    // it back would be the restore undoing a retraction — see `lib/withdrawn`.
    if (withdrawn.has(address)) continue
    if (held.has(address)) continue
    await putRecord(e.c, e.k, b64decode(e.v))
    records += 1
  }
  // A withdrawal the snapshot has caught up with has nothing left to protect against,
  // and this read is the one place that can say so.
  forgetWithdrawn([...withdrawn].filter((a) => !inSnapshot.has(a)))
  return { kind: 'restored', records }
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
