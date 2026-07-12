import { create } from 'zustand'
import type { ItemPayload } from '../core/channels'
import type { ItemRef } from '../core/types'
import {
  clearPersistedActions,
  deletePersistedAction,
  persistAction,
} from '../lib/actionQueuePersist'

// The action journal. Every state-changing mutation is a durable, resumable
// Action with one legitimate lifecycle: pending → running → success, or
// → failed (retryable), or removed by the user. Persisted to IDB so an
// interrupted run resumes on next load (the working model the upload queue
// already proved — generalized here). `publish` is the first (and currently
// only) kind; deletes / retracts / edits join as kinds in later phases.

export type ActionState = 'pending' | 'running' | 'success' | 'failed'

// 'channel' → upload + write the item to one or more channel manifests (publish)
// 'library' → upload + add to pinStore.pinned, no manifest write (just save)
export type UploadDestination = 'channel' | 'library'

export type PublishIntent = {
  payload: ItemPayload
  channelIDs: string[]
  destination: UploadDestination
  // When set, replace the item with this ID in the target channel instead of
  // appending a new one. publishedAt is preserved from the original; editedAt
  // is stamped by the handler.
  editingItemID?: string
  // Attachment objectIDs that existed on the item but were removed in the
  // edit. Deleted after the manifest swap lands.
  removedAttachmentObjectIDs?: string[]
}

export type PublishLedger = {
  // Written once the Sia upload finishes (resolved ItemRef — URLs/hashes, no
  // bytes). Its presence means a resume skips the slow re-upload and goes
  // straight to the manifest writes.
  uploadedItemRef?: ItemRef
  // Channels (by channelID) already written to, recorded after each
  // append/edit lands so a crash mid-loop can't double-append.
  publishedChannelIDs?: string[]
}

// Display fields denormalized onto the envelope at enqueue time, so the
// in-flight UI and the runner's toasts never have to narrow on kind.
type ActionDisplay = {
  title: string
  // Success vocabulary, used by both the sidebar label and the toast
  // ('Published' / 'Saved' / 'Pinned').
  successLabel: string
  // Failure verb for the toast ('Publish' / 'Save' / 'Pin').
  failLabel: string
}

type ActionBase = ActionDisplay & {
  id: string
  state: ActionState
  progress: number
  // Sub-label shown while running ('Uploading' / 'Publishing'). Display only —
  // never persisted (the resumable snapshot is always coerced to 'pending').
  phase?: string
  error?: string
  createdAt: string
  // When true, the runner emits no success/failure toast (background work like
  // storage cleanup). The action still appears in the in-flight list.
  silent?: boolean
}

export type PublishAction = ActionBase & {
  kind: 'publish'
  intent: PublishIntent
  ledger: PublishLedger
}

export type DeleteObjectsIntent = {
  // Object IDs to delete directly.
  objectIDs: string[]
  // Share URLs whose backing object must first be resolved (sharedObject) then
  // deleted — used for channel/profile images, which store only the URL.
  urls: string[]
}

export type DeleteObjectsLedger = {
  // Intent keys (object IDs and URLs) already handled, so a resume skips them.
  done?: string[]
}

// Reclaim Sia bytes that a mutation orphaned. The reliable leg (the record
// write) already happened synchronously in the caller; this is the flaky byte
// leg, journaled so a QUIC-failed delete is retried/resumed rather than lost.
// Reference-safety was checked at enqueue time (the list is pre-pruned); the
// handler is pure positive-identification — it only deletes ids it was told to.
export type DeleteObjectsAction = ActionBase & {
  kind: 'delete-objects'
  intent: DeleteObjectsIntent
  ledger: DeleteObjectsLedger
}

// The journal's action union. Grows as kinds are added.
export type Action = PublishAction | DeleteObjectsAction

// Recognized kinds — hydration drops any persisted record whose kind isn't in
// this set (e.g. legacy upload-queue tasks from before the journal rename,
// which have no `kind` and a different shape).
export const ACTION_KINDS = ['publish', 'delete-objects'] as const

