import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

// Plaintext content fingerprint, formatted as a CIDv1 with raw codec +
// SHA-256. Stable across re-encryption (so it survives repack) and across
// access regimes (private K-encrypted manifests today, public manifests
// later, per-recipient envelopes later still — none change the plaintext).
//
// Self-describing: a future migration to e.g. BLAKE3 just emits a
// different multihash prefix; old CIDs keep parsing alongside.
//
// Used as the cache key (memCache, IndexedDB) and React key whenever
// present, with itemURL / item.id as the legacy fallback.
export async function computeContentHash(bytes: Uint8Array): Promise<string> {
  const hash = await sha256.digest(bytes)
  const cid = CID.create(1, raw.code, hash)
  return cid.toString()
}
