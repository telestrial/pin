// Instance rendezvous — auto-discovery for same-identity sync. An instance publishes
// its current DocTicket (node id + relay addr — an ADDRESS is required; a bare node id
// doesn't resolve in the relay-only browser, CLAUDE.md 2026-07-25) to a pkarr record
// under the AppKey-derived rendezvous key; another instance of the SAME identity
// resolves it and startSyncs — no manual ticket copy. The rendezvous key is private
// (AppKey-derived), so only your own instances find each other here.
//
// Publish/resolve go through the pkarrTransport seam: direct Mainline DHT on desktop
// (fast), public relays on web (read-after-write lag — so resolve retries).
//
// Slice-2 increment 1: single rendezvous record, last-publisher-wins. The
// parity-preserving multi-instance form (additive coords across N live instances) is a
// follow-on; this proves the mechanism — publish → resolve → auto-sync.

import { deriveRendezvousSeed } from '../core/crypto'
import { shareDoc, startSync } from './docs'
import { chunkForTxt, identityFromSeed, reassembleTxt } from './pkarr'
import { pkarrTransport } from './pkarrTransport'

// TXT prefix for the chunked DocTicket in a rendezvous record (a ticket is a few
// hundred chars — over the 255-byte single-string cap — so it chunks).
const RZ_PREFIX = '_rz'

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Publish this instance's DocTicket to the identity's rendezvous record on the DHT.
 *  Requires an open doc ({@link openDocs}). Returns the ticket published. */
export async function publishRendezvous(appKeyHex: string): Promise<string> {
  const seed = await deriveRendezvousSeed(hexToBytes(appKeyHex))
  const ticket = await shareDoc()
  await (await pkarrTransport()).publish(seed, chunkForTxt(RZ_PREFIX, ticket))
  return ticket
}

/** Resolve the identity's rendezvous record → the published DocTicket, or null if
 *  none is resolvable yet (DHT/relay propagation lag). */
export async function resolveRendezvous(
  appKeyHex: string,
): Promise<string | null> {
  const seed = await deriveRendezvousSeed(hexToBytes(appKeyHex))
  const { publicKey } = await identityFromSeed(seed)
  const records = await (await pkarrTransport()).resolve(publicKey)
  return reassembleTxt(records, RZ_PREFIX) || null
}

/** Resolve the rendezvous ticket (retrying past propagation lag) and start syncing to
 *  it — auto-discovery, no manual ticket. Requires an open doc. Returns the ticket
 *  synced to; throws if nothing is resolvable within the retry budget. */
export async function autoConnectRendezvous(
  appKeyHex: string,
  onEvent: (label: string) => void,
  {
    attempts = 12,
    delayMs = 2500,
  }: { attempts?: number; delayMs?: number } = {},
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const ticket = await resolveRendezvous(appKeyHex)
    if (ticket) {
      await startSync(ticket, onEvent)
      return ticket
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(
    'no rendezvous ticket resolvable — publish from another instance first, or wait for DHT propagation',
  )
}
