// Pin's browser did:dht layer over pkarr (Phase D). This is the app-side counterpart
// to the Rust keeper's identity.rs: derive the SAME ed25519 identity from the Sia
// AppKey, then publish/resolve records on the Mainline DHT via public pkarr relays —
// the mutable, identity-keyed pointer that lets a reader find an author's content
// without atproto. Proven end-to-end in the browser by the pkarr-web spike
// (2026-07-14): wasm boots, from_secret_key deterministic, publish ~5s, fresh-client
// resolve ~150ms, relays CORS-open.
//
// The wasm is vendored + lazy-loaded: a session that never touches did:dht pays
// nothing (the ~736 KB wasm + relay init load on first use).

import { deriveDidDhtSeed } from '../core/crypto'
import wasmUrl from '../vendor/pkarr/pkarr_js_bg.wasm?url'
import {
  Client,
  initPkarr,
  Keypair,
  type PkarrRecord,
  SignedPacket,
  Utils,
} from '../vendor/pkarr/pkarr-web.js'

let ready: Promise<void> | null = null
function ensureReady(): Promise<void> {
  if (!ready) ready = initPkarr(wasmUrl).then(() => undefined)
  return ready
}

// Resolve timeout. This is also resolveMostRecent's gather window across relays:
// too short and a fast relay serving a STALE packet wins before the slower relay
// holding the fresh one can answer — the exact stale-read that hid a
// just-published post (a write lands on one relay; the read must wait long enough
// to hear from it). A hit is ~150ms when warm, but relays run seconds slow under
// load, so give the gather real room rather than optimizing for the miss case
// (a miss now just errors — there's no atproto fallback to race to).
const RESOLVE_TIMEOUT_MS = 12000
// Per-relay publish timeout — bounds the await-all fan-out below so one dead or
// slow relay can't stall it (a Mainline store via a relay legitimately takes a
// few seconds).
const PUBLISH_TIMEOUT_MS = 15000

// DNS TTL published on every record. This governs how long resolvers/relays and
// the client CACHE a resolved packet — NOT how long the record lives on the DHT
// (that's the DHT's own ~2h expiry, refreshed by keep-alive republish). A high
// TTL means a just-published change stays invisible behind stale caches for that
// long — which is exactly why a subscriber couldn't see a new post — so keep it
// short: mutable channel/identity pointers want fast propagation, not long
// caching. The cost is more frequent re-resolves (fine at friend scale).
const RECORD_TTL_SECS = 60

// One publish client PER relay. The default multi-relay client publishes to all
// relays but CANCELS the rest as soon as one succeeds — so a record reliably
// lands on only ONE relay, and a resolve that answers from a different relay
// reads stale data (the "subscriber can't see new posts" bug). Publishing
// through per-relay clients and awaiting them all fans the write out to every
// relay, so whichever relay a resolve happens to hit already has the fresh
// packet.
let publishClients: Client[] | null = null
async function getPublishClients(): Promise<Client[]> {
  await ensureReady()
  if (!publishClients) {
    publishClients = Client.defaultRelays().map(
      (relay) => new Client([relay], PUBLISH_TIMEOUT_MS),
    )
  }
  return publishClients
}

/** A name/value pair to publish as a TXT record in a pkarr document. */
export type PkarrTxt = { name: string; value: string }

/** A pkarr identity: its keypair + z-base32 public-key string (the resolve key). */
export type PkarrIdentity = {
  publicKey: string
  keypair: Keypair
}

/** Turn a 32-byte ed25519 seed into a pkarr identity. The generic primitive under
 *  both the AppKey-derived did:dht and the K-derived channel locators. */
export async function identityFromSeed(
  seed: Uint8Array,
): Promise<PkarrIdentity> {
  await ensureReady()
  const keypair = Keypair.from_secret_key(seed)
  return { publicKey: keypair.public_key_string(), keypair }
}

/** An identity's did:dht + its pkarr keypair (for publishing under it). */
export type DidDhtIdentity = PkarrIdentity & {
  /** `did:dht:<zbase32(ed25519 pubkey)>` — MUST equal the keeper's for this AppKey. */
  did: string
}

/** Derive this identity's did:dht from the Sia AppKey — byte-for-byte the keeper's
 *  (HKDF `pin:did-dht:v1` → ed25519 seed → pkarr Keypair). */
export async function deriveDidDht(
  appKeyBytes: Uint8Array,
): Promise<DidDhtIdentity> {
  const seed = await deriveDidDhtSeed(appKeyBytes)
  const identity = await identityFromSeed(seed)
  return { did: `did:dht:${identity.publicKey}`, ...identity }
}

// Max bytes in a single TXT character-string (spike-confirmed: 300+ throws). A
// value longer than this is split across indexed records `<prefix>0`, `<prefix>1`,
// … then reassembled by resolveDidDht callers.
const TXT_MAX = 255

