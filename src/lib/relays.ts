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
import { useAuthStore } from '../stores/auth'
import {
  LOCAL_IROH_RELAYS,
  LOCAL_PKARR_RELAYS,
  PUBLIC_IROH_RELAYS,
  PUBLIC_PKARR_RELAYS,
  type RelayPreset,
} from './constants'

export type RelaySet = { pkarr: string[]; iroh: string[] }

/** The URLs a preset stands for. `custom` carries its own, so it resolves to nothing
 *  here and the caller supplies them. */
export function relaysForPreset(preset: RelayPreset): RelaySet {
  if (preset === 'public') {
    return { pkarr: [...PUBLIC_PKARR_RELAYS], iroh: [...PUBLIC_IROH_RELAYS] }
  }
  if (preset === 'local') {
    return { pkarr: [...LOCAL_PKARR_RELAYS], iroh: [...LOCAL_IROH_RELAYS] }
  }
  return { pkarr: [], iroh: [] }
}

/** The preset an environment variable pins this run to, when one does.
 *
 *  The test tiers are what this is for: `test:sync` runs against the local relays it
 *  starts, and `test:sync:public` runs the same specs against the public path so that
 *  path keeps being exercised by something. A person's own choice lives in the store. */
function pinnedPreset(): RelayPreset | null {
  const pinned = import.meta.env.VITE_RELAY_PRESET
  return pinned === 'local' || pinned === 'public' ? pinned : null
}

/** The relays in force for this instance. */
export function resolveRelays(): RelaySet {
  const pinned = pinnedPreset()
  if (pinned) return relaysForPreset(pinned)

  const s = useAuthStore.getState()
  if (s.relayPreset === 'custom') {
    return { pkarr: [...s.customPkarrRelays], iroh: [...s.customIrohRelays] }
  }
  return relaysForPreset(s.relayPreset)
}

let configured: Promise<void> | null = null

/** Wasm up and relays chosen — the gate every network leg goes through.
 *
 *  Memoized for the reason `ensureWasm` is: this is one question with one answer, and
 *  two callers configuring the transport separately is how they come to configure it
 *  differently. Both legs are set by the one call, so the pkarr fan-out and the iroh
 *  endpoint can't end up pointed at different networks.
 *
 *  Which means a change to the choice takes a reload to land, and that matches what is
 *  underneath: the endpoint reads its relays when it binds, and it binds once. */
export function ensureRelays(): Promise<void> {
  if (!configured) {
    const set = resolveRelays()
    configured = ensureWasm().then(() => configure_relays(set.pkarr, set.iroh))
  }
  return configured
}
