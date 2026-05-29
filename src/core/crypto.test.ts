import { describe, expect, it } from 'vitest'
import {
  channelKeyFromBase64,
  channelKeyToBase64,
  decryptForChannel,
  deriveChannelID,
  encryptForChannel,
  generateChannelKey,
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

// Tiny helpers for the corruption tests. channelKeyFromBase64 enforces 32-byte
// length, which doesn't fit encrypted blobs — so we go through raw atob/btoa.
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
