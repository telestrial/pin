// The Curator — Pin's always-on agent — reported through ONE shape on both
// platforms.
//
// There is one Curator; a desktop instance and a browser tab are co-equal
// instances of it, not a real tier and a lesser one. So this module is a platform
// seam in the same family as docs.ts / pkarrTransport / connectSiaClient: desktop
// asks the native process over Tauri IPC, web assembles the identical
// `CuratorReport` from the in-page wasm engine plus the hooks doing the work
// (stores/curator.ts). The Curate page then renders one interface over either.
//
// Where the instances genuinely differ, the difference shows up as a VALUE in a
// shared field, never as a missing section:
//   - `directAddrs` is empty on web — a tab has no listening socket, so every path
//     runs through a relay. It's still dialable there (proven: browser↔browser and
//     native→browser sync both work), just only by a peer holding its address,
//     since discovery-by-bare-id doesn't resolve in wasm.
//   - `rpcServing` / `heyQueued` are inert on web because pin-core doesn't register
//     a `pin-keeper/0` handler yet. That's unbuilt, NOT a browser limitation — a
//     wasm node can serve; don't let the copy imply otherwise.
//   - `docsReopened` is always false on web: the wasm store is in-memory, rebuilt
//     each session, and rehydrated from the Sia snapshot.
// The Tauri IPC module stays dynamically imported so its JS never enters the web
// bundle.

import { docsStatus } from './docs'
import { inTauri } from './openExternal'

// What the Rust commands return (serde camelCase).
export type CuratorReport = {
  running: boolean
  // off | binding | connecting | online | stopping | error
  phase: string
  // iroh EndpointId — this node's stable public-key identity.
  nodeId: string | null
  // Connected to a relay (reachable).
  online: boolean
  // Relay transport addresses (debug-formatted).
  relays: string[]
  // Direct IP transport addresses discovered (LAN + public via STUN).
  directAddrs: string[]
  // Non-relay, non-IP transport addresses.
  otherAddrs: string[]
  // Seconds since the endpoint bound.
  uptimeSecs: number | null
  // The Curator's resolvable did:dht identity (ed25519, derived from the
  // recovery phrase — stable across restarts, recoverable on any device).
  didDht: string | null
  // Result of publishing the did:dht document to Mainline DHT + self-resolve
  // ("ok …" or "failed: …"); null if not attempted.
  didDhtPublished: string | null
  // The iroh-docs replica namespace ID (the local repo's identifier).
  docsNamespace: string | null
  // Whether the docs store was reopened from disk (true) or created fresh this
  // run (false) — proof that content survives a restart.
  docsReopened: boolean
  // Whether the RPC server (ALPN pin-keeper/0) is accepting connections.
  rpcServing: boolean
  // Result of the one-shot RPC self-test ("ok …" or an error string).
  rpcSelftest: string | null
  // Inbound `hey` knocks parked in the inbox awaiting reconcile.
  heyQueued: number
  // The doc's durable copy on Sia — the encrypted snapshot in lib/docsMirror.ts,
  // plus the pkarr locator that makes it recoverable from the recovery phrase
  // alone. Reported from the TS layer on BOTH platforms, because that's where the
  // snapshot runs: it reads the doc through the same `docs.ts` seam that routes to
  // the native replica on desktop, so there's one mirror, not one per platform.
  // (The Curator's own repo-CAR mirror was retired at the iroh-docs cutover; this
  // snapshot took over the job and added the locator it never had.)
  mirrorState: string
  mirrorUrl: string | null
  mirrorError: string | null
  // Last bind/runtime error.
  lastError: string | null
}

export type CuratorStatus = CuratorReport & {
  // Whether this instance is the NATIVE one (desktop): durable store, and it keeps
  // running with no page in front of it. Purely for honest copy — never gate a
  // section on it. Both instances curate; this says which physics apply.
  native: boolean
}

const OFFLINE: CuratorReport = {
  running: false,
  phase: 'off',
  nodeId: null,
  online: false,
  relays: [],
  directAddrs: [],
  otherAddrs: [],
  uptimeSecs: null,
  didDht: null,
  didDhtPublished: null,
  docsNamespace: null,
  docsReopened: false,
  rpcServing: false,
  rpcSelftest: null,
  heyQueued: 0,
  mirrorState: 'off',
  mirrorUrl: null,
  mirrorError: null,
  lastError: null,
}

/** What the native process actually sends: every field except the Sia-snapshot
 *  ones, which it doesn't run (see `mirrorState` above). Typed as its own shape so
 *  the compiler makes every caller overlay them rather than silently shipping
 *  `undefined` into the UI. */
type NativeCuratorReport = Omit<
  CuratorReport,
  'mirrorState' | 'mirrorUrl' | 'mirrorError'
>

async function invokeCommand(command: string): Promise<NativeCuratorReport> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<NativeCuratorReport>(command)
}

