import { describe, expect, it } from 'vitest'
import {
  channelKeyFromBase64,
  channelKeyToBase64,
  decryptForChannel,
  decryptSettings,
  deriveChannelID,
  deriveSettingsKey,
  encryptForChannel,
  encryptSettings,
  generateChannelKey,
  SETTINGS_PAD_SIZE,
} from './crypto'

describe('generateChannelKey', () => {
  it('produces 32 bytes', async () => {
    const key = await generateChannelKey()
    expect(key.length).toBe(32)
  })

  it('produces different keys on consecutive calls', async () => {
    const a = await generateChannelKey()
    const b = await generateChannelKey()
    expect(a).not.toEqual(b)
  })
})

describe('channelKeyToBase64 / channelKeyFromBase64', () => {
  it('round-trips a key', async () => {
    const original = await generateChannelKey()
    const b64 = channelKeyToBase64(original)
    const decoded = channelKeyFromBase64(b64)
    expect(decoded).toEqual(original)
  })

  it('throws on wrong-length input', () => {
    // 16 bytes encoded as base64 — half the expected 32.
    const tooShort = channelKeyToBase64(new Uint8Array(16))
    expect(() => channelKeyFromBase64(tooShort)).toThrow(/32 bytes/)
  })
})

describe('deriveChannelID', () => {
  it('produces a 16-character lowercase base32 string', async () => {
    const id = await deriveChannelID(await generateChannelKey())
    expect(id).toMatch(/^[a-z2-7]{16}$/)
  })

  it('is deterministic for the same key', async () => {
    const key = await generateChannelKey()
    const a = await deriveChannelID(key)
    const b = await deriveChannelID(key)
    expect(a).toBe(b)
  })

  it('produces different IDs for different keys', async () => {
    const a = await deriveChannelID(await generateChannelKey())
    const b = await deriveChannelID(await generateChannelKey())
    expect(a).not.toBe(b)
  })

  it('matches a fixed value for the all-zeros key (regression lock)', async () => {
    // SHA-256(00..00 × 32) → first 10 bytes → base32-rfc4648-lowercase.
    // Locking this prevents silent changes to the hash + base32 pipeline.
    const id = await deriveChannelID(new Uint8Array(32))
    expect(id).toBe('mzuhvlpymk6xo3ep')
  })
})

describe('encryptForChannel / decryptForChannel', () => {
  it('round-trips an ASCII string', async () => {
    const key = await generateChannelKey()
    const blob = await encryptForChannel(key, 'hello world')
    const plain = await decryptForChannel(key, blob)
    expect(plain).toBe('hello world')
  })

  it('round-trips a Unicode string', async () => {
    const key = await generateChannelKey()
    const blob = await encryptForChannel(key, 'héllo 🌍 世界')
    const plain = await decryptForChannel(key, blob)
    expect(plain).toBe('héllo 🌍 世界')
  })

  it('round-trips an empty string', async () => {
    const key = await generateChannelKey()
    const blob = await encryptForChannel(key, '')
    const plain = await decryptForChannel(key, blob)
    expect(plain).toBe('')
  })

  it('round-trips a 100KB string', async () => {
    const key = await generateChannelKey()
    const big = 'a'.repeat(100_000)
    const blob = await encryptForChannel(key, big)
    const plain = await decryptForChannel(key, blob)
    expect(plain).toBe(big)
  })

  it('produces different ciphertexts for the same plaintext (fresh IV per call)', async () => {
    const key = await generateChannelKey()
    const a = await encryptForChannel(key, 'same plaintext')
    const b = await encryptForChannel(key, 'same plaintext')
    expect(a).not.toBe(b)
  })

  it('throws when decrypting with the wrong key', async () => {
    const k1 = await generateChannelKey()
    const k2 = await generateChannelKey()
    const blob = await encryptForChannel(k1, 'secret')
    await expect(decryptForChannel(k2, blob)).rejects.toThrow()
  })

  it('throws when the blob is too short to contain version + IV + tag', async () => {
    const key = await generateChannelKey()
    // 28 bytes < 1 (version) + 12 (IV) + 16 (tag) = 29 minimum.
    const tooShort = channelKeyToBase64(new Uint8Array(28))
    await expect(decryptForChannel(key, tooShort)).rejects.toThrow(/too short/)
  })

  it('throws on unsupported version byte', async () => {
    const key = await generateChannelKey()
    const blob = await encryptForChannel(key, 'whatever')
    // Flip the version byte to something unsupported.
    const bytes = channelKeyFromBase64ToBytes(blob)
    bytes[0] = 99
    const corrupted = bytesToBase64(bytes)
    await expect(decryptForChannel(key, corrupted)).rejects.toThrow(/version/)
  })

  it('throws on tampered ciphertext (AES-GCM auth tag rejects)', async () => {
    const key = await generateChannelKey()
    const blob = await encryptForChannel(key, 'authentic')
    const bytes = channelKeyFromBase64ToBytes(blob)
    // Flip a bit in the ciphertext region (past version + IV).
    bytes[bytes.length - 1] ^= 0x01
    const corrupted = bytesToBase64(bytes)
    await expect(decryptForChannel(key, corrupted)).rejects.toThrow()
  })
})

