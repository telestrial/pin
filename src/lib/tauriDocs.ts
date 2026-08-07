// The desktop transport for the doc engine — Tauri IPC to the native Curator's
// PERSISTENT iroh-docs replica (the same one it serves over iroh), mirroring the
// src/lib/docs.ts record surface. Slice B routes docs.ts through here on desktop
// (picked by inTauri()); Slice A exposes it for a dev self-test that proves the IPC
// round-trip. The Tauri IPC module is dynamically imported so it never enters the web
// bundle — the tauriSiaClient.ts / tauriPkarr.ts pattern.
//
// Record identity + value semantics match pin-core (the wasm engine): key is
// `collection/rkey`, value is opaque bytes (the app's encrypted blob). Byte values
// ride as plain JSON number arrays — fine at record scale (settings / channel
// manifests are KB; media bytes live on Sia, never in a record). Every call rejects
// with "Curator is not running" when the engine is down.

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/** The running Curator doc's namespace id, or null if the engine isn't up — the
 *  desktop equivalent of docs.ts `openDocs` (the native Curator opens the doc itself
 *  at start, so this reads the id rather than opening). */
export function docsNamespaceNative(): Promise<string | null> {
  return call<string | null>('docs_namespace')
}

export function putRecordNative(
  collection: string,
  rkey: string,
  value: Uint8Array,
): Promise<void> {
  return call<void>('docs_put_record', {
    collection,
    rkey,
    value: Array.from(value),
  })
}

export async function getRecordNative(
  collection: string,
  rkey: string,
): Promise<Uint8Array | undefined> {
  const v = await call<number[] | null>('docs_get_record', { collection, rkey })
  return v ? new Uint8Array(v) : undefined
}

export function deleteRecordNative(
  collection: string,
  rkey: string,
): Promise<void> {
  return call<void>('docs_delete_record', { collection, rkey })
}

export function listRecordsNative(collection: string): Promise<string[]> {
  return call<string[]>('docs_list_records', { collection })
}

export async function listAllNative(): Promise<
  Array<{ collection: string; rkey: string }>
> {
  const keys = await call<string[]>('docs_list_all')
  return keys.map((key) => {
    const i = key.indexOf('/')
    return { collection: key.slice(0, i), rkey: key.slice(i + 1) }
  })
}

/** The desktop analog of docs.ts `openDocs`: the native Curator opens its doc at
 *  startup (auto-started once connected), so this waits briefly for the engine to
 *  come up and returns its namespace. Bounded (~10s) so a caller isn't stuck if the
 *  Curator never binds — callers are best-effort + retry. The AppKey isn't passed:
 *  the Curator derives the SAME namespace from the same recovery-phrase AppKey. */
export async function openDocsNative(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const ns = await docsNamespaceNative()
    if (ns) return ns
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Curator doc engine did not come up')
}

/** The desktop analog of docs.ts `shareDoc`: the Curator already produces a DocTicket
 *  for its replica (refreshed each poll), exposed via `curator_doc_ticket`. */
export async function shareDocNative(): Promise<string> {
  const ticket = await call<string | null>('curator_doc_ticket')
  if (!ticket) throw new Error('Curator doc ticket not ready')
  return ticket
}

/** The desktop analog of docs.ts `startSync`: actively sync the native Curator's
 *  replica with the peer(s) in `ticket`. Sync runs in the Curator engine, so no live
 *  events come back over IPC — the frontend's onEvent stays quiet on desktop. */
export async function startSyncNative(ticket: string): Promise<void> {
  return call<void>('curator_start_sync', { ticket })
}

// --- Channel docs (the ladder's top rung) ------------------------------------
//
// One replica per channel, held by the native Curator. The author opens a write
// replica from a seed only they can derive and hands out a read-mode ticket; a
// subscriber imports that ticket and is pushed updates.
//
// Live events can't ride a callback over IPC, so the Curator emits them as a Tauri
// event and this module fans them out per namespace — the frontend sees the same
// (nsId, kind, key) shape the wasm engine passes its callback.

/** The Tauri event the Curator forwards channel-doc `LiveEvent`s on. Must match
 *  `CHANNEL_DOC_EVENT` in src-tauri/src/curator.rs. */
const CHANNEL_DOC_EVENT = 'pin:channel-doc'

type ChannelDocEventPayload = { nsId: string; kind: string; key: string }

/** Per-namespace handlers, so one Tauri listener serves every imported channel. */
const channelHandlers = new Map<string, (kind: string, key: string) => void>()
let channelListener: Promise<void> | null = null

/** Attach the single Tauri listener, once. Started BEFORE the first import so the
 *  listener is live by the time the Curator can emit. */
