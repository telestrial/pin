// What an upload yields.
//
// The byte operations that used to live here moved into Rust (crates/pin-sia), so
// one implementation serves the browser and the desktop, and the far-future share
// horizon is pinned there too. This type stays because it is the shape the rest of
// the app builds item refs from; every field on it — `contentHash` included — is
// filled in by pin-sia, which hashes the plaintext while it still holds it.

export type UploadedItem = {
  id: string
  itemURL: string
  byteSize: number
  // CIDv1 of the plaintext bytes — same input → same hash regardless of
  // re-encryption, so caches keyed on this survive repack URL swaps.
  contentHash: string
}
