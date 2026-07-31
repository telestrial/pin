// Pin's browser pkarr layer — the mutable, identity-keyed pointer that lets a reader
// find an author's content with no company in the path.
//
// The implementation lives in Rust now (`pin-pkarr`, reached through pin-core), which
// the native Curator uses too. So the packet shape, TTL, retry posture, relay fan-out
// and pick-the-newest-packet logic are one definition rather than a TypeScript copy and
// a Rust copy that a comment asks to stay in step. Only the transport differs by
// target, and that difference is real: a browser sandbox can't send UDP, so it goes
// through public relays while the desktop talks to the Mainline DHT directly.
//
// This module stays as the app's entry point rather than callers reaching pin-core, for
// two reasons: the chunking convention below is app-level, and the integration tier
// mocks this module — so keeping the exported surface here is what lets tests intercept
// the network without touching the transport seam.

import {
  pkarr_public_key,
  pkarr_publish,
  pkarr_resolve,
} from '../../crates/pin-core/pkg/pin_core.js'
import { deriveDidDhtSeed } from '../core/crypto'
import { ensureWasm } from '../core/wasm'

/** A name/value pair to publish as a TXT record in a pkarr document. */
export type PkarrTxt = { name: string; value: string }

/** A pkarr identity, addressed by its z-base32 public key (the resolve key).
 *
 *  No keypair here: the signing key never leaves Rust. Everything that publishes
 *  passes the 32-byte SEED instead, which is also what crosses to the native backend —
 *  a keypair object can't travel over wasm-bindgen or IPC, and 32 bytes can. */
export type PkarrIdentity = { publicKey: string }

/** Turn a 32-byte ed25519 seed into a pkarr identity. The generic primitive under both
 *  the AppKey-derived did:dht and the K-derived channel locators. */
export async function identityFromSeed(
  seed: Uint8Array,
): Promise<PkarrIdentity> {
  await ensureWasm()
  return { publicKey: pkarr_public_key(seed) }
}

/** An identity's did:dht plus its resolve key. */
export type DidDhtIdentity = PkarrIdentity & {
  /** `did:dht:<zbase32(ed25519 pubkey)>` — the same value the Curator derives. */
  did: string
}

/** Derive this identity's did:dht from the Sia AppKey. Both the seed derivation and the
 *  key encoding are the Rust ones the Curator uses, so the two agree by construction. */
export async function deriveDidDht(
  appKeyBytes: Uint8Array,
): Promise<DidDhtIdentity> {
  const seed = await deriveDidDhtSeed(appKeyBytes)
  const identity = await identityFromSeed(seed)
  return { did: `did:dht:${identity.publicKey}`, ...identity }
}

// Max bytes in a single TXT character-string. A longer value is split across indexed
// records `<prefix>0`, `<prefix>1`, … and reassembled by the resolver's callers.
//
// Worth knowing: the Rust client no longer *enforces* this (the JS client it replaced
// threw past 255 — simple_dns instead splits into several character-strings and rejoins
// them transparently). Chunking is still mandatory, because it's the convention every
// already-published record uses, and because the ~1000-byte ceiling on the whole packet
// is a separate constraint that chunking doesn't lift.
const TXT_MAX = 255

/** Split a value into indexed TXT records (`<prefix>0`, `<prefix>1`, …) so a long
 *  pointer (e.g. a Sia share URL) fits under the per-string cap. */
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

/** Publish a set of TXT records under the key derived from `seed`, replacing whatever
 *  that key pointed at. Fans out to every relay and succeeds if any accepts; throws
 *  only when all of them fail every attempt. Takes seconds — call in the background. */
export async function publishRecords(
  seed: Uint8Array,
  records: PkarrTxt[],
): Promise<void> {
  await ensureWasm()
  await pkarr_publish(seed, JSON.stringify(records))
}

/** Resolve a `did:dht:<key>` (or a bare pkarr public-key string) to its current TXT
 *  records, asking every relay and keeping the newest answer. `name` comes back
 *  fully-qualified (`_x.<pubkey>`). Nothing published resolves to []. */
export async function resolveDidDht(didOrKey: string): Promise<PkarrTxt[]> {
  await ensureWasm()
  return JSON.parse(await pkarr_resolve(didOrKey)) as PkarrTxt[]
}
