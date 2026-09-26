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

import {
  is_snapshot_tag,
  settings_pointer_prefix,
} from '../../crates/pin-core/pkg/pin_core.js'
import {
  decryptForChannel,
  deriveSettingsLocatorSeed,
  deriveSnapshotKey,
} from '../core/crypto'
import type { PinnedObjectInfo, SiaClient } from '../core/siaClient'
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
 *  TWO RUNGS, cheapest first, and the second is the one that does not expire. The
 *  POINTERS — a device-local cache, then the durable locator — answer in a single
 *  download whenever this device has been here before or the DHT still carries the
 *  record. Both run out: the cache dies with the browser profile, and the locator ages
 *  off Mainline about two hours after the last instance stops republishing it. So an
 *  `unknown` from the pointers is where the SCOPE gets asked instead, and the scope is
 *  the identity's own, holding the object all along.
 *
 *  What this replaces is a pair of questions that existed to disambiguate that
 *  `unknown` — whether the object the locator named was still held, and whether the
 *  scope held anything at all. Both were reaching for the answer the scope can now give
 *  outright: which snapshot is current. */
async function readSnapshot(
  client: SiaClient,
  appKeyBytes: Uint8Array,
): Promise<SnapshotRead> {
  const read = await readSnapshotViaPointers(client, appKeyBytes)
  if (read.kind !== 'unknown') return read
  return readSnapshotFromScope(client, appKeyBytes, read)
}

/** The newest snapshot this identity's Sia scope holds, found by asking the objects
 *  what they are.
 *
 *  Pin's objects are otherwise anonymous — what an object holds is answered by a record
 *  in the doc that names it, and this runs exactly when no such record is in hand — so
 *  a snapshot carries a tag saying so. Reading the tag costs no downloads: the walk the
 *  storage meter already runs opens every object's metadata on the way past, and the
 *  metadata is sealed under the AppKey and does not cross a share, so it says this to
 *  its owner and to nobody else.
 *
 *  NEWEST BY `createdAt`, which the INDEXER stamps and a metadata write leaves alone.
 *  Ordering matters as much as finding: restoring a superseded generation would put
 *  stale records into the doc and the snapshot loop would then mirror them back out
 *  over the current copy. A fingerprint cannot do this job — it says which doc state an
 *  object holds, never which of two is later.
 *
 *  It does not write the pointer cache, which is keyed by share URL where this rung has
 *  only an id. A device that comes in this way comes in this way again until a snapshot
 *  pass publishes a fresh pointer. */
async function readSnapshotFromScope(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  viaPointers: { kind: 'unknown'; error: string },
): Promise<SnapshotRead> {
  await ensureWasm()
  let held: PinnedObjectInfo[]
  try {
    held = await client.listPinnedObjects()
  } catch (e) {
    // The walk FAILS rather than answering, which is the whole of what keeps `none` and
    // `unknown` apart down here.
    return { kind: 'unknown', error: `scope walk: ${String(e)}` }
  }

  // `is_snapshot_tag` is the writer's own reader, reached through wasm. Spelling the
  // tag's shape again in TypeScript would not error when either side moved; it would
  // quietly stop matching, and a scope full of snapshots would read as an account that
  // has published none.
  const tagged = held
    .filter((o) => is_snapshot_tag(o.metadata))
    .map((o) => ({ id: o.id, at: Date.parse(o.createdAt) }))
  const placeable = tagged.filter((o) => !Number.isNaN(o.at))

  if (placeable.length > 0) {
    const newest = placeable.reduce((a, b) => (b.at > a.at ? b : a))
    return downloadSnapshotByID(client, appKeyBytes, newest.id)
  }
  if (tagged.length > 0) {
    // Snapshots with nothing to place them in time. The indexer stamps `createdAt`, so
    // this is not a state it can produce — and taking one anyway is precisely the
    // clobbering case, so it stays an `unknown`, which a later boot can retry.
    return {
      kind: 'unknown',
      error: `${tagged.length} snapshots in scope carry no readable createdAt`,
    }
  }
  // Nothing tagged. A listing that came back WITH objects has demonstrably answered, so
  // their not being snapshots is a fact about the account.
  if (held.length > 0) return { kind: 'none' }
  // An empty listing is the one shape a hiccup can fake, and it contains no object to
  // notice the absence of. The byte total is a separate answer from the indexer, so it
  // is what says whether to believe it.
  return (await accountHoldsNothing(client)) ? { kind: 'none' } : viaPointers
}

