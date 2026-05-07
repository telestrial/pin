import { useEffect } from 'react'
import { appendItemToChannel, buildItemRef } from '../core/channels'
import { uploadItem } from '../core/sia'
import type { AttachmentRef } from '../core/types'
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

function expectedShardCount(byteSize: number): number {
  const slabDataBytes = 10 * 4 * 1024 * 1024
  const slabs = Math.max(1, Math.ceil(byteSize / slabDataBytes))
  return slabs * 30
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
  const agent = useAuthStore((s) => s.atprotoAgent)

  useEffect(() => {
    if (!sdk || !agent) return
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

      queue.setState(task.id, 'uploading', undefined)

      try {
        // Sequential upload: each attachment-with-bytes, then body. Parallel
        // would be faster for multi-file posts but adds bookkeeping (per-source
        // progress, error aggregation); revisit when a real "this felt slow"
        // moment shows up.
        const sources = task.payload.attachmentSources ?? []
        const allByteSizes = [
          ...sources.flatMap((s) => (s.kind === 'bytes' ? [s.bytes.length] : [])),
          task.payload.bytes.length,
        ]
        const totalExpected = allByteSizes.reduce(
          (acc, n) => acc + expectedShardCount(n),
          0,
        )
        let count = 0
        const onShard = () => {
          count += 1
          const pct = Math.min(95, (count / totalExpected) * 100)
          useUploadQueueStore.getState().setProgress(task.id, pct)
        }

        const attachmentRefs: AttachmentRef[] = []
        for (const src of sources) {
          if (src.kind === 'url') {
            attachmentRefs.push({
              url: src.url,
              mimeType: src.mimeType,
              filename: src.filename,
              byteSize: src.byteSize,
            })
          } else {
            const a = await uploadItem(sdk, src.bytes, onShard)
            attachmentRefs.push({
              url: a.itemURL,
              mimeType: src.mimeType,
              filename: src.filename,
              byteSize: src.bytes.length,
            })
          }
        }

        const uploaded = await uploadItem(sdk, task.payload.bytes, onShard)

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
          for (const ch of channels) {
            await appendItemToChannel(agent, ch, itemRef)
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
            : `Publish failed: ${msg}`,
        )
      }
    }

    const unsub = useUploadQueueStore.subscribe(() => {
      processNext()
    })

    processNext()

    return unsub
  }, [sdk, agent])
}
