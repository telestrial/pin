// The pkarr network seam — where the DID/channel-locator publish + resolve legs
// fork by platform, exactly parallel to the SiaClient seam (connectSiaClient.ts).
//
// WHY: on the web these go through public pkarr RELAYS, which lag on read-after-
// write (a just-published pointer isn't resolvable for minutes — the reader-tier
// boundary). The Rust Curator already publishes/resolves over the DIRECT Mainline
// DHT (no relay, no lag — src-tauri/src/pkarr.rs / identity.rs). So on desktop we
// route these two network legs natively and the lag disappears; the web path is
// unchanged (relay-limited, honest reader tier — a browser can't do UDP to the DHT).
//
// Only the NETWORK legs fork. Deriving a pkarr public key / did:dht from a seed
// stays on the wasm (identityFromSeed / deriveDidDht) on both platforms — it's
// local compute, not the lag, and keeps the key-string format byte-identical.
//
// The seam is publish-by-SEED, not by-keypair: a wasm Keypair object can't cross
// IPC, but the 32-byte seed can, and the native side turns it back into a keypair
// (Keypair::from_secret_key) — the same derivation the Curator does.

import { inTauri } from './openExternal'
import { type PkarrTxt, publishRecords, resolveDidDht } from './pkarr'

export interface PkarrTransport {
  /** Publish TXT records signed by the ed25519 key derived from `seed`. Overwrites
   *  the prior document for that key. Background; ~seconds (DHT store latency). */
  publish(seed: Uint8Array, records: PkarrTxt[]): Promise<void>
  /** Resolve a `did:dht:<key>` (or bare pkarr pubkey string) to its current TXT
   *  records. Returns [] when nothing is published / resolvable. */
  resolve(didOrKey: string): Promise<PkarrTxt[]>
}

let transportP: Promise<PkarrTransport> | null = null

/** The platform's pkarr transport, memoized. Web = relays (via lib/pkarr.ts);
 *  desktop = direct Mainline DHT via the native backend. */
export function pkarrTransport(): Promise<PkarrTransport> {
  if (!transportP) transportP = build()
  return transportP
}

async function build(): Promise<PkarrTransport> {
  if (inTauri()) {
    // Dynamically imported so its `@tauri-apps/api` import never enters the web
    // bundle (same pattern as connectSiaClient / openExternal / curator).
    const { makeTauriPkarrTransport } = await import('./tauriPkarr')
    return makeTauriPkarrTransport()
  }
  // Web: relay-backed publish/resolve, now implemented in Rust behind lib/pkarr.ts.
  // Delegating to that module's functions keeps the integration tests (which mock
  // `../pkarr`) transparent — tests run non-Tauri, so this path calls the mocked
  // functions unchanged.
  return {
    publish: (seed, records) => publishRecords(seed, records),
    resolve: (didOrKey) => resolveDidDht(didOrKey),
  }
}
