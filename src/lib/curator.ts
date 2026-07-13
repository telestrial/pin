// The Curator — Pin's optional always-on backend agent (desktop only).
//
// Mirrors the shape of desktop.ts: every call is safe on the web (where there's
// no native process to run) and the Tauri IPC module is dynamically imported so
// its JS never enters the web bundle. On web, `available` is false and the
// Curate view explains what it would do; the menu entry itself still renders
// everywhere — we'll make the web side mean something later.

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
  // The keeper's resolvable did:dht identity (ed25519, derived from the
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
  // Sia mirror lifecycle: off | up-to-date | pushed | error | no-session.
  mirrorState: string
  // The repo root currently mirrored to Sia.
  mirrorRoot: string | null
  // The mirror object's share URL (a peer fallback-fetch address).
  mirrorUrl: string | null
  // The mirror error, if the push failed (node keeps running).
  mirrorError: string | null
  // Last bind/runtime error.
  lastError: string | null
}

export type CuratorStatus = CuratorReport & {
  // Whether a Curator can run here at all (i.e. we're in the desktop shell).
  available: boolean
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
  mirrorRoot: null,
  mirrorUrl: null,
  mirrorError: null,
  lastError: null,
}

const UNAVAILABLE: CuratorStatus = { ...OFFLINE, available: false }

async function invokeCommand(command: string): Promise<CuratorReport> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<CuratorReport>(command)
}

export async function curatorStatus(): Promise<CuratorStatus> {
  if (!inTauri()) return UNAVAILABLE
  return { ...(await invokeCommand('curator_status')), available: true }
}

// The keeper runs inside an authenticated Pin instance, so we hand it the
// already-unlocked Sia AppKey + indexer URL at start — that's how it mirrors the
// repo under the user's own Sia scope. Both are needed; absent them, the keeper
// runs without a mirror.
export async function startCurator(
  appKeyHex?: string | null,
  indexerUrl?: string | null,
): Promise<CuratorStatus> {
  if (!inTauri()) return UNAVAILABLE
  const { invoke } = await import('@tauri-apps/api/core')
  const report = await invoke<CuratorReport>('start_curator', {
    appKeyHex: appKeyHex ?? null,
    indexerUrl: indexerUrl ?? null,
  })
  return { ...report, available: true }
}

export async function stopCurator(): Promise<CuratorStatus> {
  if (!inTauri()) return UNAVAILABLE
  return { ...(await invokeCommand('stop_curator')), available: true }
}
