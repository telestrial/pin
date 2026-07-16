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

let client: Client | null = null
async function getClient(): Promise<Client> {
  await ensureReady()
  if (!client) client = new Client()
  return client
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

/** Publish a set of TXT records to the DHT under `keypair`. Overwrites the prior
 *  document for this key. ~5s (Mainline store latency); call in the background. */
export async function publishRecords(
  keypair: Keypair,
  records: PkarrTxt[],
): Promise<void> {
  await ensureReady()
  const builder = SignedPacket.builder()
  for (const { name, value } of records) {
    // One TXT string caps at 255 bytes (spike-confirmed); callers chunk longer
    // values across multiple records before reaching here.
    builder.addTxtRecord(name, value, 3600)
  }
  const packet = builder.buildAndSign(keypair)
  const c = await getClient()
  await c.publish(packet)
}

/** Resolve a `did:dht:<key>` (or a bare pkarr public-key string) to its current TXT
 *  records. `name` is fully-qualified (`_x.<pubkey>`). undefined-resolves → []. */
export async function resolveDidDht(didOrKey: string): Promise<PkarrTxt[]> {
  const publicKey = didOrKey.startsWith('did:dht:')
    ? didOrKey.slice('did:dht:'.length)
    : didOrKey
  const c = await getClient()
  const packet = await c.resolveMostRecent(publicKey)
  if (!packet) return []
  return packet.records
    .filter((r: PkarrRecord) => (r.rdata?.type || '').toUpperCase() === 'TXT')
    .map((r: PkarrRecord) => ({
      name: r.name,
      value: Utils.formatRecordValue(r.rdata),
    }))
}
