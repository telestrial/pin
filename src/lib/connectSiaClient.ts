// Build the right SiaClient for the platform, given a freshly-unlocked AppKey.
//
// Both platforms run the same Rust Sia layer; only the hop differs. The browser
// connects pin-sia's session inside its wasm module and talks to it directly; the
// desktop hands the key to the native backend and talks to it over IPC, which keeps
// Sia out of the WebView entirely (native QUIC, and no WebView2 byte-stream wart).
//
// The Tauri client module is dynamically imported so its `@tauri-apps/api` import
// never enters the web bundle (same pattern as openExternal / curator).

import {
  makeWasmSiaClient,
  readAppKeyPublicKey,
  type SiaClient,
} from '../core/siaClient'
import { ensureWasm } from '../core/wasm'
import { inTauri } from './openExternal'

export async function connectSiaClient(
  appKeyHex: string,
  indexerURL: string,
): Promise<SiaClient> {
  // Read the same way on both platforms, so `authorPubkey` in a published manifest
  // doesn't depend on where it was written.
  const publicKey = await readAppKeyPublicKey(appKeyHex)

  if (inTauri()) {
    const { makeTauriSiaClient } = await import('./tauriSiaClient')
    return makeTauriSiaClient(appKeyHex, indexerURL, publicKey)
  }

  await ensureWasm()
  const { sia_connect } = await import('../../crates/pin-core/pkg/pin_core.js')
  const recognized = await sia_connect(appKeyHex, indexerURL)
  if (!recognized) {
    throw new Error('The indexer does not recognize this app key')
  }
  return makeWasmSiaClient(publicKey)
}
