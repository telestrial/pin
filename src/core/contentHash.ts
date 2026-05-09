// Plaintext content fingerprint, formatted as a CIDv1 with raw codec +
// SHA-256. Stable across re-encryption (so it survives repack) and across
// access regimes (private K-encrypted manifests today, public manifests
// later, per-recipient envelopes later still — none change the plaintext).
//
// Format breakdown of the resulting string (base32, multibase prefix 'b'):
//   - multibase: 'b' + base32(no padding, lowercase) of:
//   - CIDv1: 0x01 (version) || 0x55 (raw codec) || multihash
//   - multihash: 0x12 (sha2-256 code) || 0x20 (32-byte digest length) || digest
//
// Self-describing: a future migration to e.g. BLAKE3 just emits a
// different multihash code; old CIDs keep parsing alongside.
//
// Used as the cache key (memCache, IndexedDB) and React key whenever
// present, with itemURL / item.id as the legacy fallback.

const CID_VERSION_1 = 0x01
const CODEC_RAW = 0x55
const MULTIHASH_SHA2_256 = 0x12
const SHA256_DIGEST_LEN = 0x20

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  return out
}

export async function computeContentHash(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so SubtleCrypto sees a clean view —
  // some byte sources are slices of larger buffers and a few browsers
  // get unhappy passing those through digest().
  const input = new Uint8Array(bytes.length)
  input.set(bytes)
  const digestBuf = await crypto.subtle.digest('SHA-256', input)
  const digest = new Uint8Array(digestBuf)

  const cidBytes = new Uint8Array(4 + SHA256_DIGEST_LEN)
  cidBytes[0] = CID_VERSION_1
  cidBytes[1] = CODEC_RAW
  cidBytes[2] = MULTIHASH_SHA2_256
  cidBytes[3] = SHA256_DIGEST_LEN
  cidBytes.set(digest, 4)

  return `b${base32Encode(cidBytes)}`
}