/** Whether the indexer says this scope holds no content bytes at all.
 *
 *  Corroboration for an empty listing, and for nothing else. False when the read throws,
 *  which leaves the caller holding its `unknown`: an unanswered question is not an empty
 *  scope, which is the rule one level up restated at the size of one call. */
async function accountHoldsNothing(client: SiaClient): Promise<boolean> {
  try {
    return (await client.accountSnapshot()).rawContentBytes === 0
  } catch {
    return false
  }
}

/** The snapshot a cached pointer or the durable locator names, and why it could not be
 *  read. Every `unknown` it reports is about the SNAPSHOT — whether the scope beneath it
 *  makes that unknown settleable is the caller's question. */
async function readSnapshotViaPointers(
  client: SiaClient,
  appKeyBytes: Uint8Array,
): Promise<SnapshotRead> {
  const cached = readPointer()?.url ?? null
  if (cached) {
    const read = await downloadSnapshot(client, appKeyBytes, cached)
    if (read.kind === 'read') return read
  }

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
    // A locator naming nothing is a locator that did not answer, and it must not be read
    // as an identity that has published nothing. The two are the same bytes: a relay
    // rate-limiting us returns no packet and no error, and a browser reads the relays
    // while a desktop publishes to Mainline, so a locator that genuinely exists can be
    // invisible to the tab asking. Either one, taken for `none`, releases the loops to
    // publish an empty doc over a full one.
    //
    // Whether anything was published is settled by the scope instead, one level up. That
    // subsumes the pointer this used to test — holding one proves a snapshot existed
    // once, where the scope says whether anything survives now, which is the question.
    return { kind: 'unknown', error: 'settings locator names no snapshot' }
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

/** One snapshot object named by a share URL, decrypted, or why it could not be. */
async function downloadSnapshot(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  url: string,
): Promise<SnapshotRead> {
  try {
    return {
      kind: 'read',
      entries: await decryptSnapshot(
        appKeyBytes,
        await client.downloadItem(url),
      ),
    }
  } catch (e) {
    return { kind: 'unknown', error: `snapshot ${url}: ${String(e)}` }
  }
}

/** The same, for an object read out of this identity's own scope by id. */
async function downloadSnapshotByID(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  objectID: string,
): Promise<SnapshotRead> {
  try {
    return {
      kind: 'read',
      entries: await decryptSnapshot(
        appKeyBytes,
        await client.downloadObjectByID(objectID),
      ),
    }
  } catch (e) {
    return {
      kind: 'unknown',
      error: `snapshot object ${objectID}: ${String(e)}`,
    }
  }
}

/** A snapshot object's bytes as the records it carries. Shared by the two ways to name
 *  one, so a rung cannot arrive at its own idea of what a snapshot decrypts to. */
async function decryptSnapshot(
  appKeyBytes: Uint8Array,
  bytes: Uint8Array,
): Promise<SnapshotEntry[]> {
  const key = await deriveSnapshotKey(appKeyBytes)
  const ciphertext = new TextDecoder().decode(bytes)
  return JSON.parse(await decryptForChannel(key, ciphertext)) as SnapshotEntry[]
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
  const read = await readSnapshot(client, appKeyBytes)
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

/** DIAGNOSTIC ONLY — no production caller, and reviving one would re-open the second
 *  recovery path that emptied an account. The settings load reads the doc now, and the
 *  doc is filled by the restore; this exists so a person can ask the SNAPSHOT directly,
 *  bypassing both, when the question is whether the durable copy is readable at all.
 *  Unlike the load path it does not swallow the distinction: `unknown` throws.
 *
 *  Read one record's bytes straight from the latest Sia snapshot, WITHOUT the
 *  pin-core engine (no wasm, no relay). It resolves the durable locator when this
 *  device holds no pointer, which for a diagnostic is the only honest behaviour —
 *  reporting "no snapshot" because THIS device has no pointer is the misleading answer,
 *  not a cheap one. `undefined` when there is genuinely no snapshot or the record is
 *  not in it; `unknown` throws. */
export async function readRecordFromSnapshot(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  collection: string,
  rkey: string,
): Promise<Uint8Array | undefined> {
  const read = await readSnapshot(client, appKeyBytes)
  // Throws where the old read threw, so the settings boot path keeps treating an
  // unreadable snapshot as a failure it can retry.
  if (read.kind === 'unknown') throw new Error(read.error)
  if (read.kind === 'none') return undefined
  const hit = read.entries.find((e) => e.c === collection && e.k === rkey)
  return hit ? b64decode(hit.v) : undefined
}