function newId(): string {
  return `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function publishTitle(p: ItemPayload): string {
  if (p.title) return p.title
  if (p.summary) return p.summary.slice(0, 60)
  if (p.filename) return p.filename
  return 'item'
}

function publishLabels(intent: PublishIntent): {
  successLabel: string
  failLabel: string
} {
  if (intent.destination === 'library')
    return { successLabel: 'Pinned', failLabel: 'Pin' }
  if (intent.editingItemID) return { successLabel: 'Saved', failLabel: 'Save' }
  return { successLabel: 'Published', failLabel: 'Publish' }
}

// Once a publish action has a checkpoint, its bytes are dead weight — a resume
// reads uploadedItemRef and never re-uploads. Drop them from the persisted copy
// so IDB doesn't hold a redundant (potentially large) byte payload.
function persistableSnapshot(action: Action): Action {
  if (action.kind === 'publish' && action.ledger.uploadedItemRef) {
    return {
      ...action,
      intent: {
        ...action.intent,
        payload: {
          ...action.intent.payload,
          bytes: new Uint8Array(0),
          attachmentSources: undefined,
        },
      },
    }
  }
  return action
}

// Persist an action as resumable: always 'pending' (the live in-flight state is
// meaningless after a reload — a 'pending' snapshot is exactly what the runner
// re-picks up), bytes dropped once a checkpoint exists. Fire-and-forget.
function persistResumable(action: Action): void {
  void persistAction({
    ...persistableSnapshot(action),
    state: 'pending',
    progress: 0,
    phase: undefined,
    error: undefined,
  })
}

// Object IDs that a checkpointed-but-not-yet-complete publish action still
// depends on. After upload, the bytes are pinned in the user's Sia scope but
// not yet referenced by any manifest or pin — so the repack runner unions this
// set into its protected IDs so a checkpoint's bytes survive (never moved out
// from under the URL) until its action — or a later retry — finishes
// referencing them. An action with no checkpoint has no Sia bytes yet.
export function checkpointedObjectIDs(actions: Action[]): Set<string> {
  const ids = new Set<string>()
  for (const a of actions) {
    if (a.kind !== 'publish') continue
    const ref = a.ledger.uploadedItemRef
    if (!ref) continue
    if (ref.id) ids.add(ref.id)
    for (const att of ref.attachments ?? []) {
      if (att.objectID) ids.add(att.objectID)
    }
  }
  return ids
}

type ActionQueueState = {
  actions: Action[]
  enqueuePublish: (input: {
    payload: ItemPayload
    channelIDs: string[]
    destination?: UploadDestination
    editingItemID?: string
    removedAttachmentObjectIDs?: string[]
  }) => string
  // Enqueue a background byte-reclaim. No-ops (returns '') if nothing to do.
  enqueueDeleteObjects: (input: {
    objectIDs?: string[]
    urls?: string[]
    label: string
  }) => string
  retry: (id: string) => void
  remove: (id: string) => void
  setProgress: (id: string, progress: number) => void
  setPhase: (id: string, phase: string, progress?: number) => void
  setState: (id: string, state: ActionState, error?: string) => void
  // Record the post-upload checkpoint so a resume skips re-uploading.
  checkpoint: (id: string, uploadedItemRef: ItemRef) => void
  // Mark one channel published (and persist) before moving to the next.
  markChannelPublished: (id: string, channelID: string) => void
  // Mark one delete-objects intent key (object ID or URL) reclaimed.
  markObjectDeleted: (id: string, key: string) => void
  reset: () => void
}

export const useActionStore = create<ActionQueueState>()((set) => ({
  actions: [],
  enqueuePublish: ({
    payload,
    channelIDs,
    destination = 'channel',
    editingItemID,
    removedAttachmentObjectIDs,
  }) => {
    const id = newId()
    const intent: PublishIntent = {
      payload,
      channelIDs,
      destination,
      editingItemID,
      removedAttachmentObjectIDs,
    }
    const { successLabel, failLabel } = publishLabels(intent)
    const action: PublishAction = {
      id,
      kind: 'publish',
      state: 'pending',
      progress: 0,
      createdAt: new Date().toISOString(),
      title: publishTitle(payload),
      successLabel,
      failLabel,
      intent,
      ledger: {},
    }
    set((s) => ({ actions: [...s.actions, action] }))
    // Persist so a tab close before the runner finishes doesn't drop the
    // bytes — hydration on next load re-enqueues it.
    persistResumable(action)
    return id
  },
  enqueueDeleteObjects: ({ objectIDs = [], urls = [], label }) => {
    if (objectIDs.length === 0 && urls.length === 0) return ''
    const id = newId()
    const action: DeleteObjectsAction = {
      id,
      kind: 'delete-objects',
      state: 'pending',
      progress: 0,
      createdAt: new Date().toISOString(),
      title: label,
      successLabel: 'Reclaimed',
      failLabel: 'Reclaim',
      silent: true,
      intent: { objectIDs, urls },
      ledger: {},
    }
    set((s) => ({ actions: [...s.actions, action] }))
    persistResumable(action)
    return id
  },
  retry: (id) =>
    set((s) => {
      const actions = s.actions.map((a) =>
        a.id === id
          ? {
              ...a,
              state: 'pending' as const,
              error: undefined,
              progress: 0,
              phase: undefined,
            }
          : a,
      )
      // Retry keeps any ledger (checkpoint / publishedChannelIDs) intact, so a
      // retry after a publish-phase failure skips re-upload and only finishes
      // the channels that didn't land.
      const updated = actions.find((a) => a.id === id)
      if (updated) persistResumable(updated)
      return { actions }
    }),
  remove: (id) => {
    void deletePersistedAction(id)
    set((s) => ({ actions: s.actions.filter((a) => a.id !== id) }))
  },
  // Progress ticks are never persisted — they'd rewrite the persisted record
  // many times a second. The persisted snapshot stays at its last write.
  setProgress: (id, progress) =>
    set((s) => ({
      actions: s.actions.map((a) => (a.id === id ? { ...a, progress } : a)),
    })),
  // Phase is display-only and never persisted (the resumable snapshot is
  // always 'pending' with no phase).
  setPhase: (id, phase, progress) =>
    set((s) => ({
      actions: s.actions.map((a) =>
        a.id === id
          ? { ...a, phase, ...(progress !== undefined ? { progress } : {}) }
          : a,
      ),
    })),
  setState: (id, state, error) =>
    set((s) => {
      const actions = s.actions.map((a) =>
        a.id === id ? { ...a, state, error } : a,
      )
      // Only terminal states touch IDB: success means the work is done, so
      // drop it; failed should survive a reload so the user can still retry
      // (keeping any checkpoint, so the retry resumes rather than restarts).
      // In-flight 'running' is deliberately left unpersisted — the
      // checkpoint/markChannelPublished writes carry the resumable snapshot.
      if (state === 'success') {
        void deletePersistedAction(id)
      } else if (state === 'failed') {
        const updated = actions.find((a) => a.id === id)
        if (updated) {
          // Background hygiene self-heals: a failed delete-objects persists as
          // resumable (pending) so the next boot retries it automatically,
          // rather than waiting for a manual retry. A failed publish persists
          // as 'failed' — re-publishing is a deliberate user decision.
          if (updated.kind === 'delete-objects') persistResumable(updated)
          else void persistAction(persistableSnapshot(updated))
        }
      }
      return { actions }
    }),
  checkpoint: (id, uploadedItemRef) =>
    set((s) => {
      const actions = s.actions.map((a) =>
        a.id === id && a.kind === 'publish'
          ? { ...a, ledger: { ...a.ledger, uploadedItemRef } }
          : a,
      )
      const updated = actions.find((a) => a.id === id)
      if (updated) persistResumable(updated)
      return { actions }
    }),
  markChannelPublished: (id, channelID) =>
    set((s) => {
      const actions = s.actions.map((a) =>
        a.id === id && a.kind === 'publish'
          ? {
              ...a,
              ledger: {
                ...a.ledger,
                publishedChannelIDs: [
                  ...(a.ledger.publishedChannelIDs ?? []),
                  channelID,
                ],
              },
            }
          : a,
      )
      const updated = actions.find((a) => a.id === id)
      if (updated) persistResumable(updated)
      return { actions }
    }),
  markObjectDeleted: (id, key) =>
    set((s) => {
      const actions = s.actions.map((a) =>
        a.id === id && a.kind === 'delete-objects'
          ? {
              ...a,
              ledger: { ...a.ledger, done: [...(a.ledger.done ?? []), key] },
            }
          : a,
      )
      const updated = actions.find((a) => a.id === id)
      if (updated) persistResumable(updated)
      return { actions }
    }),
  reset: () => {
    void clearPersistedActions()
    set({ actions: [] })
  },
}))
