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
  // The local repo's did:key (stable across restarts).
  repoDid: string | null
  // The local repo's signed root commit CID.
  repoRoot: string | null
  // Whether the repo was reopened from an on-disk CAR (true) or created fresh
  // this run (false) — proof that content survives a restart.
  repoReopened: boolean
  // The repo engine error, if it failed to come up (iroh still runs).
  repoError: string | null
  // Whether the RPC server (ALPN pin-keeper/0) is accepting connections.
  rpcServing: boolean
  // Result of the one-shot RPC self-test ("ok …" or an error string).
  rpcSelftest: string | null
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
  repoDid: null,
  repoRoot: null,
  repoReopened: false,
  repoError: null,
  rpcServing: false,
  rpcSelftest: null,
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

export async function startCurator(): Promise<CuratorStatus> {
  if (!inTauri()) return UNAVAILABLE
  return { ...(await invokeCommand('start_curator')), available: true }
}

export async function stopCurator(): Promise<CuratorStatus> {
  if (!inTauri()) return UNAVAILABLE
  return { ...(await invokeCommand('stop_curator')), available: true }
}
