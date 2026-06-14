import { beforeEach, describe, expect, it } from 'vitest'
import type { ItemRef } from '../core/types'
import { loadPersistedTasks } from '../lib/uploadQueuePersist'
import {
  checkpointedObjectIDs,
  type UploadTask,
  useUploadQueueStore,
} from './uploadQueue'

// The store persists via fire-and-forget writes; yield long enough for the
// fake-indexeddb transactions to settle before reading them back.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20))
}

function enqueueText(channelIDs: string[]): string {
  return useUploadQueueStore.getState().enqueue({
    payload: {
      type: 'text',
      title: '',
      summary: 'hello',
      mimeType: 'text/markdown',
      bytes: new Uint8Array([1, 2, 3, 4]),
    },
    channelIDs,
  })
}

const itemRef: ItemRef = {
  id: 'obj-1',
  itemURL: 'sia://obj-1#k=abc',
  type: 'text',
  title: '',
  publishedAt: '2026-06-14T00:00:00.000Z',
  mimeType: 'text/markdown',
  byteSize: 4,
  contentHash: 'bafy-deadbeef',
}

describe('uploadQueue persistence', () => {
  beforeEach(async () => {
    useUploadQueueStore.getState().reset()
    await flush()
  })

  it('persists an enqueued task with its bytes, as pending', async () => {
    enqueueText(['chA'])
    await flush()
    const [persisted] = await loadPersistedTasks()
    expect(persisted.state).toBe('pending')
    expect(persisted.uploadedItemRef).toBeUndefined()
    expect(persisted.payload.bytes.length).toBe(4)
  })

  it('strips bytes and records the ref on checkpoint, staying resumable', async () => {
    const id = enqueueText(['chA'])
    useUploadQueueStore.getState().checkpoint(id, itemRef)
    await flush()
    const [persisted] = await loadPersistedTasks()
    // Resumable snapshot: pending state, ref present, bytes gone.
    expect(persisted.state).toBe('pending')
    expect(persisted.uploadedItemRef?.itemURL).toBe(itemRef.itemURL)
    expect(persisted.payload.bytes.length).toBe(0)
    // In-memory task keeps the checkpoint too.
    const live = useUploadQueueStore.getState().tasks.find((t) => t.id === id)
    expect(live?.uploadedItemRef?.itemURL).toBe(itemRef.itemURL)
  })

  it('accumulates published channels for the resume skip-set', async () => {
    const id = enqueueText(['chA', 'chB'])
    const store = useUploadQueueStore.getState()
    store.checkpoint(id, itemRef)
    store.markChannelPublished(id, 'chA')
    await flush()
    const [persisted] = await loadPersistedTasks()
    expect(persisted.publishedChannelIDs).toEqual(['chA'])
    expect(persisted.state).toBe('pending')
  })

  it('deletes the persisted task on success', async () => {
    const id = enqueueText(['chA'])
    useUploadQueueStore.getState().checkpoint(id, itemRef)
    useUploadQueueStore.getState().setState(id, 'success')
    await flush()
    expect(await loadPersistedTasks()).toHaveLength(0)
  })

  it('keeps a failed task (with its checkpoint) for retry', async () => {
    const id = enqueueText(['chA'])
    useUploadQueueStore.getState().checkpoint(id, itemRef)
    useUploadQueueStore.getState().setState(id, 'failed', 'boom')
    await flush()
    const [persisted] = await loadPersistedTasks()
    expect(persisted.state).toBe('failed')
    expect(persisted.error).toBe('boom')
    expect(persisted.uploadedItemRef?.itemURL).toBe(itemRef.itemURL)
    expect(persisted.payload.bytes.length).toBe(0)
  })
})

describe('checkpointedObjectIDs (hygiene-runner protection set)', () => {
  function task(over: Partial<UploadTask>): UploadTask {
    return {
      id: 'x',
      state: 'pending',
      progress: 0,
      createdAt: '2026-06-14T00:00:00.000Z',
      payload: {
        type: 'text',
        title: '',
        mimeType: 'text/markdown',
        bytes: new Uint8Array(0),
      },
      channelIDs: ['chA'],
      destination: 'channel',
      ...over,
    }
  }

  it('is empty for tasks without a checkpoint (no Sia bytes yet)', () => {
    expect(checkpointedObjectIDs([task({})]).size).toBe(0)
  })

  it('protects the body object and every attachment object of a checkpoint', () => {
    const ids = checkpointedObjectIDs([
      task({
        uploadedItemRef: {
          ...itemRef,
          id: 'body-1',
          attachments: [
            {
              url: 'sia://att-1#k=x',
              mimeType: 'image/png',
              byteSize: 10,
              objectID: 'att-1',
            },
            // legacy attachment with no objectID — nothing to protect
            { url: 'sia://att-2#k=y', mimeType: 'image/png', byteSize: 10 },
          ],
        },
      }),
    ])
    expect(ids.has('body-1')).toBe(true)
    expect(ids.has('att-1')).toBe(true)
    expect(ids.size).toBe(2)
  })

  it('unions across multiple checkpointed tasks (e.g. one failed, one pending)', () => {
    const ids = checkpointedObjectIDs([
      task({ id: 'a', uploadedItemRef: { ...itemRef, id: 'body-a' } }),
      task({
        id: 'b',
        state: 'failed',
        uploadedItemRef: { ...itemRef, id: 'body-b' },
      }),
    ])
    expect(ids).toEqual(new Set(['body-a', 'body-b']))
  })
})
