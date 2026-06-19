import { beforeEach, describe, expect, it } from 'vitest'
import type { PublishAction } from '../stores/actionQueue'
import {
  clearPersistedActions,
  deletePersistedAction,
  loadPersistedActions,
  persistAction,
} from './actionQueuePersist'

function makeAction(
  id: string,
  overrides: Partial<PublishAction> = {},
): PublishAction {
  return {
    id,
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
        summary: 'hi',
        mimeType: 'text/markdown',
        bytes: new Uint8Array([1, 2, 3]),
      },
      channelIDs: ['chan1'],
      destination: 'channel',
    },
    ledger: {},
    ...overrides,
  }
}

describe('actionQueuePersist', () => {
  beforeEach(async () => {
    await clearPersistedActions()
  })

  it('round-trips an action including its body bytes', async () => {
    await persistAction(makeAction('act-1'))
    const loaded = await loadPersistedActions()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('act-1')
    expect(Array.from(loaded[0].intent.payload.bytes)).toEqual([1, 2, 3])
  })

  it('preserves attachment bytes through structured clone', async () => {
    await persistAction(
      makeAction('act-2', {
        intent: {
          payload: {
            type: 'text',
            title: '',
            mimeType: 'text/markdown',
            bytes: new Uint8Array([9]),
            attachmentSources: [
              {
                kind: 'bytes',
                bytes: new Uint8Array([4, 5, 6]),
                mimeType: 'image/png',
                filename: 'a.png',
              },
            ],
          },
          channelIDs: ['chan1'],
          destination: 'channel',
        },
      }),
    )
    const src = (await loadPersistedActions())[0].intent.payload
      .attachmentSources?.[0]
    expect(src?.kind).toBe('bytes')
    if (src?.kind === 'bytes') expect(Array.from(src.bytes)).toEqual([4, 5, 6])
  })

  it('overwrites by id (last write wins)', async () => {
    await persistAction(makeAction('act-3'))
    await persistAction(makeAction('act-3', { state: 'failed', error: 'boom' }))
    const loaded = await loadPersistedActions()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].state).toBe('failed')
    expect(loaded[0].error).toBe('boom')
  })

  it('deletes a single action by id', async () => {
    await persistAction(makeAction('act-4'))
    await persistAction(makeAction('act-5'))
    await deletePersistedAction('act-4')
    const loaded = await loadPersistedActions()
    expect(loaded.map((a) => a.id)).toEqual(['act-5'])
  })

  it('clears all actions', async () => {
    await persistAction(makeAction('a'))
    await persistAction(makeAction('b'))
    await clearPersistedActions()
    expect(await loadPersistedActions()).toHaveLength(0)
  })
})
