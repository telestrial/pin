import { useEffect } from 'react'
import {
  appendItemToChannel,
  buildItemRef,
  editItem,
} from '../core/channels'
import { uploadItemsPacked } from '../core/sia'
import type { AttachmentRef, ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import {
  type UploadTask,
  useUploadQueueStore,
} from '../stores/uploadQueue'
import { LIBRARY_CHANNEL } from './pinUpload'

const SUCCESS_AUTO_REMOVE_MS = 4000

const SLAB_DATA_BYTES = 10 * 4 * 1024 * 1024 // 10 data shards × 4 MiB each
const SHARDS_PER_SLAB = 30 // 10 data + 20 parity

function expectedShardCountForTotal(totalBytes: number): number {
  const slabs = Math.max(1, Math.ceil(totalBytes / SLAB_DATA_BYTES))
  return slabs * SHARDS_PER_SLAB
}

function displayTitle(task: UploadTask): string {
  const p = task.payload
  if (p.title) return p.title
  if (p.summary) return p.summary.slice(0, 60)
  if (p.filename) return p.filename
  return 'item'
}

export function useUploadRunner() {
  const sdk = useAuthStore((s) => s.sdk)

  useEffect(() => {
    // Library uploads (destination: 'library') only need the Sia SDK —
    // no atproto manifest write. Channel uploads need an agent too,
    // checked inside runOne so a missing agent fails just that task
    // instead of silently parking the whole queue.
    if (!sdk) return
    let running = false

    const processNext = async () => {
      if (running) return
      const queue = useUploadQueueStore.getState()
      const task = queue.tasks.find((t) => t.state === 'pending')
      if (!task) return
      running = true
      try {
        await runOne(task)
      } finally {
        running = false
        processNext()
      }
    }

    const runOne = async (task: UploadTask) => {
      const queue = useUploadQueueStore.getState()
      const auth = useAuthStore.getState()
      const feed = useFeedStore.getState()
      const toast = useToastStore.getState()
      const pin = usePinStore.getState()

      // Channel destination needs at least one valid channel; library
      // destination doesn't (the bytes go to your Sia scope only).
      const channels =
        task.destination === 'channel'
          ? task.channelIDs
              .map((id) => auth.myChannels.find((c) => c.channelID === id))
              .filter((c): c is NonNullable<typeof c> => !!c)
          : []

      if (task.destination === 'channel' && channels.length === 0) {
        queue.setState(task.id, 'failed', 'Channel no longer exists')
        return
      }

      if (task.destination === 'channel' && !auth.atprotoAgent) {
        queue.setState(
          task.id,
          'failed',
          'Sign in to Bluesky to publish to a channel',
        )
        return
      }

      queue.setState(task.id, 'uploading', undefined)

      try {
        // Eager packing: collect every byte source for this task (attachments
        // with kind='bytes' + body) and bin-pack them through a single
        // PackedUpload. A post + 3 image attachments that fit in one 40 MiB
        // slab now consumes one slab of pinnedData instead of four. URL-shape
        // attachments (already-uploaded library items) stay as-is.
        const sources = task.payload.attachmentSources ?? []
        const bytesToUpload: Uint8Array[] = [
          ...sources.flatMap((s) => (s.kind === 'bytes' ? [s.bytes] : [])),
          task.payload.bytes,
        ]
        const totalBytes = bytesToUpload.reduce((acc, b) => acc + b.length, 0)
        const totalExpected = expectedShardCountForTotal(totalBytes)
        let count = 0
        const onShard = () => {
          count += 1
          const pct = Math.min(95, (count / totalExpected) * 100)
          useUploadQueueStore.getState().setProgress(task.id, pct)
        }

        const uploadedItems = await uploadItemsPacked(
          sdk,
          bytesToUpload,
          onShard,
        )

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
        // The body was added last to the packed upload, so it's at the
        // tail of uploadedItems.
        const uploaded = uploadedItems[bytesIdx]

        queue.setState(task.id, 'publishing', undefined)
        useUploadQueueStore.getState().setProgress(task.id, 97)

        const resolvedPayload = {
          ...task.payload,
          attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
          attachmentSources: undefined,
        }
        const itemRef = buildItemRef(uploaded, resolvedPayload)

        if (task.destination === 'library') {
          await pin.pin(sdk, { item: itemRef, channel: LIBRARY_CHANNEL })
        } else {
          // Non-null per the agent guard above for channel destinations.
          const agent = auth.atprotoAgent!
          for (const ch of channels) {
            if (task.editingItemID) {
              // editItem preserves publishedAt from the original; the
              // caller stamps editedAt on the pre-built ItemRef.
              const editedItem: ItemRef = {
                ...itemRef,
                editedAt: new Date().toISOString(),
              }
              await editItem(
                sdk,
                agent,
                ch,
                task.editingItemID,
                editedItem,
                task.removedAttachmentObjectIDs,
              )
            } else {
              await appendItemToChannel(agent, ch, itemRef)
            }
            const sub = auth.subscriptions.find(
              (s) => s.channelID === ch.channelID,
            )
            if (sub) feed.refreshChannel(sub)
          }
        }

        useUploadQueueStore.getState().setProgress(task.id, 100)
        queue.setState(task.id, 'success', undefined)
        toast.addToast(
          task.destination === 'library'
            ? `Pinned “${displayTitle(task)}”`
            : task.editingItemID
              ? `Saved “${displayTitle(task)}”`
              : `Published “${displayTitle(task)}”`,
        )

        setTimeout(() => {
          useUploadQueueStore.getState().remove(task.id)
        }, SUCCESS_AUTO_REMOVE_MS)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to publish'
        queue.setState(task.id, 'failed', msg)
        toast.addToast(
          task.destination === 'library'
            ? `Pin failed: ${msg}`
            : task.editingItemID
              ? `Save failed: ${msg}`
              : `Publish failed: ${msg}`,
        )
      }
    }

    const unsub = useUploadQueueStore.subscribe(() => {
      processNext()
    })

    processNext()

    return unsub
  }, [sdk])
}
