import { useEffect } from 'react'
import { appendItemToChannel, buildItemRef } from '../core/channels'
import { uploadItem } from '../core/sia'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { useToastStore } from '../stores/toast'
import {
  type UploadTask,
  useUploadQueueStore,
} from '../stores/uploadQueue'

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

      const channels = task.channelIDs
        .map((id) => auth.myChannels.find((c) => c.channelID === id))
        .filter((c): c is NonNullable<typeof c> => !!c)

      if (channels.length === 0) {
        queue.setState(task.id, 'failed', 'Channel no longer exists')
        return
      }

      queue.setState(task.id, 'uploading', undefined)

      try {
        const expected = expectedShardCount(task.payload.bytes.length)
        let count = 0
        const uploaded = await uploadItem(sdk, task.payload.bytes, () => {
          count += 1
          const pct = Math.min(95, (count / expected) * 100)
          useUploadQueueStore.getState().setProgress(task.id, pct)
        })

        queue.setState(task.id, 'publishing', undefined)
        useUploadQueueStore.getState().setProgress(task.id, 97)

        const itemRef = buildItemRef(uploaded, task.payload)
        for (const ch of channels) {
          await appendItemToChannel(agent, ch, itemRef)
          const sub = auth.subscriptions.find(
            (s) => s.channelID === ch.channelID,
          )
          if (sub) feed.refreshChannel(sub)
        }

        useUploadQueueStore.getState().setProgress(task.id, 100)
        queue.setState(task.id, 'success', undefined)
        toast.addToast(`Published “${displayTitle(task)}”`)

        setTimeout(() => {
          useUploadQueueStore.getState().remove(task.id)
        }, SUCCESS_AUTO_REMOVE_MS)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to publish'
        queue.setState(task.id, 'failed', msg)
        toast.addToast(`Publish failed: ${msg}`)
      }
    }

    const unsub = useUploadQueueStore.subscribe(() => {
      processNext()
    })

    processNext()

    return unsub
  }, [sdk, agent])
}
