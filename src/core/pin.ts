import type { SiaClient } from './siaClient'
import { type ItemRef, isValidAttachment } from './types'

export type AccountSnapshot = {
  pinnedData: number
  pinnedSize: number
  // Actual content bytes across every pinned object in this AppKey's scope —
  // post bodies, attachments, channel covers, profile assets, the settings
  // record, all of it. Summed from slab lengths by the walk in crates/pin-sia,
  // so it accounts for everything Sia holds without any byteSize-from-manifest
  // guesswork.
  rawContentBytes: number
  maxPinnedData: number
  remainingStorage: number
  fetchedAt: string
}

// Pin a whole item — the body plus every valid attachment. Each is its own
// content-addressed Sia object, so each gets its own sharedObject + pinObject.
// Returns the body objectID plus the attachment objectIDs so unpin can release
// all of them. This is what makes a pinned copy *whole*: custody keeps the
// post's images/audio/files alive even if the author later retracts. Body is
// pinned first (throws on failure → caller treats the pin as failed); a failed
// attachment propagates too, and the already-pinned body becomes a stray the
// orphan sweep reclaims after its age gate — a retry re-pins idempotently.
export async function pinItem(
  client: SiaClient,
  item: ItemRef,
): Promise<{ objectID: string; attachmentObjectIDs: string[] }> {
  const { objectID } = await client.pinFromShareURL(item.itemURL)
  const attachmentObjectIDs: string[] = []
  for (const att of item.attachments ?? []) {
    if (!isValidAttachment(att)) continue
    const { objectID: aid } = await client.pinFromShareURL(att.url)
    attachmentObjectIDs.push(aid)
  }
  return { objectID, attachmentObjectIDs }
}

// Releasing a whole item (body + its attachment objects) is orchestrated by the
// pinStore, not here: with granular pinning a file's bytes can be held by both a
// whole-post pin and a standalone library pin, so unpin is reference-aware — it
// deletes only the object IDs no other pin still references. That refcount is
// derived from the store's pinned[] array, so the store calls client.deleteObject
// per safe id rather than an aggregate helper.
