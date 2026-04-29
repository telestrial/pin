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
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', key as BufferSource),
  )
  return base32Encode(hash.slice(0, CHANNEL_ID_HASH_BYTES))
}

export async function encryptForChannel(
  key: Uint8Array,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const cryptoKey = await importKey(key)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      new TextEncoder().encode(plaintext),
    ),
  )
  const out = new Uint8Array(1 + iv.length + ciphertext.length)
  out[0] = ENCRYPTION_VERSION
  out.set(iv, 1)
  out.set(ciphertext, 1 + iv.length)
  return base64Encode(out)
}

export async function decryptForChannel(
  key: Uint8Array,
  base64Ciphertext: string,
): Promise<string> {
  const all = base64Decode(base64Ciphertext)
  if (all.length < 1 + IV_BYTES + 16) {
    throw new Error('Encrypted blob too short to contain version + IV + auth tag')
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
  return new TextDecoder().decode(plaintext)
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