describe('deriveSettingsKey', () => {
  it('produces 32 bytes', async () => {
    const k = await deriveSettingsKey(new Uint8Array(32))
    expect(k.length).toBe(32)
  })

  it('is deterministic for the same AppKey bytes', async () => {
    const appKey = crypto.getRandomValues(new Uint8Array(32))
    const a = await deriveSettingsKey(appKey)
    const b = await deriveSettingsKey(appKey)
    expect(a).toEqual(b)
  })

  it('differs for different AppKey bytes', async () => {
    const a = await deriveSettingsKey(
      crypto.getRandomValues(new Uint8Array(32)),
    )
    const b = await deriveSettingsKey(
      crypto.getRandomValues(new Uint8Array(32)),
    )
    expect(a).not.toEqual(b)
  })

  it('is not the raw AppKey (HKDF actually derives)', async () => {
    const appKey = new Uint8Array(32).fill(7)
    const derived = await deriveSettingsKey(appKey)
    expect(derived).not.toEqual(appKey)
  })

  it('matches a fixed value for the all-zeros AppKey (regression lock)', async () => {
    // Locks salt='' + info='pin:settings:v1' + SHA-256. A silent change to any
    // of those would re-key every user out of their existing settings record.
    const derived = await deriveSettingsKey(new Uint8Array(32))
    expect(toHex(derived)).toBe(
      '4f2fe2ca11018b920f3f99673cae4afab82044351d3de01a784a598d1b199aa2',
    )
  })
})

describe('encryptSettings / decryptSettings', () => {
  it('round-trips a JSON string', async () => {
    const key = await deriveSettingsKey(new Uint8Array(32).fill(1))
    const json = JSON.stringify({ version: 1, subscriptions: ['a', 'b'] })
    const blob = await encryptSettings(key, json)
    expect(await decryptSettings(key, blob)).toBe(json)
  })

  it('round-trips an empty string', async () => {
    const key = await deriveSettingsKey(new Uint8Array(32).fill(2))
    const blob = await encryptSettings(key, '')
    expect(await decryptSettings(key, blob)).toBe('')
  })

  it('round-trips Unicode', async () => {
    const key = await deriveSettingsKey(new Uint8Array(32).fill(3))
    const s = 'héllo 🌍 世界'
    const blob = await encryptSettings(key, s)
    expect(await decryptSettings(key, blob)).toBe(s)
  })

  it('emits a constant ciphertext length regardless of payload size', async () => {
    // The privacy property: a public, firehose-watchable record must not leak
    // channel/sub count via its size.
    const key = await deriveSettingsKey(new Uint8Array(32).fill(4))
    const small = await encryptSettings(key, 'x')
    const big = await encryptSettings(key, 'y'.repeat(50_000))
    expect(small.length).toBe(big.length)
  })

  it('produces different ciphertexts for the same plaintext (fresh IV)', async () => {
    const key = await deriveSettingsKey(new Uint8Array(32).fill(5))
    const a = await encryptSettings(key, 'same')
    const b = await encryptSettings(key, 'same')
    expect(a).not.toBe(b)
  })

  it('throws (loudly) when the payload exceeds the fixed pad', async () => {
    const key = await deriveSettingsKey(new Uint8Array(32).fill(6))
    const tooBig = 'z'.repeat(SETTINGS_PAD_SIZE + 1)
    await expect(encryptSettings(key, tooBig)).rejects.toThrow(/exceeds/)
  })

  it('throws when decrypting with the wrong key', async () => {
    const k1 = await deriveSettingsKey(new Uint8Array(32).fill(7))
    const k2 = await deriveSettingsKey(new Uint8Array(32).fill(8))
    const blob = await encryptSettings(k1, 'secret')
    await expect(decryptSettings(k2, blob)).rejects.toThrow()
  })
})

// Tiny helpers for the corruption tests. channelKeyFromBase64 enforces 32-byte
// length, which doesn't fit encrypted blobs — so we go through raw atob/btoa.
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function channelKeyFromBase64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
