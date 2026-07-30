// Channel-key cryptography. AES-GCM-256 via Web Crypto API; no external dep.
// Encrypted blob format: 1-byte version || 12-byte IV || ciphertext-with-16-byte-tag.

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
const SETTINGS_KEY_INFO = 'pin:settings:v1'

// HKDF-SHA256 over the raw AppKey bytes, domain-separated by `info`. Deterministic,
// so every derived subkey is re-derivable from the Sia recovery phrase alone after
// a localStorage wipe — the recovery path. (Domain-separated from the ed25519
// signing use, which lives in the Curator.)
async function deriveAppSubkey(
  appKeyBytes: Uint8Array,
  info: string,
): Promise<Uint8Array> {
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    appKeyBytes as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    hkdfKey,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

export async function deriveSettingsKey(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  return deriveAppSubkey(appKeyBytes, SETTINGS_KEY_INFO)
}

// docsMirror snapshot key — the whole-doc Sia snapshot is encrypted under this
// (its record keys would otherwise leak channel/collection structure). Same
// derivation family as settings, different domain. Never shared.
const SNAPSHOT_KEY_INFO = 'pin:docsnapshot:v1'
export async function deriveSnapshotKey(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  return deriveAppSubkey(appKeyBytes, SNAPSHOT_KEY_INFO)
}

// The 32-byte ed25519 seed for this identity's did:dht key. MUST match the Rust
// Curator's derivation byte-for-byte (identity.rs: HKDF-SHA256, empty salt, info
// `pin:did-dht:v1`) so the browser's pkarr identity IS the Curator's did:dht — one
// identity across both. Web Crypto's empty-salt HKDF equals Rust's `Hkdf::new(None,
// …)` (HMAC pads any sub-block-size key with zeros, so empty == HashLen-zeros salt).
// The seed feeds pkarr's `Keypair.from_secret_key` (in lib/pkarr.ts, needs the wasm);
// kept here as the pure, testable derivation half.
const DID_DHT_KEY_INFO = 'pin:did-dht:v1'
export async function deriveDidDhtSeed(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  return deriveAppSubkey(appKeyBytes, DID_DHT_KEY_INFO)
}

// The 32-byte ed25519 seed for a channel's pkarr LOCATOR key — derived from the
// channel key K (NOT the AppKey), because a reader only holds K (from the subscribe
// URL) and must derive the same locator to resolve the channel's Sia pointer. So K
// both locates (this key → pkarr record → Sia URL) and decrypts (the manifest). This
// is the canonical definition; a future Curator that publishes channel locators must
// match it. Same HKDF family, different `info` + a different IKM (K, not AppKey).
const CHANNEL_LOCATOR_KEY_INFO = 'pin:channel-locator:v1'
export async function deriveChannelLocatorSeed(
  channelKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  return deriveAppSubkey(channelKeyBytes, CHANNEL_LOCATOR_KEY_INFO)
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
const CHANNEL_DOC_NS_KEY_INFO = 'pin:channel-doc-ns:v1:'
export async function deriveChannelDocSeed(
  appKeyBytes: Uint8Array,
  channelID: string,
): Promise<Uint8Array> {
  return deriveAppSubkey(appKeyBytes, CHANNEL_DOC_NS_KEY_INFO + channelID)
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
const CHANNEL_DOC_TICKET_KEY_INFO = 'pin:channel-doc:v1'
export async function deriveChannelDocTicketSeed(
  channelKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  return deriveAppSubkey(channelKeyBytes, CHANNEL_DOC_TICKET_KEY_INFO)
}

// The 32-byte ed25519 seed for your SETTINGS pkarr LOCATOR key — the mutable
// pointer to the current encrypted settings snapshot on Sia lives on the DHT under
// this key. AppKey-derived, so it's unlisted (only you can compute it → only you can
// find your settings pointer, exactly like a channel locator) and domain-separated
// from the PUBLIC did:dht identity, so resolving someone's did:dht never surfaces
// their settings pointer. Recoverable from the recovery phrase alone — the durable
// replacement for the device-local localStorage pointer.
const SETTINGS_LOCATOR_KEY_INFO = 'pin:settings-locator:v1'
export async function deriveSettingsLocatorSeed(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  return deriveAppSubkey(appKeyBytes, SETTINGS_LOCATOR_KEY_INFO)
}

// The 32-byte ed25519 seed for your instance-RENDEZVOUS pkarr key — where an instance
// of this identity publishes its current iroh DocTicket (node id + relay addr; an
// address is REQUIRED, a bare node id doesn't resolve in the browser — CLAUDE.md
// 2026-07-25) so ANOTHER instance of the same identity resolves it and dials in, with
// no manual ticket copy. AppKey-derived, so it's private to your instances (only you
// can compute the key → only your instances publish/resolve it) and domain-separated
// from the public did:dht identity. The auto-discovery substrate for instance sync.
const RENDEZVOUS_KEY_INFO = 'pin:iroh-rendezvous:v1'
export async function deriveRendezvousSeed(
  appKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  return deriveAppSubkey(appKeyBytes, RENDEZVOUS_KEY_INFO)
}

// Per-instance rendezvous key. The multi-instance rendezvous is a small DIRECTORY
// record (under the rendezvous key) listing each live instance, plus each instance's
// full iroh DocTicket published under its OWN key derived here — because one pkarr
// packet (~1000 B) can't hold several full tickets. Derived from the RENDEZVOUS seed
// (not the AppKey) so it stays private to your instances; the instanceId is a public
// per-session salt, so both the advertiser and any resolver holding the rendezvous
// seed can derive the same per-instance key from a directory entry's id.
const RENDEZVOUS_INSTANCE_KEY_INFO = 'pin:iroh-rendezvous-instance:v1:'
export async function deriveRendezvousInstanceSeed(
  rendezvousSeed: Uint8Array,
  instanceId: string,
): Promise<Uint8Array> {
  return deriveAppSubkey(
    rendezvousSeed,
    RENDEZVOUS_INSTANCE_KEY_INFO + instanceId,
  )
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