function ensureChannelListener(): Promise<void> {
  if (!channelListener) {
    channelListener = (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<ChannelDocEventPayload>(CHANNEL_DOC_EVENT, (e) => {
        const { nsId, kind, key } = e.payload
        channelHandlers.get(nsId)?.(kind, key)
      })
    })()
  }
  return channelListener
}

/** The Tauri event the Curator reports its own doc's changes on. Must match
 *  `DOC_CHANGE_EVENT` in src-tauri/src/curator.rs. */
const DOC_CHANGE_EVENT = 'pin:doc-change'

type DocChangePayload = { collection: string; rkey: string; kind: string }

let docChangeHandler: ((c: DocChangePayload) => void) | null = null
let docChangeListener: Promise<void> | null = null

/** Start reporting the Curator's doc changes to `onChange`.
 *
 *  One handler — docs.ts fans out to the app's consumers, so this only has to be the
 *  transport. The listener is attached BEFORE the command runs so nothing the Curator
 *  emits immediately is missed. */
export async function subscribeDocChangesNative(
  onChange: (c: DocChangePayload) => void,
): Promise<void> {
  docChangeHandler = onChange
  if (!docChangeListener) {
    docChangeListener = (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<DocChangePayload>(DOC_CHANGE_EVENT, (e) =>
        docChangeHandler?.(e.payload),
      )
    })()
  }
  await docChangeListener
  await call<void>('docs_subscribe_changes', {})
}

/** Start the Curator's pull loop. Idempotent — the engine keeps one. */
export function startPullLoopNative(appKeyHex: string): Promise<void> {
  return call<void>('curator_start_pull', { appKeyHex })
}

/** Start the Curator's locator keep-alive loop. Idempotent — the engine keeps one. */
export function startKeepAliveLoopNative(appKeyHex: string): Promise<void> {
  return call<void>('curator_start_keep_alive', { appKeyHex })
}

export function openChannelNative(nsSeedHex: string): Promise<string> {
  return call<string>('docs_open_channel', { nsSeedHex })
}

export function shareChannelNative(nsId: string): Promise<string> {
  return call<string>('docs_share_channel', { nsId })
}

/** Import a channel's read ticket into the Curator's engine and live-sync it.
 *
 *  Events arriving between the import resolving and the handler being registered are
 *  dropped — a microtask-scale window, and harmless: a caller reads the record right
 *  after importing, so the initial state comes from that read rather than from an
 *  event. `import_and_subscribe` guarantees the Rust side misses nothing. */
export async function importChannelNative(
  ticket: string,
  onEvent: (nsId: string, kind: string, key: string) => void,
): Promise<string> {
  await ensureChannelListener()
  const nsId = await call<string>('docs_import_channel', { ticket })
  channelHandlers.set(nsId, (kind, key) => onEvent(nsId, kind, key))
  return nsId
}

export function putChannelRecordNative(
  nsId: string,
  collection: string,
  rkey: string,
  value: Uint8Array,
): Promise<void> {
  return call<void>('docs_put_channel_record', {
    nsId,
    collection,
    rkey,
    value: Array.from(value),
  })
}

export async function getChannelRecordNative(
  nsId: string,
  collection: string,
  rkey: string,
): Promise<Uint8Array | undefined> {
  const v = await call<number[] | null>('docs_get_channel_record', {
    nsId,
    collection,
    rkey,
  })
  return v ? new Uint8Array(v) : undefined
}

export function deleteChannelRecordNative(
  nsId: string,
  collection: string,
  rkey: string,
): Promise<void> {
  return call<void>('docs_delete_channel_record', { nsId, collection, rkey })
}

export function channelNamespacesNative(): Promise<string[]> {
  return call<string[]>('docs_channel_namespaces')
}

/** Slice A proof: drive the native Curator doc through put / get / list / delete over
 *  IPC and report. Requires the Curator to be running (enable curation first). */
export async function curatorDocsSelfTest(): Promise<string> {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const ns = await docsNamespaceNative()
  if (!ns) return 'Curator not running — enable curation first, then retry'
  await putRecordNative('probe', 'a', enc.encode('hello'))
  await putRecordNative('probe', 'b', enc.encode('world'))
  const a = await getRecordNative('probe', 'a')
  const list = await listRecordsNative('probe')
  const all = await listAllNative()
  await deleteRecordNative('probe', 'a')
  const aAfter = await getRecordNative('probe', 'a')
  return [
    `namespace     = ${ns}`,
    `get probe/a   = ${a ? dec.decode(a) : 'undefined'}`,
    `list probe    = [${list.join(', ')}]`,
    `list all      = [${all.map((k) => `${k.collection}/${k.rkey}`).join(', ')}]`,
    `after delete a = ${aAfter ? dec.decode(aAfter) : 'undefined (ok)'}`,
  ].join('\n')
}
