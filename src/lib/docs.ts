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
  start_channel_doc_loop,
  start_channel_sync_loop,
  start_identity_loop,
  start_instance_loop,
  start_keep_alive_loop,
  start_pull_loop,
  start_repack_loop,
  subscribe_doc_changes,
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
  startChannelDocLoopNative,
  startChannelSyncLoopNative,
  startIdentityLoopNative,
  startInstanceLoopNative,
  startKeepAliveLoopNative,
  startPullLoopNative,
  startRepackLoopNative,
  startSyncNative,
  subscribeDocChangesNative,
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

/** A record's address in the doc.
 *
 *  Both engines return this shape already split, by `pin_derive`'s `RecordKey` — the
 *  same one definition that composes the key in the first place. It used to be split
 *  here and again in the desktop transport, which duplicated the rule and got the
 *  separator-less case wrong. */
export type DocRecordKey = { collection: string; rkey: string }

/** Every record across all collections. Used to snapshot the whole doc (docsMirror).
 *  Keys that aren't record keys are skipped by the engine, so one stray key can't
 *  make a snapshot unreadable. */
export async function listAll(): Promise<DocRecordKey[]> {
  if (inTauri()) return listAllNative()
  await ensureWasm()
  return JSON.parse(await list_all()) as DocRecordKey[]
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

// --- The doc-change feed -----------------------------------------------------
//
// The "state out" half of repo-as-only-contract: the Curator writes the repo, the
// frontend reads it — and this is how the frontend LEARNS it should. Whatever moves a
// record (a peer device syncing in, or this instance's own background work) announces
// it here, so a consumer registers interest once instead of running a timer.
//
// One engine subscription, fanned out to every consumer. Both engines deliberately
// allow only ONE pump (a second would double every change), so the fan-out has to be
// here rather than each consumer subscribing to the engine directly.

/** A change to a record in this identity's doc.
 *
 *  `collection`/`rkey` are the record that moved, split by `pin_derive`'s
 *  `parse_record_key` so both engines decompose keys identically. They are EMPTY for
 *  stream-level events (`content-ready`, `sync-finished`, neighbor up/down), which
 *  aren't about one record — treat an empty collection as "something landed, re-check
 *  what you care about". That matters most for `content-ready`: iroh-blobs content
 *  lags the entry, so a value can become readable after its key already arrived.
 *
 *  Local writes are reported too; filter with {@link isRemoteChange} if you only want
 *  a peer's. */
export type DocChange = {
  collection: string
  rkey: string
  kind: string
}

const docChangeHandlers = new Set<(change: DocChange) => void>()
let docChangeStarted: Promise<void> | null = null

function startDocChangeFeed(): Promise<void> {
  if (!docChangeStarted) {
    const fanOut = (change: DocChange) => {
      for (const handler of docChangeHandlers) {
        try {
          handler(change)
        } catch {
          // One consumer throwing must not starve the others, or stop the feed.
        }
      }
    }
    docChangeStarted = (async () => {
      if (inTauri()) return subscribeDocChangesNative(fanOut)
      await ensureWasm()
      // wasm-bindgen types the callback as a bare `Function`, so annotate what
      // pin-core actually passes (collection, rkey, kind).
      await subscribe_doc_changes(
        (collection: string, rkey: string, kind: string) =>
          fanOut({ collection, rkey, kind }),
      )
    })().catch((err) => {
      // Let a later caller retry rather than wedging the feed off permanently.
      docChangeStarted = null
      throw err
    })
  }
  return docChangeStarted
}

/** Be told when a record in this identity's doc changes. Returns an unsubscribe.
 *
 *  Requires an open doc ({@link openDocs}) — on desktop that's what waits for the
 *  Curator. Registering is cheap and idempotent per handler; the underlying engine
 *  subscription is started once and shared.
 *
 *  Push for speed, pull for truth: a consumer should still read once on mount. On
 *  desktop the Curator keeps working with the window hidden to tray, and a change it
 *  makes then is emitted to nobody — the read on mount is what covers that gap. */
export function subscribeDocChanges(
  onChange: (change: DocChange) => void,
): () => void {
  docChangeHandlers.add(onChange)
  void startDocChangeFeed().catch(() => {
    // Engine not up / transport failed — the consumer's own read-on-mount still
    // works, it just won't get live updates. Not worth surfacing from a subscribe.
  })
  return () => {
    docChangeHandlers.delete(onChange)
  }
}

/** How often a pull pass runs, in seconds. Matches the native Curator's cadence, so
 *  the loop behaves the same wherever it's running. */
const PULL_CADENCE_SECS = 90

/** Start the Curator's subscription pull loop in this instance.
 *
 *  The same loop on both platforms, from the same crate — what differs is how long the
 *  instance lives, not what it does. A desktop keeps passing while hidden to tray; a tab
 *  passes until it closes.
 *
 *  Idempotent (each engine keeps one loop). Requires an open doc ({@link openDocs}).
 *  The loop's output is the records it writes, which arrive on {@link subscribeDocChanges}
 *  like any other change. */
export async function startPullLoop(
  appKeyHex: string,
  onPass?: (report: string) => void,
): Promise<void> {
  if (inTauri()) return startPullLoopNative(appKeyHex)
  await ensureWasm()
  // Pass reports are diagnostics — nothing in the app depends on them, since the
  // loop's real output is the records it writes. They're surfaced because a pass
  // that reports is a pass that RAN, which is the only cheap way to see a loop
  // that never turned.
  await start_pull_loop(appKeyHex, PULL_CADENCE_SECS, (report: string) =>
    onPass?.(report),
  )
}

/** How often a keep-alive pass runs, in seconds. Matches the native Curator's cadence.
 *  Sized against the DHT rather than against how often anything changes: a pkarr record
 *  ages off Mainline in a couple of hours, so a pass has to come round several times
 *  inside that window to survive a missed one. */
const KEEP_ALIVE_CADENCE_SECS = 30 * 60

/** Start the Curator's locator keep-alive loop in this instance — republishing the
 *  owned channels' pkarr pointers so they don't age off the DHT and take those
 *  channels' discoverability with them.
 *
 *  Idempotent (each engine keeps one loop). Requires an open doc ({@link openDocs}),
 *  which is also where it reads what this identity owns and last published. */
export async function startKeepAliveLoop(
  appKeyHex: string,
  onPass?: (report: string) => void,
): Promise<void> {
  if (inTauri()) return startKeepAliveLoopNative(appKeyHex)
  await ensureWasm()
  await start_keep_alive_loop(
    appKeyHex,
    KEEP_ALIVE_CADENCE_SECS,
    (report: string) => onPass?.(report),
  )
}

/** How often each owned channel's manifest is copied into its doc and its ticket
 *  re-minted, in seconds.
 *
 *  Fast relative to the other loops because the ticket is perishable: it freezes the
 *  addresses known when it was minted (the first one a fresh instance mints carries no
 *  relay address at all, so it is undialable), and pkarr records age off the DHT. The
 *  copy alongside it is a no-op when the manifest hasn't moved. */
const CHANNEL_DOC_CADENCE_SECS = 4 * 60

/** Start the channel-doc serve loop in this instance — serving each owned channel as a
 *  live replica and keeping a read ticket for it published, so a subscriber is pushed
 *  new posts instead of polling for them.
 *
 *  Needs no Sia session: the sealed manifest is copied out of the main doc verbatim, so
 *  the loop never resolves anything and never sees a channel's content.
 *
 *  Idempotent (each engine keeps one loop). Requires an open doc ({@link openDocs}). */
export async function startChannelDocLoop(
  appKeyHex: string,
  onPass?: (report: string) => void,
): Promise<void> {
  if (inTauri()) return startChannelDocLoopNative(appKeyHex)
  await ensureWasm()
  await start_channel_doc_loop(
    appKeyHex,
    CHANNEL_DOC_CADENCE_SECS,
    (report: string) => onPass?.(report),
  )
}

/** How often the live-sync loop re-checks which channels it should be watching, in
 *  seconds.
 *
 *  This is the RECONCILE cadence, not the delivery one. A manifest arrives as soon as
 *  its author writes it; this only decides who to be listening to, which changes when a
 *  subscription does. */
const CHANNEL_SYNC_CADENCE_SECS = 5 * 60

/** How soon to look again while a subscribed channel still isn't being watched, in
 *  seconds. An author's ticket takes a moment to become resolvable after they publish
 *  it, and waiting out the full cadence over a few seconds of propagation would make a
 *  fresh subscribe feel broken. */
const CHANNEL_SYNC_RETRY_SECS = 20

/** Start the channel live-sync loop in this instance — importing each subscribed
 *  channel from its author's node so a new post arrives without waiting for the next
 *  poll.
 *
 *  What arrives is written to `sub/<channelID>`, the same record the polling rung
 *  writes, so pushed and polled manifests are indistinguishable downstream and share
 *  one recency guard. Nothing new is needed to render them.
 *
 *  Needs no Sia session: a pushed manifest is already sealed and is stored as it came.
 *
 *  Idempotent (each engine keeps one loop). Requires an open doc ({@link openDocs}). */
export async function startChannelSyncLoop(
  appKeyHex: string,
  onPass?: (report: string) => void,
): Promise<void> {
  if (inTauri()) return startChannelSyncLoopNative(appKeyHex)
  await ensureWasm()
  await start_channel_sync_loop(
    appKeyHex,
    CHANNEL_SYNC_CADENCE_SECS,
    CHANNEL_SYNC_RETRY_SECS,
    (report: string) => onPass?.(report),
  )
}

/** How often this instance looks for slabs worth collapsing, in seconds.
 *
 *  Slow on purpose. Waste accumulates a slab at a time and a pass moves real bytes
 *  over the same Sia connection publishing and reading need, so there is nothing to
 *  gain from hurrying. */
const REPACK_CADENCE_SECS = 20 * 60

/** Start the repack loop in this instance — collapsing under-full slabs so storage
 *  stops costing more than it holds, and rewriting every reference that pointed at
 *  the bytes it moved.
 *
 *  Runs in a tab as well as on the desktop: scheduling isn't a capability boundary,
 *  and a tab that's open can tidy its own storage rather than waiting for a machine
 *  that might not exist. Needs a connected Sia session — every leg of a pass is a
 *  Sia call.
 *
 *  Idempotent (each engine keeps one loop). */
export async function startRepackLoop(
  appKeyHex: string,
  onPass?: (report: string) => void,
): Promise<void> {
  if (inTauri()) return startRepackLoopNative(appKeyHex)
  await ensureWasm()
  await start_repack_loop(appKeyHex, REPACK_CADENCE_SECS, (report: string) =>
    onPass?.(report),
  )
}

/** How often this instance re-registers its dial coordinates, in seconds. Well under
 *  the liveness window the Curator crate defines, so a missed pass doesn't drop a
 *  running instance out of the identity's published endpoints. */
const INSTANCE_CADENCE_SECS = 15 * 60

/** Start this instance's registration loop — a heartbeat recording that this node id
 *  is a live endpoint for this identity.
 *
 *  It exists so the identity's published coordinates are the SET of live endpoints
 *  rather than whichever instance wrote last: every instance registers into the doc,
 *  which every instance syncs, so any of them can publish all of them.
 *
 *  Idempotent (each engine keeps one loop). Requires an open doc ({@link openDocs}). */
export async function startInstanceLoop(
  onPass?: (report: string) => void,
): Promise<void> {
  if (inTauri()) return startInstanceLoopNative()
  await ensureWasm()
  await start_instance_loop(INSTANCE_CADENCE_SECS, (report: string) =>
    onPass?.(report),
  )
}

/** How often the identity's coordinates are republished, in seconds. Same reasoning as
 *  the locator keep-alive: a pkarr record ages off Mainline, and an identity nobody
 *  republishes stops resolving. */
const IDENTITY_CADENCE_SECS = 30 * 60

/** Start the identity-publishing loop — ONE packet under the did:dht key carrying the
 *  directory pointer, the doc namespace, and every live endpoint of this identity.
 *
 *  The one writer of that record. It used to be two, each publishing a whole packet
 *  over the other, because neither could see the other's contribution; now every part
 *  is assembled from the doc, which every instance syncs.
 *
 *  Idempotent (each engine keeps one loop). Requires an open doc ({@link openDocs}) —
 *  which is also where the namespace id comes from. */
export async function startIdentityLoop(
  appKeyHex: string,
  namespaceId: string,
  onPass?: (report: string) => void,
): Promise<void> {
  if (inTauri()) return startIdentityLoopNative(appKeyHex)
  await ensureWasm()
  await start_identity_loop(
    appKeyHex,
    namespaceId,
    IDENTITY_CADENCE_SECS,
    (report: string) => onPass?.(report),
  )
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
    try {
      value = await getChannelRecord(nsId, 'manifest', 'self')
    } catch {
      // An entry syncs before its blob does, and reading a value whose content
      // hasn't landed throws rather than returning nothing. That window is exactly
      // what this loop is waiting out, so it's a reason to poll again — not a
      // failure. Letting it escape made this test pass on timing alone.
    }
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
