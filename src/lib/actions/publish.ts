import { buildItemRef } from '../../core/channels'
import type { SiaClient } from '../../core/siaClient'
import type { AttachmentRef, ItemRef } from '../../core/types'
import { type PublishAction, useActionStore } from '../../stores/actionQueue'
import { useAuthStore } from '../../stores/auth'
import { usePinStore } from '../../stores/pin'
import { editPublishedItem, publishItemToChannel } from '../channelWrites'
import { LIBRARY_CHANNEL } from '../pinUpload'

const SLAB_DATA_BYTES = 10 * 4 * 1024 * 1024 // 10 data shards × 4 MiB each
const SHARDS_PER_SLAB = 30 // 10 data + 20 parity

function expectedShardCountForTotal(totalBytes: number): number {
  const slabs = Math.max(1, Math.ceil(totalBytes / SLAB_DATA_BYTES))
  return slabs * SHARDS_PER_SLAB
}

// An action failure the runner should record WITHOUT a toast. Used for guard
// conditions (channel gone, no agent) that already surface in the in-flight
// row's error text — a toast would be redundant noise.
export class SilentActionError extends Error {}

// What the runner hands a handler: the SDK plus id-bound store mutators. The
// handler reads auth/feed/pin via getState directly; it writes only progress,
// phase, and ledger through these (so persistence + UI stay consistent).
export type PublishContext = {
  client: SiaClient
  setPhase: (phase: string, progress?: number) => void
  setProgress: (progress: number) => void
  checkpoint: (uploadedItemRef: ItemRef) => void
  markPublished: (channelID: string) => void
}

// Run (or resume) a publish action. Flaky-leg-first: upload bytes to Sia and
// checkpoint BEFORE any manifest write, so a record never points at bytes that
// didn't land, and a Sia outage fails fast before anything commits. A resume
// with a checkpoint skips the upload entirely. Idempotent across resumes:
// publishedChannelIDs gates the per-channel loop so a crash mid-fan-out
// finishes only the channels it hadn't reached.
export async function runPublish(
  action: PublishAction,
  ctx: PublishContext,
): Promise<void> {
  const { client, setPhase, setProgress, checkpoint, markPublished } = ctx
  const intent = action.intent
  const auth = useAuthStore.getState()
  const pin = usePinStore.getState()

  // Channel destination needs at least one valid channel; library destination
  // doesn't (the bytes go to your Sia scope only).
  const channels =
    intent.destination === 'channel'
      ? intent.channelIDs
          .map((id) => auth.myChannels.find((c) => c.channelID === id))
          .filter((c): c is NonNullable<typeof c> => !!c)
      : []

  if (intent.destination === 'channel' && channels.length === 0) {
    throw new SilentActionError('Channel no longer exists')
  }

  // Resume fast-path: a checkpoint means the bytes are already on Sia, so skip
  // the (slow) re-upload and go straight to the manifest writes.
  let itemRef: ItemRef
  if (action.ledger.uploadedItemRef) {
    itemRef = action.ledger.uploadedItemRef
    setPhase('Publishing', 97)
  } else {
    setPhase('Uploading', 0)

    // Eager packing: collect every byte source for this action (bytes-kind
    // attachments + body) and bin-pack them through a single PackedUpload, so a
    // post + N small attachments share one slab instead of paying one each.
    // URL-shape attachments (already-uploaded library items) stay as-is.
    const sources = intent.payload.attachmentSources ?? []
    const bytesToUpload: Uint8Array[] = [
      ...sources.flatMap((s) => (s.kind === 'bytes' ? [s.bytes] : [])),
      intent.payload.bytes,
    ]
    const totalBytes = bytesToUpload.reduce((acc, b) => acc + b.length, 0)
    const totalExpected = expectedShardCountForTotal(totalBytes)
    let count = 0
    const onShard = () => {
      count += 1
      setProgress(Math.min(95, (count / totalExpected) * 100))
    }

    const uploadedItems = await client.uploadItemsPacked(bytesToUpload, onShard)

    // Map results back to attachmentRefs in the original sources order;
    // URL-shape attachments interleave with the freshly-packed ones.
    const attachmentRefs: AttachmentRef[] = []
    let bytesIdx = 0
    for (const src of sources) {
      if (src.kind === 'url') {
        attachmentRefs.push({
          url: src.url,
          mimeType: src.mimeType,
          filename: src.filename,
          byteSize: src.byteSize,
          contentHash: src.contentHash,
          objectID: src.objectID,
        })
      } else {
        const u = uploadedItems[bytesIdx++]
        attachmentRefs.push({
          url: u.itemURL,
          mimeType: src.mimeType,
          filename: src.filename,
          byteSize: src.bytes.length,
          contentHash: u.contentHash,
          objectID: u.id,
        })
      }
    }
    // The body was added last to the packed upload, so it's at the tail.
    const uploaded = uploadedItems[bytesIdx]

    const resolvedPayload = {
      ...intent.payload,
      attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
      attachmentSources: undefined,
    }
    itemRef = await buildItemRef(uploaded, resolvedPayload)

    // Checkpoint before any manifest write. The bytes are committed, so a crash
    // in the publish loop below resumes from here without re-uploading;
    // publishedAt is frozen in itemRef from this moment.
    checkpoint(itemRef)
    setPhase('Publishing', 97)
  }

  if (intent.destination === 'library') {
    // itemRef.itemURL is stable across resumes (from the checkpoint) and
    // pinStore dedups library pins by URL, so a resumed pin is idempotent.
    await pin.pin(client, { item: itemRef, channel: LIBRARY_CHANNEL })
  } else {
    // Publishing to a channel no longer touches atproto — each write commits the
    // manifest to the channel's pkarr locator (Sia object + DHT pointer) and
    // reflects it in the feed store.
    const alreadyPublished = new Set(action.ledger.publishedChannelIDs ?? [])
    // Old-version bytes an edit orphans (same body objectID across channels →
    // deduped before journaling).
    const orphanedFromEdits = new Set<string>()
    for (const ch of channels) {
      // Skip channels a prior run already wrote to — the resume guard against
      // a mid-loop crash double-appending.
      if (alreadyPublished.has(ch.channelID)) continue
      if (intent.editingItemID) {
        // editItem preserves publishedAt from the original; stamp editedAt.
        const editedItem: ItemRef = {
          ...itemRef,
          editedAt: new Date().toISOString(),
        }
        const { orphanedObjectIDs } = await editPublishedItem(
          client,
          ch,
          intent.editingItemID,
          editedItem,
          intent.removedAttachmentObjectIDs,
        )
        for (const id of orphanedObjectIDs) orphanedFromEdits.add(id)
      } else {
        await publishItemToChannel(client, ch, itemRef)
      }
      // Record this channel as done (and persist) before the next one.
      markPublished(ch.channelID)
    }
    // Reclaim the replaced bytes via the journal (durable, retried).
    if (orphanedFromEdits.size > 0) {
      useActionStore.getState().enqueueDeleteObjects({
        objectIDs: [...orphanedFromEdits],
        label: `Reclaiming old version of “${itemRef.title || 'post'}”`,
      })
    }
  }
}
