// The doc-engine binding — the app's one interface to iroh-docs, the atproto repo's
// replacement. Records are keyed by (collection, rkey), values are opaque bytes (the
// same encrypted blob the app writes today).
//
// One surface, two transports, picked by inTauri():
//   - Web: the wasm pin-core module, running in-page (ephemeral MemStore).
//   - Desktop: Tauri IPC to the native Curator's PERSISTENT replica (tauriDocs.ts) —
//     the same replica the Curator serves over iroh. So on desktop the app's writes
//     land in the Curator's repo, not a throwaway in-webview copy. The Curator
//     auto-starts once connected (useCuratorAutostart), so its doc is up by the time
//     a consumer opens.
// The Tauri path's IPC module is dynamically imported (inside tauriDocs), so it never
// enters the web bundle; and the 7 MB wasm only instantiates when the web path runs.

import {
  channel_doc_namespaces,
  open as coreOpen,
  share as coreShare,
  start_sync as coreStartSync,
  status as coreStatus,
  delete_channel_record,
  delete_record,
  get_channel_record,
  get_record,
  import_channel_doc,
  list_all,
  list_records,
  open_channel_doc,
  put_channel_record,
  put_record,
  share_channel_doc,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import { useCuratorStore } from '../stores/curator'
import { inTauri } from './openExternal'
import {
  channelNamespacesNative,
  deleteChannelRecordNative,
  deleteRecordNative,
  getChannelRecordNative,
  getRecordNative,
  importChannelNative,
  listAllNative,
  listRecordsNative,
  openChannelNative,
  openDocsNative,
  putChannelRecordNative,
  putRecordNative,
  shareChannelNative,
  shareDocNative,
  startSyncNative,
} from './tauriDocs'

// Open the engine exactly ONCE per identity and share it across every caller.
// pin-core's `open` REBUILDS the engine from scratch on each call (fresh endpoint,
// fresh MemStore) — so a second open would drop an active start_sync subscription
// AND wipe other hooks' in-memory writes. Memoizing (keyed on the AppKey hex) makes
// every doc hook + the sync loop talk to one stable engine. A key change (sign
// out/in a different identity) re-opens for the new identity; a failed open clears
// the cache so a later call retries.
let openState: { key: string; promise: Promise<string> } | null = null

/** Open/create the doc for this identity (namespace + author derived from the Sia
 *  AppKey). Returns the namespace id. On desktop this waits for the auto-started
 *  Curator's doc; on web it opens the in-page wasm engine. Idempotent per identity —
 *  the underlying engine is opened once and reused. */
export async function openDocs(appKeyHex: string): Promise<string> {
  if (openState && openState.key === appKeyHex) return openState.promise
  const promise = (async () => {
    if (inTauri()) return openDocsNative()
    await ensureWasm()
    return coreOpen(appKeyHex)
  })()
  openState = { key: appKeyHex, promise }
  // Record the open here rather than in a caller: openDocs is memoized, so this is
  // the one place that runs exactly once per identity no matter which hook got
  // there first. Feeds the web instance's uptime + namespace on the Curate page.
  promise.then(
    (namespace) =>
      useCuratorStore.getState().set({ namespace, openedAt: Date.now() }),
    (e: unknown) => useCuratorStore.getState().set({ lastError: String(e) }),
  )
  // On failure, drop the cache so the next call can re-attempt the open.
  promise.catch(() => {
    if (openState?.promise === promise) openState = null
  })
  return promise
}

export async function putRecord(
  collection: string,
  rkey: string,
  value: Uint8Array,
): Promise<void> {
  if (inTauri()) return putRecordNative(collection, rkey, value)
  await ensureWasm()
  await put_record(collection, rkey, value)
}

export async function getRecord(
  collection: string,
  rkey: string,
): Promise<Uint8Array | undefined> {
  if (inTauri()) return getRecordNative(collection, rkey)
  await ensureWasm()
  return get_record(collection, rkey) ?? undefined
}

export async function deleteRecord(
  collection: string,
  rkey: string,
): Promise<void> {
  if (inTauri()) return deleteRecordNative(collection, rkey)
  await ensureWasm()
  await delete_record(collection, rkey)
}

export async function listRecords(collection: string): Promise<string[]> {
  if (inTauri()) return listRecordsNative(collection)
  await ensureWasm()
  return (await list_records(collection)) as string[]
}

/** Every record across all collections, as {collection, rkey} pairs. Used to
 *  snapshot the whole doc (docsMirror). */
export async function listAll(): Promise<
  Array<{ collection: string; rkey: string }>
> {
  if (inTauri()) return listAllNative()
  await ensureWasm()
  const keys = (await list_all()) as string[]
  return keys.map((key) => {
    const i = key.indexOf('/')
    return { collection: key.slice(0, i), rkey: key.slice(i + 1) }
  })
}

/** Produce a shareable DocTicket for this identity's doc (write cap + relay addr).
 *  A peer imports it via {@link startSync} to live-sync. On desktop this is the
 *  Curator's own ticket; on web the in-page wasm engine's. Requires an open doc
 *  ({@link openDocs}). */
export async function shareDoc(): Promise<string> {
  if (inTauri()) return shareDocNative()
  await ensureWasm()
  return coreShare()
}

/** Join the peer(s) in `ticket` and live-sync this identity's doc with them.
 *  `onEvent` fires with a short label per sync event (insert-local / insert-remote /
 *  sync-finished / neighbor-up|down). The doc must already be open ({@link openDocs}).
 *
 *  Symmetric across platforms: web drives the wasm engine; desktop drives the native
 *  Curator's engine via `curator_start_sync`. One import reconciles both directions,
 *  so this is what lets a desktop actively pull from a peer too — not just be
 *  synced-from. (Desktop sync events aren't surfaced over IPC, so onEvent stays quiet
 *  there; reconciliation doesn't need a subscriber.) */
export async function startSync(
  ticket: string,
  onEvent: (label: string) => void,
): Promise<void> {
  if (inTauri()) return startSyncNative(ticket)
  await ensureWasm()
  await coreStartSync(ticket, onEvent)
}

/** This instance's iroh network status (node id, relay/direct addresses), from the
 *  in-page wasm engine. Web-only by design: on desktop the doc engine IS the native
 *  Curator's, so its network status arrives on the Curator's own IPC status instead
 *  of here — see `curatorStatus`, which is the seam that unifies the two into one
 *  shape. Null when the engine isn't open yet (or on desktop). */
export async function docsStatus(): Promise<DocsNetworkStatus | null> {
  if (inTauri()) return null
  await ensureWasm()
  try {
    return coreStatus() as DocsNetworkStatus
  } catch {
    // Engine not open yet — no status to report.
    return null
  }
}

export type DocsNetworkStatus = {
  nodeId: string
  online: boolean
  relays: string[]
  directAddrs: string[]
  otherAddrs: string[]
  // This instance serves the /hey ALPN too (pin-core registers the same shared
  // handler the native Curator does), so these are real on web, not placeholders.
  rpcServing: boolean
  heyQueued: number
}

// --- Channel docs (the ladder's top rung) ------------------------------------
//
// Reading a channel today walks the ladder bottom-up: cached manifest, else resolve
// its pkarr locator and fetch from Sia. A channel doc is the rung above — the
// subscriber holds a live replica and is PUSHED the author's writes instead of
// polling for them.
//
// The author opens a write replica from a seed only they can derive and hands out a
// READ-mode ticket (published to a K-derived pkarr record). Deriving the namespace
// from K would be simpler, but a namespace secret IS the write capability, so every
// subscriber could then write to the author's doc. The ticket also carries the
// author's node id + relay address, so it answers "where do I dial" in one field.
//
// One doc per channel, rather than entries in the identity doc, because iroh-docs'
// read capability is whole-namespace: a subscriber given the identity doc would see
// every other channel's keys (leaking obscure channels' existence) and the settings
// ciphertext.
//
// All of these need an open engine ({@link openDocs}) first — on desktop that's what
// waits for the Curator.

/** The event kinds an engine reports for a channel doc. Mirrors `pin_derive`'s `EV_*`,
 *  the one vocabulary both engines emit (a wasm callback on web, a Tauri event on
 *  desktop). Prefer {@link isRemoteChange} over comparing these by hand. */
export type ChannelDocEventKind =
  | 'insert-local'
  | 'insert-remote'
  | 'content-ready'
  | 'pending-content-ready'
  | 'neighbor-up'
  | 'neighbor-down'
  | 'sync-finished'
  | 'error'

/** Whether an event means "a peer's write may now be readable" — i.e. re-read.
 *
 *  Both kinds count, and that matters: iroh-blobs content LAGS the entry metadata, so
 *  a reader that reacts only to `insert-remote` will intermittently find the value
 *  isn't downloaded yet, while `content-ready` doesn't say which key arrived. Treating
 *  either as "go re-read" is what makes the reader robust to that ordering. */
export function isRemoteChange(kind: string): boolean {
  return kind === 'insert-remote' || kind === 'content-ready'
}

/** Author side: open (or reopen) the write replica of a channel's doc from its 32-byte
 *  namespace seed (hex). Returns the namespace id. Idempotent per channel. */
export async function openChannelDoc(nsSeedHex: string): Promise<string> {
  if (inTauri()) return openChannelNative(nsSeedHex)
  await ensureWasm()
  return open_channel_doc(nsSeedHex)
}

/** Author side: mint a READ-mode ticket for a channel doc — what a subscriber imports,
 *  and what gets published to the channel's pkarr record.
 *
 *  Mint this while the instance is ONLINE, and refresh it as addresses change: the
 *  ticket freezes whatever addresses are known at the moment it's made, and one with
 *  no relay URL is undialable from a browser (which has no discovery). */
export async function shareChannelDoc(nsId: string): Promise<string> {
  if (inTauri()) return shareChannelNative(nsId)
  await ensureWasm()
  return share_channel_doc(nsId)
}

/** Subscriber side: import a channel's read ticket and live-sync it, returning the
 *  namespace id. `onEvent` fires per sync event with the same (nsId, kind, key) shape
 *  on both platforms — a wasm callback on web, a fanned-out Tauri event on desktop. */
export async function importChannelDoc(
  ticket: string,
  onEvent: (nsId: string, kind: string, key: string) => void,
): Promise<string> {
  if (inTauri()) return importChannelNative(ticket, onEvent)
  await ensureWasm()
  return import_channel_doc(ticket, onEvent)
}

/** Write a record into a channel doc. Author side only — a read replica rejects it. */
export async function putChannelRecord(
  nsId: string,
  collection: string,
  rkey: string,
  value: Uint8Array,
): Promise<void> {
  if (inTauri()) return putChannelRecordNative(nsId, collection, rkey, value)
  await ensureWasm()
  await put_channel_record(nsId, collection, rkey, value)
}

/** Read a record from a channel doc, or undefined if absent (or its content hasn't
 *  finished downloading yet — see {@link isRemoteChange}). */
export async function getChannelRecord(
  nsId: string,
  collection: string,
  rkey: string,
): Promise<Uint8Array | undefined> {
  if (inTauri()) return getChannelRecordNative(nsId, collection, rkey)
  await ensureWasm()
  return (await get_channel_record(nsId, collection, rkey)) ?? undefined
}

/** Delete a record from a channel doc (author side). */
export async function deleteChannelRecord(
  nsId: string,
  collection: string,
  rkey: string,
): Promise<void> {
  if (inTauri()) return deleteChannelRecordNative(nsId, collection, rkey)
  await ensureWasm()
  await delete_channel_record(nsId, collection, rkey)
}

/** The namespace ids of every channel doc this instance currently holds — so a caller
 *  can skip re-opening or re-importing one it already has. */
export async function channelDocNamespaces(): Promise<string[]> {
  if (inTauri()) return channelNamespacesNative()
  await ensureWasm()
  return (await channel_doc_namespaces()) as string[]
}

/** Dev-only roundtrip through the active transport (wasm on web, native Curator on
 *  desktop): open + put + get + list + delete. Exposed on window in main.tsx (dev). */
export async function docsSelfTest(appKeyHex: string): Promise<string> {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const namespace = await openDocs(appKeyHex)
  await putRecord('probe', 'a', enc.encode('hello'))
  await putRecord('probe', 'b', enc.encode('world'))
  const a = await getRecord('probe', 'a')
  const list = await listRecords('probe')
  await deleteRecord('probe', 'a')
  const aAfter = await getRecord('probe', 'a')
  return [
    `namespace = ${namespace}`,
    `get a     = ${a ? dec.decode(a) : 'undefined'}`,
    `list probe = [${list.join(', ')}]`,
    `after delete a = ${aAfter ? dec.decode(aAfter) : 'undefined (ok)'}`,
  ].join('\n')
}

/** A fixed seed for the dev channel-doc round-trip — a real channel's seed comes from
 *  the AppKey + channelID, but the point here is exercising the surface, not deriving. */
const PROBE_CHANNEL_SEED = 'c0de'.repeat(16)

/** Dev-only: drive the AUTHOR half of the channel-doc surface through whichever engine
 *  is active (wasm on web, native Curator on desktop) and report. Ends by printing the
 *  read ticket, which {@link channelDocsImportTest} consumes on a second instance to
 *  prove the subscriber half. Exposed on window in main.tsx. */
export async function channelDocsSelfTest(appKeyHex: string): Promise<string> {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  await openDocs(appKeyHex)
  const nsId = await openChannelDoc(PROBE_CHANNEL_SEED)
  // Reopening must be idempotent — two hooks (or a re-render) shouldn't rebuild it.
  const nsAgain = await openChannelDoc(PROBE_CHANNEL_SEED)
  await putChannelRecord(nsId, 'manifest', 'self', enc.encode('ciphertext-v1'))
  const got = await getChannelRecord(nsId, 'manifest', 'self')
  const namespaces = await channelDocNamespaces()
  const ticket = await shareChannelDoc(nsId)
  await deleteChannelRecord(nsId, 'manifest', 'self')
  const after = await getChannelRecord(nsId, 'manifest', 'self')
  // Leave a record behind so an importing instance has something to sync.
  await putChannelRecord(nsId, 'manifest', 'self', enc.encode('ciphertext-v2'))
  return [
    `channel ns    = ${nsId}`,
    `reopen stable = ${nsAgain === nsId ? 'yes' : `NO (${nsAgain})`}`,
    `get manifest  = ${got ? dec.decode(got) : 'undefined'}`,
    `namespaces    = [${namespaces.join(', ')}]`,
    `after delete  = ${after ? dec.decode(after) : 'undefined (ok)'}`,
    `left behind   = ciphertext-v2`,
    '',
    'read ticket (import this on the other instance):',
    ticket,
  ].join('\n')
}

/** Dev-only: the SUBSCRIBER half. Import a read ticket produced by
 *  {@link channelDocsSelfTest} on another instance, wait for the record to sync, and
 *  confirm the replica is genuinely read-only.
 *
 *  Polls rather than trusting the first event, because content lags metadata — the
 *  same reason {@link isRemoteChange} treats content-ready as a re-read signal. */
export async function channelDocsImportTest(
  appKeyHex: string,
  ticket: string,
): Promise<string> {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  await openDocs(appKeyHex)
  const events: string[] = []
  const nsId = await importChannelDoc(ticket, (_ns, kind, key) => {
    events.push(key ? `${kind} ${key}` : kind)
  })

  let value: Uint8Array | undefined
  for (let i = 0; i < 40; i++) {
    value = await getChannelRecord(nsId, 'manifest', 'self')
    if (value) break
    await new Promise((r) => setTimeout(r, 500))
  }

  // A read replica must reject a write — the property the whole capability choice
  // rests on. Reaching this via the seam proves it end to end, not just in Rust.
  let writeRejected = 'NOT REJECTED (!!)'
  try {
    await putChannelRecord(nsId, 'manifest', 'self', enc.encode('forged'))
  } catch (e) {
    writeRejected = `rejected: ${String(e)}`
  }

  return [
    `imported ns  = ${nsId}`,
    `synced value = ${value ? dec.decode(value) : 'TIMED OUT (nothing after 20s)'}`,
    `write        = ${writeRejected}`,
    `events       = [${events.join(' | ')}]`,
  ].join('\n')
}
