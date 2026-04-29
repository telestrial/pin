// Channel-key cryptography. AES-GCM-256 via Web Crypto API; no external dep.
// Format: base64(12-byte IV || ciphertext-with-16-byte-tag).

const KEY_BYTES = 32
const IV_BYTES = 12

export async function generateChannelKey(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES))
}

export function channelKeyToBase64(key: Uint8Array): string {
  return base64Encode(key)
}

export function channelKeyFromBase64(b64: string): Uint8Array {
  const bytes = base64Decode(b64)
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`Channel key must be ${KEY_BYTES} bytes; got ${bytes.length}`)
  }
  return bytes
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
  const out = new Uint8Array(iv.length + ciphertext.length)
  out.set(iv, 0)
  out.set(ciphertext, iv.length)
  return base64Encode(out)
}

export async function decryptForChannel(
  key: Uint8Array,
  base64Ciphertext: string,
): Promise<string> {
  const all = base64Decode(base64Ciphertext)
  if (all.length < IV_BYTES + 16) {
    throw new Error('Ciphertext too short to contain IV + auth tag')
  }
  const iv = all.slice(0, IV_BYTES)
  const ciphertext = all.slice(IV_BYTES)
  const cryptoKey = await importKey(key)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext,
  )
  return new TextDecoder().decode(plaintext)
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  )
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
