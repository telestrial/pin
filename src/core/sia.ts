// What an upload yields.
//
// The byte operations that used to live here moved into Rust (crates/pin-sia), so
// one implementation serves the browser and the desktop, and the far-future share
// horizon is pinned there too. This type stays because it is the shape the rest of
// the app builds item refs from — and because `contentHash` is added on this side:
// it is a hash of the plaintext, belonging to the channel layer rather than to Sia.

export type UploadedItem = {
  id: string
  itemURL: string
  byteSize: number
  // CIDv1 of the plaintext bytes — same input → same hash regardless of
  // re-encryption, so caches keyed on this survive repack URL swaps.
  contentHash: string
}
