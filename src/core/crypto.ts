// Channel-key cryptography. AES-GCM-256 via Web Crypto API; no external dep.
// Encrypted blob format: 1-byte version || 12-byte IV || ciphertext-with-16-byte-tag.
//
// The KEY DERIVATIONS below are no longer implemented here — they're thin calls into
// pin-core (Rust), where `pin_derive` owns every `info` string and the HKDF itself.
// The Curator calls the same functions natively, so a user's did:dht (and every other
// derived secret) is one value with one definition rather than two that a comment
// asks to stay in step. This module keeps the AES-GCM half and the encodings.

import {
  derive_channel_doc_seed,
  derive_channel_doc_ticket_seed,
  derive_channel_locator_seed,
  derive_did_dht_seed,
  derive_rendezvous_instance_seed,
  derive_rendezvous_seed,
  derive_settings_key,
  derive_settings_locator_seed,
  derive_snapshot_key,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from './wasm'

const KEY_BYTES = 32
const IV_BYTES = 12
const ENCRYPTION_VERSION = 1

// rkey derivation: 10 bytes of SHA-256(K) → 16 lowercase base32 chars.
// 80 bits of entropy from a uniform hash; collision-resistant for any
// realistic number of channels per user.
const CHANNEL_ID_HASH_BYTES = 10

export async function generateChannelKey(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES))
}

export function channelKeyToBase64(key: Uint8Array): string {
  return base64Encode(key)
}

export function channelKeyFromBase64(b64: string): Uint8Array {
  const bytes = base64Decode(b64)
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `Channel key must be ${KEY_BYTES} bytes; got ${bytes.length}`,
    )
  }
  return bytes
}

export async function deriveChannelID(key: Uint8Array): Promise<string> {
  return deriveAtRkey(key)
}

// Generic ATProto-rkey-safe deterministic identifier derivation from any
// input bytes. base32(sha256(input))[:16] — 80 bits of entropy. Used by
// channelID (input = K) and by the subscription stand-off records (input
// = subject AT-URI) so re-following an already-followed channel rewrites
// the same record (idempotent put) and unfollow is a single deleteRecord
// call rather than a list-then-find scan.
export async function deriveAtRkey(
  input: Uint8Array | string,
): Promise<string> {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as BufferSource),
  )
  return base32Encode(hash.slice(0, CHANNEL_ID_HASH_BYTES))
}

// Byte-level AES-GCM core. Blob format: 1-byte version || 12-byte IV ||
// ciphertext-with-16-byte-tag, base64-encoded. encryptForChannel and
// encryptSettings both build on this so there's one GCM implementation.
async function encryptBytes(
  key: Uint8Array,
  bytes: Uint8Array,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const cryptoKey = await importKey(key)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      bytes as BufferSource,
    ),
  )
  const out = new Uint8Array(1 + iv.length + ciphertext.length)
  out[0] = ENCRYPTION_VERSION
  out.set(iv, 1)
  out.set(ciphertext, 1 + iv.length)
  return base64Encode(out)
}

async function decryptBytes(
  key: Uint8Array,
  base64Ciphertext: string,
): Promise<Uint8Array> {
  const all = base64Decode(base64Ciphertext)
  if (all.length < 1 + IV_BYTES + 16) {
    throw new Error(
      'Encrypted blob too short to contain version + IV + auth tag',
    )
  }
  const version = all[0]
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(
      `Unsupported encryption version (got ${version}, expected ${ENCRYPTION_VERSION})`,
    )
  }
  const iv = all.slice(1, 1 + IV_BYTES)
  const ciphertext = all.slice(1 + IV_BYTES)
  const cryptoKey = await importKey(key)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext,
  )
  return new Uint8Array(plaintext)
}

export async function encryptForChannel(
  key: Uint8Array,
  plaintext: string,
): Promise<string> {
  return encryptBytes(key, new TextEncoder().encode(plaintext))
}

