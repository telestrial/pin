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
  channel_id,
  decrypt_for_channel,
  decrypt_settings,
  derive_channel_doc_seed,
  derive_channel_doc_ticket_seed,
  derive_channel_locator_seed,
  derive_did_dht_seed,
  derive_pinned_key,
  derive_published_key,
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

// A channel's public identifier, derived from its key: base32(sha256(K))[:16], 80 bits
// of entropy. Derived rather than stored, so anyone holding K arrives at the same name
// without being told it — which is also why it's one implementation and not two.
//
// This used to go through a generic `deriveAtRkey(bytes | string)`, generalized for the
// atproto subscription records that keyed on a subject AT-URI. Those records left with
// atproto, so the generalization had one caller and no second shape to serve.
export async function deriveChannelID(key: Uint8Array): Promise<string> {
  await ensureWasm()
  return channel_id(key)
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

// Publish-state key — what this identity has published to Sia, and which object each
// pointer names. Those records carry share URLs, and a share URL's fragment IS the
// object's decryption key, so they get their own domain rather than the settings one.
export async function derivePublishedKey(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_published_key(appKeyBytes)
}

// Pin-record key — what this identity keeps. Same reasoning as publish state: these
// records name their Sia objects by share URL, so they're as secret as the bytes.
export async function derivePinnedKey(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm()
  return derive_pinned_key(appKeyBytes)
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

// The base32 that used to live here went with deriveChannelID — a hand-rolled alphabet
// and bit-packing loop is exactly the kind of Pin-invented format that shouldn't exist
// twice. Base64 stays: it's a standard both sides implement, not a format we defined.
