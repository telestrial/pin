import { beforeEach, describe, expect, it } from 'vitest'
import type { UploadTask } from '../stores/uploadQueue'
import {
  clearPersistedTasks,
  deletePersistedTask,
  loadPersistedTasks,
  persistTask,
} from './uploadQueuePersist'

function makeTask(id: string, overrides: Partial<UploadTask> = {}): UploadTask {
  return {
    id,
    state: 'pending',
    progress: 0,
    createdAt: '2026-06-14T00:00:00.000Z',
    payload: {
      type: 'text',
      title: '',
      summary: 'hi',
      mimeType: 'text/markdown',
      bytes: new Uint8Array([1, 2, 3]),
    },
    channelIDs: ['chan1'],
    destination: 'channel',
    ...overrides,
  }
}

describe('uploadQueuePersist', () => {
  beforeEach(async () => {
    await clearPersistedTasks()
  })

  it('round-trips a task including its body bytes', async () => {
    await persistTask(makeTask('task-1'))
    const loaded = await loadPersistedTasks()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('task-1')
    expect(Array.from(loaded[0].payload.bytes)).toEqual([1, 2, 3])
  })

  it('preserves attachment bytes through structured clone', async () => {
    await persistTask(
      makeTask('task-2', {
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
      }),
    )
    const src = (await loadPersistedTasks())[0].payload.attachmentSources?.[0]
    expect(src?.kind).toBe('bytes')
    if (src?.kind === 'bytes') expect(Array.from(src.bytes)).toEqual([4, 5, 6])
  })

  it('overwrites by id (last write wins)', async () => {
    await persistTask(makeTask('task-3'))
    await persistTask(makeTask('task-3', { state: 'failed', error: 'boom' }))
    const loaded = await loadPersistedTasks()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].state).toBe('failed')
    expect(loaded[0].error).toBe('boom')
  })

  it('deletes a single task by id', async () => {
    await persistTask(makeTask('task-4'))
    await persistTask(makeTask('task-5'))
    await deletePersistedTask('task-4')
    const loaded = await loadPersistedTasks()
    expect(loaded.map((t) => t.id)).toEqual(['task-5'])
  })

  it('clears all tasks', async () => {
    await persistTask(makeTask('a'))
    await persistTask(makeTask('b'))
    await clearPersistedTasks()
    expect(await loadPersistedTasks()).toHaveLength(0)
  })
})