export async function decryptForChannel(
  key: Uint8Array,
  base64Ciphertext: string,
): Promise<string> {
  return new TextDecoder().decode(await decryptBytes(key, base64Ciphertext))
}

// --- Settings encryption -------------------------------------------------
//
// The settings record lives PUBLICLY on the PDS (records are world-readable),
// so it carries its own encryption — unlike channel manifests, whose key K is
// shared deliberately, the settings key is never shared. It's derived from the
// Sia AppKey, not the atproto identity (under OAuth we don't hold the atproto
// signing key, but we DO hold the AppKey secret via export()).
//
// The plaintext is padded to a FIXED size before encryption so the ciphertext
// length is constant regardless of how many channels/subs it holds — a
// public, firehose-watchable record otherwise leaks channel/sub count via its
// size. Fixed-size padding leaks nothing about content at any pad size; 128 KiB
// is ~400+ entries of headroom (friend-scale is 5–50) and stays well inside
// atproto's "keep records to a few dozen KB" guidance (1 MiB hard ceiling).
export const SETTINGS_PAD_SIZE = 128 * 1024
const SETTINGS_LENGTH_HEADER_BYTES = 4

export async function deriveSettingsKey(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_settings_key(appKeyBytes)
}

// docsMirror snapshot key — the whole-doc Sia snapshot is encrypted under this
// (its record keys would otherwise leak channel/collection structure). Same
// derivation family as settings, different domain. Never shared.
export async function deriveSnapshotKey(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_snapshot_key(appKeyBytes)
}

// The 32-byte ed25519 seed for this identity's did:dht key — the browser's pkarr
// identity IS the Curator's did:dht, because both now call the same Rust function
// (identity.rs derives it the same way, from pin_derive). The seed feeds pkarr's
// `Keypair.from_secret_key` in lib/pkarr.ts.
export async function deriveDidDhtSeed(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_did_dht_seed(appKeyBytes)
}

// The 32-byte ed25519 seed for a channel's pkarr LOCATOR key — derived from the
// channel key K (NOT the AppKey), because a reader only holds K (from the subscribe
// URL) and must derive the same locator to resolve the channel's Sia pointer. So K
// both locates (this key → pkarr record → Sia URL) and decrypts (the manifest).
export async function deriveChannelLocatorSeed(
  channelKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_channel_locator_seed(channelKeyBytes)
}

// The 32-byte seed for a channel's iroh-docs DOC NAMESPACE — the live replica a
// subscriber syncs (the resolution ladder's top rung), as distinct from the Sia object
// + locator that are its durable floor.
//
// AppKey-derived (plus the channelID), NOT K-derived, and that asymmetry is the whole
// design: an iroh-docs namespace secret IS the write capability, so deriving it from K
// would hand every subscriber the ability to write to the author's channel doc.
// Deriving it from the AppKey keeps writing to the author, who shares a READ-mode
// DocTicket instead. Two devices of one author derive the SAME seed (same AppKey), so
// both can serve the channel — which is what makes this compose with multi-instance
// parity rather than fight it.
export async function deriveChannelDocSeed(
  appKeyBytes: Uint8Array,
  channelID: string,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_channel_doc_seed(appKeyBytes, channelID)
}

// The 32-byte ed25519 seed for the pkarr key where a channel's read DocTicket is
// published — K-derived, so a subscriber holding K (from the subscribe URL) can find
// it, exactly like the channel locator.
//
// A SEPARATE record from the locator on purpose. The two rungs have independent
// lifetimes: the locator names a durable Sia object and changes only when the author
// publishes, while the ticket freezes network addresses and has to be refreshed as
// those change. Keeping them apart means a stale ticket can never disturb the durable
// pointer, and a reader that finds no ticket simply falls to the locator rung.
export async function deriveChannelDocTicketSeed(
  channelKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_channel_doc_ticket_seed(channelKeyBytes)
}

