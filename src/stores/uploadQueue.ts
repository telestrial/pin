import { create } from 'zustand'
import type { ItemPayload } from '../core/channels'

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
  reset: () => void
}

function newId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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
    return id
  },
  retry: (id) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? { ...t, state: 'pending', error: undefined, progress: 0 }
          : t,
      ),
    })),
  remove: (id) =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  setProgress: (id, progress) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, progress } : t)),
    })),
  setState: (id, state, error) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, state, error } : t,
      ),
    })),
  reset: () => set({ tasks: [] }),
}))
