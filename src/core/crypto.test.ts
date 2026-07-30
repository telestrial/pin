import { describe, expect, it } from 'vitest'
import {
  channelKeyFromBase64,
  channelKeyToBase64,
  decryptForChannel,
  decryptSettings,
  deriveChannelDocSeed,
  deriveChannelDocTicketSeed,
  deriveChannelID,
  deriveChannelLocatorSeed,
  deriveDidDhtSeed,
  deriveSettingsKey,
  deriveSettingsLocatorSeed,
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

describe('deriveDidDhtSeed', () => {
  it('produces a 32-byte ed25519 seed', async () => {
    const seed = await deriveDidDhtSeed(new Uint8Array(32))
    expect(seed.length).toBe(32)
  })

  it('is deterministic for the same AppKey bytes', async () => {
    const appKey = crypto.getRandomValues(new Uint8Array(32))
    const a = await deriveDidDhtSeed(appKey)
    const b = await deriveDidDhtSeed(appKey)
    expect(a).toEqual(b)
  })

  it('differs from the settings key for the same AppKey (domain separation)', async () => {
    const appKey = new Uint8Array(32).fill(9)
    const seed = await deriveDidDhtSeed(appKey)
    const settings = await deriveSettingsKey(appKey)
    expect(seed).not.toEqual(settings)
  })

  it('matches a fixed value for the all-zeros AppKey (regression lock)', async () => {
    // Locks salt='' + info='pin:did-dht:v1' + SHA-256, which MUST equal the Rust
    // Curator's HKDF (identity.rs) so the browser derives the SAME did:dht. A silent
    // change here would split the browser identity from the Curator's.
    const seed = await deriveDidDhtSeed(new Uint8Array(32))
    expect(toHex(seed)).toBe(
      '30ff7f7764196617f118404f0b5b1c98298adf7aafcd54a86c92173d06682256',
    )
  })
})

describe('deriveChannelLocatorSeed', () => {
  it('produces a 32-byte ed25519 seed', async () => {
    const seed = await deriveChannelLocatorSeed(new Uint8Array(32))
    expect(seed.length).toBe(32)
  })

  it('is deterministic for the same channel key', async () => {
    const k = await generateChannelKey()
    expect(await deriveChannelLocatorSeed(k)).toEqual(
      await deriveChannelLocatorSeed(k),
    )
  })

  it('differs per channel key (each channel has its own locator)', async () => {
    const a = await deriveChannelLocatorSeed(await generateChannelKey())
    const b = await deriveChannelLocatorSeed(await generateChannelKey())
    expect(a).not.toEqual(b)
  })

  it('differs from the did:dht seed for the same bytes (domain separation)', async () => {
    const bytes = new Uint8Array(32).fill(5)
    expect(await deriveChannelLocatorSeed(bytes)).not.toEqual(
      await deriveDidDhtSeed(bytes),
    )
  })

  it('matches a fixed value for the all-zeros key (regression lock)', async () => {
    // Locks salt='' + info='pin:channel-locator:v1' + SHA-256 — the canonical
    // channel-locator derivation a reader (and any future Curator) must reproduce.
    const seed = await deriveChannelLocatorSeed(new Uint8Array(32))
    expect(toHex(seed)).toBe(
      '78aa2d69cfe77badc0d0d7cd976e0c1b6c3fe4964958145793d153b03a3442eb',
    )
  })
})

describe('deriveSettingsLocatorSeed', () => {
  it('produces a 32-byte ed25519 seed', async () => {
    const seed = await deriveSettingsLocatorSeed(new Uint8Array(32))
    expect(seed.length).toBe(32)
  })

  it('is deterministic for the same AppKey (recovery: a fresh device must re-derive the same locator)', async () => {
    const appKey = crypto.getRandomValues(new Uint8Array(32))
    expect(await deriveSettingsLocatorSeed(appKey)).toEqual(
      await deriveSettingsLocatorSeed(appKey),
    )
  })

  it('differs from the settings key, did:dht seed, and channel locator for the same bytes (domain separation)', async () => {
    const bytes = new Uint8Array(32).fill(7)
    const locator = await deriveSettingsLocatorSeed(bytes)
    expect(locator).not.toEqual(await deriveSettingsKey(bytes))
    expect(locator).not.toEqual(await deriveDidDhtSeed(bytes))
    expect(locator).not.toEqual(await deriveChannelLocatorSeed(bytes))
  })

  it('matches a fixed value for the all-zeros AppKey (regression lock)', async () => {
    // Locks salt='' + info='pin:settings-locator:v1' + SHA-256. A silent change
    // here would move every existing user's settings pointer on the DHT, breaking
    // fresh-device recovery — the whole point of the durable locator.
    const seed = await deriveSettingsLocatorSeed(new Uint8Array(32))
    expect(toHex(seed)).toBe(
      '049e8a3f64287d45448ab3fc4dfbdd1e27ab9858ce4262abd7c9163841031689',
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

describe('deriveChannelDocSeed', () => {
  it('produces a 32-byte namespace seed', async () => {
    const seed = await deriveChannelDocSeed(new Uint8Array(32), 'chan1')
    expect(seed.length).toBe(32)
  })

  it('is deterministic for the same AppKey + channelID', async () => {
    const appKey = new Uint8Array(32).fill(9)
    expect(await deriveChannelDocSeed(appKey, 'chan1')).toEqual(
      await deriveChannelDocSeed(appKey, 'chan1'),
    )
  })

  it('differs per channelID, so an authors channels are separate docs', async () => {
    const appKey = new Uint8Array(32).fill(9)
    expect(await deriveChannelDocSeed(appKey, 'chan1')).not.toEqual(
      await deriveChannelDocSeed(appKey, 'chan2'),
    )
  })

  it('differs per AppKey, so two authors never collide on a namespace', async () => {
    expect(
      await deriveChannelDocSeed(new Uint8Array(32).fill(1), 'chan1'),
    ).not.toEqual(
      await deriveChannelDocSeed(new Uint8Array(32).fill(2), 'chan1'),
    )
  })

  it('is NOT derivable from the channel key (write capability stays with the author)', async () => {
    // The load-bearing asymmetry: an iroh-docs namespace secret IS the write
    // capability. If this seed came from K, every subscriber could write to the
    // author's channel doc. Deriving from the AppKey is what prevents that, so a
    // K-derived seed must never equal it.
    const k = await generateChannelKey()
    expect(await deriveChannelDocSeed(k, 'chan1')).not.toEqual(
      await deriveChannelLocatorSeed(k),
    )
  })

  it('matches a fixed value for the all-zeros AppKey (regression lock)', async () => {
    // Locks salt='' + info='pin:channel-doc-ns:v1:' + channelID + SHA-256. Both
    // engines open the same channel doc from this seed, so it can't drift.
    const seed = await deriveChannelDocSeed(new Uint8Array(32), 'chan1')
    expect(toHex(seed)).toBe(
      '8b7ef12a1bfb3e697bf2f4a7fb60226b788a61dc1a9b6f9c2685b546a0230875',
    )
  })
})

describe('deriveChannelDocTicketSeed', () => {
  it('produces a 32-byte ed25519 seed', async () => {
    const seed = await deriveChannelDocTicketSeed(new Uint8Array(32))
    expect(seed.length).toBe(32)
  })

  it('is deterministic, so a subscriber finds the ticket the author published', async () => {
    const k = await generateChannelKey()
    expect(await deriveChannelDocTicketSeed(k)).toEqual(
      await deriveChannelDocTicketSeed(k),
    )
  })

  it('differs from the channel locator seed (independent records)', async () => {
    // The ticket and the locator are two rungs with independent lifetimes — a stale
    // ticket must not be able to disturb the durable Sia pointer.
    const k = await generateChannelKey()
    expect(await deriveChannelDocTicketSeed(k)).not.toEqual(
      await deriveChannelLocatorSeed(k),
    )
  })

  it('matches a fixed value for the all-zeros key (regression lock)', async () => {
    const seed = await deriveChannelDocTicketSeed(new Uint8Array(32))
    expect(toHex(seed)).toBe(
      'c8086ddb2912104f75754ad8a02736187c74d6a08c8705bb883370f7f32beea9',
    )
  })
})