// The 32-byte ed25519 seed for your SETTINGS pkarr LOCATOR key — the mutable
// pointer to the current encrypted settings snapshot on Sia lives on the DHT under
// this key. AppKey-derived, so it's unlisted (only you can compute it → only you can
// find your settings pointer, exactly like a channel locator) and domain-separated
// from the PUBLIC did:dht identity, so resolving someone's did:dht never surfaces
// their settings pointer. Recoverable from the recovery phrase alone — the durable
// replacement for the device-local localStorage pointer.
export async function deriveSettingsLocatorSeed(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_settings_locator_seed(appKeyBytes)
}

// The 32-byte ed25519 seed for your instance-RENDEZVOUS pkarr key — where an instance
// of this identity publishes its current iroh DocTicket (node id + relay addr; an
// address is REQUIRED, a bare node id doesn't resolve in the browser — CLAUDE.md
// 2026-07-25) so ANOTHER instance of the same identity resolves it and dials in, with
// no manual ticket copy. AppKey-derived, so it's private to your instances (only you
// can compute the key → only your instances publish/resolve it) and domain-separated
// from the public did:dht identity. The auto-discovery substrate for instance sync.
export async function deriveRendezvousSeed(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_rendezvous_seed(appKeyBytes)
}

// Per-instance rendezvous key. The multi-instance rendezvous is a small DIRECTORY
// record (under the rendezvous key) listing each live instance, plus each instance's
// full iroh DocTicket published under its OWN key derived here — because one pkarr
// packet (~1000 B) can't hold several full tickets. Derived from the RENDEZVOUS seed
// (not the AppKey) so it stays private to your instances; the instanceId is a public
// per-session salt, so both the advertiser and any resolver holding the rendezvous
// seed can derive the same per-instance key from a directory entry's id.
export async function deriveRendezvousInstanceSeed(
  rendezvousSeed: Uint8Array,
  instanceId: string,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_rendezvous_instance_seed(rendezvousSeed, instanceId)
}

export async function encryptSettings(
  key: Uint8Array,
  plaintext: string,
): Promise<string> {
  const json = new TextEncoder().encode(plaintext)
  if (SETTINGS_LENGTH_HEADER_BYTES + json.length > SETTINGS_PAD_SIZE) {
    // Loud, deliberate overflow — the signal to bump SETTINGS_PAD_SIZE and
    // ship expansion handling. Never silently truncate.
    throw new Error(
      `Settings payload (${json.length} B) exceeds the ${SETTINGS_PAD_SIZE} B fixed pad`,
    )
  }
  const padded = new Uint8Array(SETTINGS_PAD_SIZE)
  new DataView(padded.buffer).setUint32(0, json.length, false)
  padded.set(json, SETTINGS_LENGTH_HEADER_BYTES)
  return encryptBytes(key, padded)
}

export async function decryptSettings(
  key: Uint8Array,
  base64Ciphertext: string,
): Promise<string> {
  const padded = await decryptBytes(key, base64Ciphertext)
  if (padded.length < SETTINGS_LENGTH_HEADER_BYTES) {
    throw new Error('Decrypted settings blob too short for length header')
  }
  const len = new DataView(
    padded.buffer,
    padded.byteOffset,
    padded.byteLength,
  ).getUint32(0, false)
  if (SETTINGS_LENGTH_HEADER_BYTES + len > padded.length) {
    throw new Error('Settings length header exceeds blob size')
  }
  return new TextDecoder().decode(
    padded.slice(
      SETTINGS_LENGTH_HEADER_BYTES,
      SETTINGS_LENGTH_HEADER_BYTES + len,
    ),
  )
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

function base64Encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function base64Decode(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// RFC 4648 base32 (lowercase, no padding). Output is ATProto-rkey-safe.
function base32Encode(bytes: Uint8Array): string {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
  let out = ''
  let bits = 0
  let value = 0
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  return out
}
