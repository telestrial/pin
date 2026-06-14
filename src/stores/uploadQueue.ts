import { create } from 'zustand'
import type { ItemPayload } from '../core/channels'
import type { ItemRef } from '../core/types'
import {
  clearPersistedTasks,
  deletePersistedTask,
  persistTask,
} from '../lib/uploadQueuePersist'

export type UploadTaskState =
  | 'pending'
  | 'uploading'
  | 'publishing'
  | 'success'
  | 'failed'

// 'channel'  → upload + write item to one or more channel manifests (publish)
// 'library'  → upload + add to pinStore.pinned, no manifest write (just save)
export type UploadDestination = 'channel' | 'library'

export type UploadTask = {
  id: string
  state: UploadTaskState
  progress: number
  error?: string
  createdAt: string
  payload: ItemPayload
  channelIDs: string[]
  destination: UploadDestination
  // When set on a 'channel' task, the runner replaces the item with
  // this ID in the target channel instead of appending a new one.
  // publishedAt is preserved from the original; editedAt is stamped.
  editingItemID?: string
  // Attachment objectIDs that existed on the item but were removed in
  // the edit. Best-effort deleted after the manifest swap succeeds.
  removedAttachmentObjectIDs?: string[]
  // Checkpoint written once the Sia upload finishes, holding the resolved
  // ItemRef (URLs/hashes — no bytes). Its presence means a resume can skip
  // the slow re-upload and go straight to the manifest writes. Absent until
  // the upload completes.
  uploadedItemRef?: ItemRef
  // Channels (by channelID) this task has already published to, recorded
  // after each append/edit lands. A resume skips these so a crash mid-loop
  // can't double-append to a channel that already holds the item.
  publishedChannelIDs?: string[]
}

type UploadQueueState = {
  tasks: UploadTask[]
  enqueue: (input: {
    payload: ItemPayload
    channelIDs: string[]
    destination?: UploadDestination
    editingItemID?: string
    removedAttachmentObjectIDs?: string[]
  }) => string
  retry: (id: string) => void
  remove: (id: string) => void
  setProgress: (id: string, progress: number) => void
  setState: (id: string, state: UploadTaskState, error?: string) => void
  // Record the post-upload checkpoint so a resume skips re-uploading.
  checkpoint: (id: string, uploadedItemRef: ItemRef) => void
  // Mark one channel published (and persist) before moving to the next.
  markChannelPublished: (id: string, channelID: string) => void
  reset: () => void
}

function newId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Once a task has a checkpoint, its bytes are dead weight — a resume reads
// uploadedItemRef and never re-uploads. Drop them from the persisted copy so
// IDB doesn't hold a redundant (potentially large) byte payload.
function persistableSnapshot(task: UploadTask): UploadTask {
  if (!task.uploadedItemRef) return task
  return {
    ...task,
    payload: {
      ...task.payload,
      bytes: new Uint8Array(0),
      attachmentSources: undefined,
    },
  }
}

// Persist a task as resumable: always 'pending' (the live in-flight state is
// meaningless after a reload — a 'pending' snapshot is exactly what the runner
// re-picks up), bytes dropped once a checkpoint exists. Fire-and-forget.
function persistResumable(task: UploadTask): void {
  void persistTask({
    ...persistableSnapshot(task),
    state: 'pending',
    progress: 0,
    error: undefined,
  })
}

// Object IDs that a checkpointed-but-not-yet-complete task still depends on.
// After upload, a task's bytes are pinned in the user's Sia scope but not yet
// referenced by any manifest or pin (the publish/pin step hasn't run, or
// failed) — so to the storage-hygiene runners they look like orphans (orphan
// sweep would delete them) or repack candidates (repack would move them and
// strand the checkpoint's URL). Both runners union this set into their
// protected/known IDs so a checkpoint's bytes survive until its task — or a
// later retry of it — finishes referencing them. A task with no checkpoint
// has no Sia bytes yet, so it contributes nothing.
export function checkpointedObjectIDs(tasks: UploadTask[]): Set<string> {
  const ids = new Set<string>()
  for (const t of tasks) {
    const ref = t.uploadedItemRef
    if (!ref) continue
    if (ref.id) ids.add(ref.id)
    for (const att of ref.attachments ?? []) {
      if (att.objectID) ids.add(att.objectID)
    }
  }
  return ids
}

export const useUploadQueueStore = create<UploadQueueState>()((set) => ({
  tasks: [],
  enqueue: ({
    payload,
    channelIDs,
    destination = 'channel',
    editingItemID,
    removedAttachmentObjectIDs,
  }) => {
    const id = newId()
    const task: UploadTask = {
      id,
      state: 'pending',
      progress: 0,
      createdAt: new Date().toISOString(),
      payload,
      channelIDs,
      destination,
      editingItemID,
      removedAttachmentObjectIDs,
    }
    set((s) => ({ tasks: [...s.tasks, task] }))
    // Persist so a tab close before the runner finishes doesn't drop the
    // bytes — hydration on next load re-enqueues it.
    persistResumable(task)
    return id
  },
  retry: (id) =>
    set((s) => {
      const tasks = s.tasks.map((t) =>
        t.id === id
          ? { ...t, state: 'pending' as const, error: undefined, progress: 0 }
          : t,
      )
      // Retry keeps any checkpoint (uploadedItemRef / publishedChannelIDs)
      // intact, so a retry after a publish-phase failure skips re-upload and
      // only finishes the channels that didn't land.
      const updated = tasks.find((t) => t.id === id)
      if (updated) persistResumable(updated)
      return { tasks }
    }),
  remove: (id) => {
    void deletePersistedTask(id)
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
  },
  // Progress ticks are never persisted — they'd rewrite the persisted record
  // many times a second. The persisted snapshot stays at its last write.
  setProgress: (id, progress) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, progress } : t)),
    })),
  setState: (id, state, error) =>
    set((s) => {
      const tasks = s.tasks.map((t) =>
        t.id === id ? { ...t, state, error } : t,
      )
      // Only terminal states touch IDB: success means the work is done, so
      // drop it; failed should survive a reload so the user can still retry
      // (keeping any checkpoint, so the retry resumes rather than restarts).
      // In-flight states ('uploading'/'publishing') are deliberately left
      // unpersisted — the checkpoint/markChannelPublished writes carry the
      // resumable snapshot instead.
      if (state === 'success') {
        void deletePersistedTask(id)
      } else if (state === 'failed') {
        const updated = tasks.find((t) => t.id === id)
        if (updated) void persistTask(persistableSnapshot(updated))
      }
      return { tasks }
    }),
  checkpoint: (id, uploadedItemRef) =>
    set((s) => {
      const tasks = s.tasks.map((t) =>
        t.id === id ? { ...t, uploadedItemRef } : t,
      )
      const updated = tasks.find((t) => t.id === id)
      if (updated) persistResumable(updated)
      return { tasks }
    }),
  markChannelPublished: (id, channelID) =>
    set((s) => {
      const tasks = s.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              publishedChannelIDs: [
                ...(t.publishedChannelIDs ?? []),
                channelID,
              ],
            }
          : t,
      )
      const updated = tasks.find((t) => t.id === id)
      if (updated) persistResumable(updated)
      return { tasks }
    }),
  reset: () => {
    void clearPersistedTasks()
    set({ tasks: [] })
  },
}))
