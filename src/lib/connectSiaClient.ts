// Build the right SiaClient for the platform, given the freshly-connected WASM
// Sdk. Web keeps the WASM client (I/O in the page). Desktop hands the AppKey to
// the native Rust backend and returns a Tauri-IPC client — so Sia I/O runs
// natively (native QUIC, no WebView2 byte-stream wart) and the WASM Sdk is used
// only to obtain the AppKey during connect, then discarded.
//
// The Tauri client module is dynamically imported so its `@tauri-apps/api` import
// never enters the web bundle (same pattern as openExternal / curator).

import type { Sdk } from '@siafoundation/sia-storage'
import { makeWasmSiaClient, type SiaClient } from '../core/siaClient'
import { inTauri } from './openExternal'

export async function connectSiaClient(
  sdk: Sdk,
  indexerURL: string,
): Promise<SiaClient> {
  if (inTauri()) {
    const appKeyHex = sdk.appKey().export().toHex()
    // Capture the pubkey from the WASM AppKey so its string format matches web.
    const publicKey = sdk.appKey().publicKey()
    const { makeTauriSiaClient } = await import('./tauriSiaClient')
    return makeTauriSiaClient(appKeyHex, indexerURL, publicKey)
  }
  return makeWasmSiaClient(sdk)
}
