// Channel-key cryptography — a binding layer now, not an implementation.
//
// Both halves live in Rust and are reached through pin-core: `pin_derive` owns every
// HKDF `info` string, and `pin_crypto` owns the encrypted-blob envelope (1-byte
// version || 12-byte nonce || AES-256-GCM ciphertext-with-tag, base64) plus the
// fixed-size settings padding. The Curator runs the same code natively, so a user's
// did:dht — and the format their manifests are sealed in — is ONE definition rather
// than two that a comment asks to stay in step.
//
// What stays here is what has no second implementation to drift from: key generation,
// the base64/base32 encodings, and the rkey derivation.

import {
  decrypt_for_channel,
  decrypt_settings,
  derive_channel_doc_seed,
  derive_channel_doc_ticket_seed,
  derive_channel_locator_seed,
  derive_did_dht_seed,
  derive_rendezvous_instance_seed,
  derive_rendezvous_seed,
  derive_settings_key,
  derive_settings_locator_seed,
  derive_snapshot_key,
  encrypt_for_channel,
  encrypt_settings,
  settings_pad_size,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from './wasm'

const KEY_BYTES = 32

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

export async function encryptForChannel(
  key: Uint8Array,
  plaintext: string,
): Promise<string> {
  await ensureWasm()
  return encrypt_for_channel(key, plaintext)
}

export async function decryptForChannel(
  key: Uint8Array,
  base64Ciphertext: string,
): Promise<string> {
  await ensureWasm()
  return decrypt_for_channel(key, base64Ciphertext)
}

// --- Settings encryption -------------------------------------------------
//
// Settings carry their own encryption because — unlike a channel manifest, whose K is
// shared deliberately — this key is never shared with anyone. It's derived from the
// Sia AppKey, which is what makes the whole account recoverable from the recovery
// phrase alone.
//
// The plaintext is padded to a FIXED size before sealing, because the ciphertext's
// LENGTH is observable even where its content isn't: the record rides in the synced
// doc replica and in the Sia snapshot, both of which are held as opaque bytes by
// anything mirroring them, and an unpadded blob would leak how many channels and
// subscriptions it holds. Fixed padding leaks nothing at any pad size, so 128 KiB is
// chosen for headroom (~400+ entries against a friend-scale handful), not secrecy.
//
// The size, the layout and the loud overflow all live in pin-crypto; this reads the
// constant from there rather than keeping a copy that could fall out of step with the
// padding it describes.
export async function settingsPadSize(): Promise<number> {
  await ensureWasm()
  return settings_pad_size()
}

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
  await ensureWasm()
  return encrypt_settings(key, plaintext)
}

export async function decryptSettings(
  key: Uint8Array,
  base64Ciphertext: string,
): Promise<string> {
  await ensureWasm()
  return decrypt_settings(key, base64Ciphertext)
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
