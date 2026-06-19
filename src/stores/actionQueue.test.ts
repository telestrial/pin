import { beforeEach, describe, expect, it } from 'vitest'
import { loadPersistedActions } from '../lib/actionQueuePersist'
import type { ItemRef } from '../core/types'
import {
  type PublishAction,
  checkpointedObjectIDs,
  useActionStore,
} from './actionQueue'

// The store persists via fire-and-forget writes; yield long enough for the
// fake-indexeddb transactions to settle before reading them back.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20))
}

function enqueueText(channelIDs: string[]): string {
  return useActionStore.getState().enqueuePublish({
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

describe('actionQueue persistence', () => {
  beforeEach(async () => {
    useActionStore.getState().reset()
    await flush()
  })

  it('persists an enqueued action with its bytes, as pending', async () => {
    enqueueText(['chA'])
    await flush()
    const [persisted] = await loadPersistedActions()
    expect(persisted.state).toBe('pending')
    expect(persisted.ledger.uploadedItemRef).toBeUndefined()
    expect(persisted.intent.payload.bytes.length).toBe(4)
  })

  it('strips bytes and records the ref on checkpoint, staying resumable', async () => {
    const id = enqueueText(['chA'])
    useActionStore.getState().checkpoint(id, itemRef)
    await flush()
    const [persisted] = await loadPersistedActions()
    // Resumable snapshot: pending state, ref present, bytes gone.
    expect(persisted.state).toBe('pending')
    expect(persisted.ledger.uploadedItemRef?.itemURL).toBe(itemRef.itemURL)
    expect(persisted.intent.payload.bytes.length).toBe(0)
    // In-memory action keeps the checkpoint too.
    const live = useActionStore.getState().actions.find((a) => a.id === id)
    expect(live?.ledger.uploadedItemRef?.itemURL).toBe(itemRef.itemURL)
  })

  it('accumulates published channels for the resume skip-set', async () => {
    const id = enqueueText(['chA', 'chB'])
    const store = useActionStore.getState()
    store.checkpoint(id, itemRef)
    store.markChannelPublished(id, 'chA')
    await flush()
    const [persisted] = await loadPersistedActions()
    expect(persisted.ledger.publishedChannelIDs).toEqual(['chA'])
    expect(persisted.state).toBe('pending')
  })

  it('deletes the persisted action on success', async () => {
    const id = enqueueText(['chA'])
    useActionStore.getState().checkpoint(id, itemRef)
    useActionStore.getState().setState(id, 'success')
    await flush()
    expect(await loadPersistedActions()).toHaveLength(0)
  })

  it('keeps a failed action (with its checkpoint) for retry', async () => {
    const id = enqueueText(['chA'])
    useActionStore.getState().checkpoint(id, itemRef)
    useActionStore.getState().setState(id, 'failed', 'boom')
    await flush()
    const [persisted] = await loadPersistedActions()
    expect(persisted.state).toBe('failed')
    expect(persisted.error).toBe('boom')
    expect(persisted.ledger.uploadedItemRef?.itemURL).toBe(itemRef.itemURL)
    expect(persisted.intent.payload.bytes.length).toBe(0)
  })
})

describe('checkpointedObjectIDs (hygiene-runner protection set)', () => {
  function action(over: Partial<PublishAction>): PublishAction {
    return {
      id: 'x',
      kind: 'publish',
      state: 'pending',
      progress: 0,
      createdAt: '2026-06-14T00:00:00.000Z',
      title: '',
      successLabel: 'Published',
      failLabel: 'Publish',
      intent: {
        payload: {
          type: 'text',
          title: '',
          mimeType: 'text/markdown',
          bytes: new Uint8Array(0),
        },
        channelIDs: ['chA'],
        destination: 'channel',
      },
      ledger: {},
      ...over,
    }
  }

  it('is empty for actions without a checkpoint (no Sia bytes yet)', () => {
    expect(checkpointedObjectIDs([action({})]).size).toBe(0)
  })

  it('protects the body object and every attachment object of a checkpoint', () => {
    const ids = checkpointedObjectIDs([
      action({
        ledger: {
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
        },
      }),
    ])
    expect(ids.has('body-1')).toBe(true)
    expect(ids.has('att-1')).toBe(true)
    expect(ids.size).toBe(2)
  })

  it('unions across multiple checkpointed actions (e.g. one failed, one pending)', () => {
    const ids = checkpointedObjectIDs([
      action({ id: 'a', ledger: { uploadedItemRef: { ...itemRef, id: 'body-a' } } }),
      action({
        id: 'b',
        state: 'failed',
        ledger: { uploadedItemRef: { ...itemRef, id: 'body-b' } },
      }),
    ])
    expect(ids).toEqual(new Set(['body-a', 'body-b']))
  })
})
