// Which relays this instance reaches the network through.
//
// Two kinds, one word. PKARR relays are how a browser reaches the Mainline DHT at all,
// since a sandbox can't send UDP; they carry the signed pointers that make an identity
// or a channel findable, and iroh publishes its own node addresses through one too.
// IROH relays are transport — the path a connection takes until holepunching finds a
// direct one, and, for a browser peer with no listening socket, the path it takes for
// the connection's whole life.
//
// Before this, every one of those destinations was compiled in: `presets::N0` at three
// bind sites, each bundling two of them, plus a constant in pin-pkarr. Nothing chose
// them and nothing could. The cost wasn't the company in the path so much as the
// opacity — a resolve that came back empty could be an empty answer, a rate-limited
// one, or a cached miss, and there was no vantage from which to tell which apart.
//
// Lives in lib/ rather than core/ because the choice is the user's and therefore comes
// from the store, which core can't read.

import { configure_relays } from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import { DEFAULT_IROH_RELAYS, DEFAULT_PKARR_RELAYS } from './constants'

export type RelaySet = { pkarr: string[]; iroh: string[] }

/** The relays in force for this instance. */
export function resolveRelays(): RelaySet {
  return { pkarr: [...DEFAULT_PKARR_RELAYS], iroh: [...DEFAULT_IROH_RELAYS] }
}

let configured: Promise<void> | null = null

/** Wasm up and relays chosen — the gate every network leg goes through.
 *
 *  Memoized for the reason `ensureWasm` is: this is one question with one answer, and
 *  two callers configuring the transport separately is how they come to configure it
 *  differently. Both legs are set by the one call, so the pkarr fan-out and the iroh
 *  endpoint can't end up pointed at different networks. */
export function ensureRelays(): Promise<void> {
  if (!configured) {
    const set = resolveRelays()
    configured = ensureWasm().then(() => configure_relays(set.pkarr, set.iroh))
  }
  return configured
}