/** Split a value into indexed TXT records (`<prefix>0`, `<prefix>1`, …) so a long
 *  pointer (e.g. a Sia share URL) fits under the 255-byte-per-string cap. */
export function chunkForTxt(prefix: string, value: string): PkarrTxt[] {
  const out: PkarrTxt[] = []
  for (let i = 0, n = 0; i < value.length; i += TXT_MAX, n++) {
    out.push({ name: `${prefix}${n}`, value: value.slice(i, i + TXT_MAX) })
  }
  return out
}

/** Reassemble a value split by `chunkForTxt`. Records' `name` is fully-qualified
 *  (`<prefix><n>.<pubkey>`); sort by the numeric index and concatenate. Returns ''
 *  when no matching records are present. */
export function reassembleTxt(records: PkarrTxt[], prefix: string): string {
  const re = new RegExp(`^${prefix}(\\d+)(?:\\.|$)`)
  return records
    .map((r) => ({ m: r.name.match(re), value: r.value }))
    .filter((x): x is { m: RegExpMatchArray; value: string } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => x.value)
    .join('')
}

// DHT publishes fail transiently — network flakiness, and pkarr's concurrency guard
// ("A different SignedPacket is being concurrently published for the same PublicKey")
// when another publish to the same key is briefly in flight (e.g. the keeper + this
// browser both writing the identity key, or an overlapping re-publish). Retry a few
// times with a short delay, the same posture the Rust keeper takes — the delay lets
// the competing publish finish, then the retry (of the same signed packet) lands.
const PUBLISH_RETRIES = 3
const PUBLISH_RETRY_DELAY_MS = 2000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Publish a set of TXT records under `keypair`, fanned out to EVERY relay (see
 *  getPublishClients for why). Overwrites the prior document for this key.
 *  ~seconds (Mainline store latency); call in the background. Succeeds if any
 *  relay accepts it; throws only if every relay fails on every attempt. */
export async function publishRecords(
  keypair: Keypair,
  records: PkarrTxt[],
): Promise<void> {
  await ensureReady()
  const builder = SignedPacket.builder()
  for (const { name, value } of records) {
    // One TXT string caps at 255 bytes (spike-confirmed); callers chunk longer
    // values across multiple records before reaching here.
    builder.addTxtRecord(name, value, RECORD_TTL_SECS)
  }
  const packet = builder.buildAndSign(keypair)
  const clients = await getPublishClients()
  let lastErr: unknown
  for (let attempt = 0; attempt < PUBLISH_RETRIES; attempt++) {
    if (attempt > 0) await sleep(PUBLISH_RETRY_DELAY_MS)
    // Fan the write out to every relay and await them all (best-effort per
    // relay). Success = at least one relay accepted it; a relay that failed
    // this round just won't carry this packet until the next publish /
    // keep-alive re-fans. Retry the whole fan-out only if EVERY relay failed.
    const results = await Promise.allSettled(
      clients.map((c) => c.publish(packet)),
    )
    if (results.some((r) => r.status === 'fulfilled')) return
    lastErr = results.find((r) => r.status === 'rejected')?.reason
  }
  throw lastErr ?? new Error('pkarr publish failed on all relays')
}

/** Resolve a `did:dht:<key>` (or a bare pkarr public-key string) to its current TXT
 *  records. `name` is fully-qualified (`_x.<pubkey>`). undefined-resolves → []. */
export async function resolveDidDht(didOrKey: string): Promise<PkarrTxt[]> {
  const publicKey = didOrKey.startsWith('did:dht:')
    ? didOrKey.slice('did:dht:'.length)
    : didOrKey
  await ensureReady()
  // Resolve from every relay INDEPENDENTLY and pick the newest packet ourselves.
  // The built-in multi-relay client returns the FIRST relay to answer and aborts
  // the rest — so a fast relay serving a STALE packet beats a slower relay
  // holding the fresh one (the stale read that hid just-published posts). Fresh
  // per-relay clients each call (no shared/cached client) also defeat the
  // client-side resolve cache, which otherwise pins the first-seen (stale)
  // packet for the session. Friend-scale: a handful of relays × infrequent
  // resolves, so the extra fan-out is cheap.
  const relays = Client.defaultRelays()
  const settled = await Promise.allSettled(
    relays.map((relay) =>
      new Client([relay], RESOLVE_TIMEOUT_MS).resolveMostRecent(publicKey),
    ),
  )
  const packets = settled.flatMap((r) =>
    r.status === 'fulfilled' && r.value ? [r.value] : [],
  )
  if (packets.length === 0) return []
  // Highest timestamp = the most recently published packet across all relays.
  const newest = packets.reduce((a, b) =>
    b.timestampMs > a.timestampMs ? b : a,
  )
  return newest.records
    .filter((r: PkarrRecord) => (r.rdata?.type || '').toUpperCase() === 'TXT')
    .map((r: PkarrRecord) => ({
      name: r.name,
      value: Utils.formatRecordValue(r.rdata),
    }))
}
