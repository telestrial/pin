// Instance rendezvous — symmetric auto-discovery for same-identity sync. EVERY open
// instance (desktop or web tab) is a full peer: it advertises its own coords and can
// be synced to. The only real difference is physics — a desktop is always-on and
// durable; a web tab is intermittent — NOT capability (a browser tab serves + is
// synced-from fine; verified cross-device). So this is deliberately NOT a host/client
// tier.
//
// A single pkarr record is last-writer-wins, and one packet (~1000 B) can't hold
// several full DocTickets — so the rendezvous is TWO layers:
//   - a small DIRECTORY record under the rendezvous key: [{ id, at, durable }] — one
//     entry per live instance, no ticket (fits one packet).
//   - each instance's full DocTicket under its OWN key (deriveRendezvousInstanceSeed).
// Advertising is additive: an instance upserts ITS entry into the directory (RMW) and
// publishes its ticket under its own key — so a thin web tab never clobbers the
// durable desktop's coords. Discovery reads the directory, prunes stale entries
// (closed tabs stop refreshing and age out by TTL), and resolves a live peer's ticket
// — preferring the always-on (durable) one.
//
// The rendezvous key is private (AppKey-derived), so only your own instances meet
// here. Publish/resolve go through the pkarrTransport seam: direct Mainline DHT on
// desktop (fast), public relays on web (read-after-write lag — hence periodic refresh
// + TTL heal races).

import {
  deriveRendezvousInstanceSeed,
  deriveRendezvousSeed,
} from '../core/crypto'
import { shareDoc, startSync } from './docs'
import { chunkForTxt, identityFromSeed, reassembleTxt } from './pkarr'
import { type PkarrTransport, pkarrTransport } from './pkarrTransport'

// TXT prefixes: directory (rendezvous key) and per-instance ticket (per-instance key).
const DIR_PREFIX = '_rzd'
const TICKET_PREFIX = '_rzt'

// An instance is considered live if it refreshed within this window; a closed tab
// stops refreshing and its entry ages out (pruned by resolvers). Refresh cadence
// (in the hook) must be comfortably under this.
export const ENTRY_TTL_SEC = 15 * 60

/** A live instance in the rendezvous directory. `at` is epoch seconds of last
 *  refresh; `durable` marks an always-on node (desktop) so resolvers prefer it. */
export type RzEntry = { id: string; at: number; durable: boolean }

type Directory = { v: 1; instances: RzEntry[] }

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function isEntry(e: unknown): e is RzEntry {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as RzEntry).id === 'string' &&
    typeof (e as RzEntry).at === 'number' &&
    typeof (e as RzEntry).durable === 'boolean'
  )
}

// ── Pure directory logic (no I/O — unit-tested) ─────────────────────────────

/** Upsert `mine` into the directory, dropping stale + malformed entries. Fresh =
 *  refreshed within `ttlSec`. My own prior entry is replaced (matched by id). */
export function mergeDirectory(
  existing: RzEntry[],
  mine: RzEntry,
  nowSec: number,
  ttlSec: number,
): RzEntry[] {
  const kept = existing.filter(
    (e) => isEntry(e) && e.id !== mine.id && nowSec - e.at < ttlSec,
  )
  return [...kept, mine]
}

/** Candidate peers to sync to: live, not me, ordered durable-first then most-recent
 *  (so a thin client prefers the always-on desktop, but web↔web still finds a peer). */
export function pickPeers(
  dir: RzEntry[],
  myId: string,
  nowSec: number,
  ttlSec: number,
): RzEntry[] {
  return dir
    .filter((e) => isEntry(e) && e.id !== myId && nowSec - e.at < ttlSec)
    .sort((a, b) =>
      a.durable === b.durable ? b.at - a.at : a.durable ? -1 : 1,
    )
}

