// The DESKTOP pkarr transport — publish/resolve over the native Rust backend
// (src-tauri/src/pkarr.rs), reached via Tauri IPC. Satisfies the same
// PkarrTransport interface as the web relay path, so nothing downstream changes;
// the fork lives in pkarrTransport.ts, which dynamically imports this module only
// under Tauri (so `@tauri-apps/api` never enters the web bundle).
//
// This is what fixes the read-after-write lag on desktop: publish/resolve go
// straight to the Mainline DHT (no relay in the read path), the way the Curator
// already does — a fresh publish is resolvable in seconds, not minutes.

import type { PkarrTxt } from './pkarr'
import type { PkarrTransport } from './pkarrTransport'

export async function makeTauriPkarrTransport(): Promise<PkarrTransport> {
  const { invoke } = await import('@tauri-apps/api/core')
  return {
    // seed is 32 bytes — a JSON number array is fine (tiny); the native side
    // rebuilds the keypair from it (Keypair::from_secret_key).
    publish: (seed, records) =>
      invoke<void>('pkarr_publish', { seed: Array.from(seed), records }),
    resolve: (didOrKey) =>
      invoke<PkarrTxt[]>('pkarr_resolve', { key: didOrKey }),
  }
}
