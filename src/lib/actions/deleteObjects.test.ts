import { describe, expect, it, vi } from 'vitest'
import type { SiaClient } from '../../core/siaClient'
import type { DeleteObjectsAction } from '../../stores/actionQueue'
import { runDeleteObjects } from './deleteObjects'

function action(intent: {
  objectIDs?: string[]
  urls?: string[]
  done?: string[]
}): DeleteObjectsAction {
  return {
    id: 'd1',
    kind: 'delete-objects',
    state: 'pending',
    progress: 0,
    createdAt: '2026-06-18T00:00:00.000Z',
    title: 'Reclaiming',
    successLabel: 'Reclaimed',
    failLabel: 'Reclaim',
    silent: true,
    intent: { objectIDs: intent.objectIDs ?? [], urls: intent.urls ?? [] },
    ledger: { done: intent.done },
  }
}

function fakeClient(
  over: Partial<
    Record<'deleteObject' | 'resolveObjectID' | 'pruneSlabs', unknown>
  > = {},
) {
  const deleteObject = vi.fn().mockResolvedValue(undefined)
  const resolveObjectID = vi.fn().mockResolvedValue('resolved-id')
  const pruneSlabs = vi.fn().mockResolvedValue(undefined)
  return {
    client: {
      deleteObject,
      resolveObjectID,
      pruneSlabs,
      ...over,
    } as unknown as SiaClient,
    deleteObject,
    resolveObjectID,
    pruneSlabs,
  }
}

describe('runDeleteObjects', () => {
  it('deletes each objectID and marks it done', async () => {
    const { client, deleteObject } = fakeClient()
    const markDone = vi.fn()
    await runDeleteObjects(action({ objectIDs: ['a', 'b'] }), {
      client,
      markDone,
    })
    expect(deleteObject.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
    expect(markDone.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
  })

  it('resolves a URL then deletes its object', async () => {
    const { client, deleteObject, resolveObjectID } = fakeClient()
    const markDone = vi.fn()
    await runDeleteObjects(action({ urls: ['sia://x#k=1'] }), {
      client,
      markDone,
    })
    expect(resolveObjectID).toHaveBeenCalledWith('sia://x#k=1')
    expect(deleteObject).toHaveBeenCalledWith('resolved-id')
    expect(markDone).toHaveBeenCalledWith('sia://x#k=1')
  })

  it('treats an already-gone object as success', async () => {
    const { client } = fakeClient({
      deleteObject: vi.fn().mockRejectedValue(new Error('object not found')),
    })
    const markDone = vi.fn()
    await expect(
      runDeleteObjects(action({ objectIDs: ['gone'] }), { client, markDone }),
    ).resolves.toBeUndefined()
    expect(markDone).toHaveBeenCalledWith('gone')
  })

  it('marks an unresolvable URL done without deleting', async () => {
    const deleteObject = vi.fn().mockResolvedValue(undefined)
    const { client } = fakeClient({
      deleteObject,
      resolveObjectID: vi.fn().mockRejectedValue(new Error('could not locate')),
    })
    const markDone = vi.fn()
    await runDeleteObjects(action({ urls: ['sia://gone#k=1'] }), {
      client,
      markDone,
    })
    expect(deleteObject).not.toHaveBeenCalled()
    expect(markDone).toHaveBeenCalledWith('sia://gone#k=1')
  })

  it('skips keys already recorded done (resume)', async () => {
    const { client, deleteObject } = fakeClient()
    const markDone = vi.fn()
    await runDeleteObjects(action({ objectIDs: ['a', 'b'], done: ['a'] }), {
      client,
      markDone,
    })
    expect(deleteObject.mock.calls.map((c) => c[0])).toEqual(['b'])
    expect(markDone.mock.calls.map((c) => c[0])).toEqual(['b'])
  })

  it('rethrows a non-not-found error and leaves the key unmarked', async () => {
    const { client } = fakeClient({
      deleteObject: vi.fn().mockRejectedValue(new Error('network down')),
    })
    const markDone = vi.fn()
    await expect(
      runDeleteObjects(action({ objectIDs: ['a'] }), { client, markDone }),
    ).rejects.toThrow('network down')
    expect(markDone).not.toHaveBeenCalled()
  })

  it('prunes slabs after deleting (reclaims the emptied capacity)', async () => {
    const { client, pruneSlabs } = fakeClient()
    await runDeleteObjects(action({ objectIDs: ['a', 'b'] }), {
      client,
      markDone: vi.fn(),
    })
    expect(pruneSlabs).toHaveBeenCalledTimes(1)
  })

  it('does not prune on a no-op resume (nothing deleted this run)', async () => {
    const { client, pruneSlabs } = fakeClient()
    await runDeleteObjects(action({ objectIDs: ['a'], done: ['a'] }), {
      client,
      markDone: vi.fn(),
    })
    expect(pruneSlabs).not.toHaveBeenCalled()
  })
})