/** Tolerant parse of a directory record's JSON — [] on anything malformed. */
export function parseDirectory(json: string): RzEntry[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as Directory | RzEntry[]
    const list = Array.isArray(parsed) ? parsed : parsed.instances
    return Array.isArray(list) ? list.filter(isEntry) : []
  } catch {
    return []
  }
}

// ── I/O ─────────────────────────────────────────────────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000)

async function readDirectory(
  transport: PkarrTransport,
  rvSeed: Uint8Array,
): Promise<RzEntry[]> {
  const { publicKey } = await identityFromSeed(rvSeed)
  const records = await transport.resolve(publicKey)
  return parseDirectory(reassembleTxt(records, DIR_PREFIX))
}

/** Advertise THIS instance: publish its current DocTicket under its own key, then
 *  RMW-upsert its entry into the directory. Additive — never clobbers other
 *  instances' coords. Requires an open doc (shareDoc). Call on a refresh interval so
 *  the entry stays live and races self-heal. */
export async function advertiseInstance(
  appKeyHex: string,
  instanceId: string,
  durable: boolean,
): Promise<void> {
  const rvSeed = await deriveRendezvousSeed(hexToBytes(appKeyHex))
  const transport = await pkarrTransport()

  // 1. Publish my full ticket under my per-instance key (its own packet).
  const ticket = await shareDoc()
  const instSeed = await deriveRendezvousInstanceSeed(rvSeed, instanceId)
  await transport.publish(instSeed, chunkForTxt(TICKET_PREFIX, ticket))

  // 2. RMW the directory: read current, upsert my entry (dropping stale), write back.
  const dir = await readDirectory(transport, rvSeed)
  const merged = mergeDirectory(
    dir,
    { id: instanceId, at: nowSec(), durable },
    nowSec(),
    ENTRY_TTL_SEC,
  )
  await transport.publish(
    rvSeed,
    chunkForTxt(DIR_PREFIX, JSON.stringify({ v: 1, instances: merged })),
  )
}

/** Live peers to try syncing to (durable-first), excluding this instance. */
export async function discoverPeers(
  appKeyHex: string,
  instanceId: string,
): Promise<RzEntry[]> {
  const rvSeed = await deriveRendezvousSeed(hexToBytes(appKeyHex))
  const dir = await readDirectory(await pkarrTransport(), rvSeed)
  return pickPeers(dir, instanceId, nowSec(), ENTRY_TTL_SEC)
}

/** Resolve a peer's current DocTicket from its directory id, or null if unresolvable
 *  (stale entry / propagation lag). */
export async function resolvePeerTicket(
  appKeyHex: string,
  id: string,
): Promise<string | null> {
  const rvSeed = await deriveRendezvousSeed(hexToBytes(appKeyHex))
  const instSeed = await deriveRendezvousInstanceSeed(rvSeed, id)
  const { publicKey } = await identityFromSeed(instSeed)
  const records = await (await pkarrTransport()).resolve(publicKey)
  return reassembleTxt(records, TICKET_PREFIX) || null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Discover a live peer and start syncing to the first whose ticket resolves,
 *  retrying past DHT/relay propagation lag. Returns the ticket synced to; throws if
 *  no live peer is reachable within the retry budget. A convenience for the dev panel
 *  / harness; the app loop (useRendezvousSync) drives discover/resolve/sync itself so
 *  it can keep advertising + retrying on its own cadence. */
export async function autoConnectRendezvous(
  appKeyHex: string,
  instanceId: string,
  onEvent: (label: string) => void,
  {
    attempts = 12,
    delayMs = 2500,
  }: { attempts?: number; delayMs?: number } = {},
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const peers = await discoverPeers(appKeyHex, instanceId)
    for (const peer of peers) {
      const ticket = await resolvePeerTicket(appKeyHex, peer.id)
      if (!ticket) continue
      await startSync(ticket, onEvent)
      return ticket
    }
    await sleep(delayMs)
  }
  throw new Error('no live peer found in the rendezvous directory')
}
