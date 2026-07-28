// Desktop (Tauri) window controls. Every op is a no-op on the web, and the
// Tauri window API is dynamically imported so its JS never enters the web
// bundle. `inTauri` lives in openExternal (shared with the Sia-approval path).

import { inTauri } from './openExternal'

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

export async function minimizeWindow(): Promise<void> {
  if (!inTauri()) return
  await (await currentWindow()).minimize()
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!inTauri()) return
  await (await currentWindow()).toggleMaximize()
}

// Closing HIDES the window to the tray — the Rust side intercepts the
// close-request (src-tauri/src/tray.rs) so the Curator keeps running with no
// surface open. `quitApp` is the one path that actually ends the process.
export async function closeWindow(): Promise<void> {
  if (!inTauri()) return
  await (await currentWindow()).close()
}

export async function quitApp(): Promise<void> {
  if (!inTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('quit_app')
}

export async function isFullscreen(): Promise<boolean> {
  if (!inTauri()) return false
  return (await currentWindow()).isFullscreen()
}

// Toggle true fullscreen (covers the taskbar). Returns the new state.
export async function toggleFullscreen(): Promise<boolean> {
  if (!inTauri()) return false
  const w = await currentWindow()
  const next = !(await w.isFullscreen())
  await w.setFullscreen(next)
  return next
}
