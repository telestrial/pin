// The Curator — Pin's optional always-on backend agent (desktop only).
//
// Mirrors the shape of desktop.ts: every call is safe on the web (where there's
// no native process to run) and the Tauri IPC module is dynamically imported so
// its JS never enters the web bundle. On web, `available` is false and the
// Curate view explains what it would do; the menu entry itself still renders
// everywhere — we'll make the web side mean something later.

import { inTauri } from './openExternal'

export type CuratorStatus = {
  // Whether the always-on Curator task is currently running.
  running: boolean
  // Whether a Curator can run here at all (i.e. we're in the desktop shell).
  available: boolean
}

const UNAVAILABLE: CuratorStatus = { running: false, available: false }

async function invokeCommand(command: string): Promise<{ running: boolean }> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<{ running: boolean }>(command)
}

export async function curatorStatus(): Promise<CuratorStatus> {
  if (!inTauri()) return UNAVAILABLE
  const { running } = await invokeCommand('curator_status')
  return { running, available: true }
}

export async function startCurator(): Promise<CuratorStatus> {
  if (!inTauri()) return UNAVAILABLE
  const { running } = await invokeCommand('start_curator')
  return { running, available: true }
}

export async function stopCurator(): Promise<CuratorStatus> {
  if (!inTauri()) return UNAVAILABLE
  const { running } = await invokeCommand('stop_curator')
  return { running, available: true }
}