/** Assemble the web instance's report: the same fields, sourced from the in-page
 *  wasm engine (network), the auth store (identity, enabled), and stores/curator
 *  (what the running hooks have reported). */
async function webStatus(): Promise<CuratorStatus> {
  const { useAuthStore } = await import('../stores/auth')
  const { useCuratorStore } = await import('../stores/curator')
  const auth = useAuthStore.getState()
  const c = useCuratorStore.getState()

  const enabled = auth.curationEnabled
  const net = enabled ? await docsStatus() : null
  const running = enabled && c.openedAt !== null

  return {
    ...OFFLINE,
    native: false,
    running,
    phase: !enabled
      ? 'off'
      : net?.online
        ? 'online'
        : running
          ? 'connecting'
          : 'starting',
    nodeId: net?.nodeId ?? null,
    online: net?.online ?? false,
    relays: net?.relays ?? [],
    directAddrs: net?.directAddrs ?? [],
    otherAddrs: net?.otherAddrs ?? [],
    // Real on web: the wasm Router accepts the same /hey ALPN the native Curator
    // does, so a peer holding this tab's address can knock while it's open.
    rpcServing: net?.rpcServing ?? false,
    heyQueued: net?.heyQueued ?? 0,
    uptimeSecs:
      c.openedAt === null
        ? null
        : Math.max(0, Math.round((Date.now() - c.openedAt) / 1000)),
    didDht: auth.myDidDht,
    didDhtPublished: c.didDhtPublished,
    docsNamespace: c.namespace,
    // The wasm store is in-memory: always built fresh, rehydrated from Sia.
    docsReopened: false,
    ...siaMirrorStatus(c),
    lastError: c.lastError,
  }
}

// The Sia-snapshot fields, which live in the TS curator store on both platforms
// (the snapshot itself is TS, over whichever doc engine is present).
function siaMirrorStatus(c: {
  mirrorState: string
  mirrorUrl: string | null
  mirrorError: string | null
}) {
  return {
    mirrorState: c.mirrorState,
    mirrorUrl: c.mirrorUrl,
    mirrorError: c.mirrorError,
  }
}

export async function curatorStatus(): Promise<CuratorStatus> {
  if (!inTauri()) return webStatus()
  const { useCuratorStore } = await import('../stores/curator')
  // Native status for the node itself; the Sia-snapshot fields are overlaid from
  // the TS store, since the snapshot runs here rather than in the Rust process.
  return {
    ...(await invokeCommand('curator_status')),
    ...siaMirrorStatus(useCuratorStore.getState()),
    native: true,
  }
}

// Turning curation on/off is ONE control with one meaning — "does this instance
// work the network in the background" — and it applies on both platforms. It flips
// the device-local `curationEnabled` flag that the background hooks respect (the
// pull loop, rendezvous sync); desktop additionally starts the native process,
// which is the part that survives with no page in front of it.
//
// The Curator runs inside an authenticated Pin instance, so the native side is
// handed the already-unlocked Sia AppKey — the one root secret its docs namespace
// and did:dht identity derive from. Absent it, the node binds but has no repo.
export async function startCurator(
  appKeyHex?: string | null,
): Promise<CuratorStatus> {
  const { useAuthStore } = await import('../stores/auth')
  useAuthStore.getState().setCurationEnabled(true)
  if (!inTauri()) return webStatus()
  const { invoke } = await import('@tauri-apps/api/core')
  const { useCuratorStore } = await import('../stores/curator')
  const report = await invoke<NativeCuratorReport>('start_curator', {
    appKeyHex: appKeyHex ?? null,
  })
  return {
    ...report,
    ...siaMirrorStatus(useCuratorStore.getState()),
    native: true,
  }
}

export async function stopCurator(): Promise<CuratorStatus> {
  const { useAuthStore } = await import('../stores/auth')
  const { useCuratorStore } = await import('../stores/curator')
  useAuthStore.getState().setCurationEnabled(false)
  if (!inTauri()) return webStatus()
  return {
    ...(await invokeCommand('stop_curator')),
    ...siaMirrorStatus(useCuratorStore.getState()),
    native: true,
  }
}

// This instance's shareable DocTicket (its iroh-docs replica's write capability +
// its address), or null before the doc engine has produced one. Another instance of
// the SAME identity imports it (docs.ts startSync) to live-sync — one import
// reconciles both directions, so the serving side never has to import.
//
// Both platforms have one: a browser tab can serve a ticket exactly as the native
// Curator does (proven by the browser↔browser and native→browser sync spikes).
export async function curatorDocTicket(): Promise<string | null> {
  if (!inTauri()) {
    const { shareDoc } = await import('./docs')
    // Throws when the engine isn't open yet — no ticket to show.
    return shareDoc().catch(() => null)
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string | null>('curator_doc_ticket')
}
