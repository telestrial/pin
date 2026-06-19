import type { Sdk } from '@siafoundation/sia-storage'
import { describe, expect, it, vi } from 'vitest'
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

function fakeSdk(over: Partial<Record<'deleteObject' | 'sharedObject', unknown>> = {}) {
  const deleteObject = vi.fn().mockResolvedValue(undefined)
  const sharedObject = vi
    .fn()
    .mockResolvedValue({ id: () => 'resolved-id' })
  return {
    sdk: { deleteObject, sharedObject, ...over } as unknown as Sdk,
    deleteObject,
    sharedObject,
  }
}

describe('runDeleteObjects', () => {
  it('deletes each objectID and marks it done', async () => {
    const { sdk, deleteObject } = fakeSdk()
    const markDone = vi.fn()
    await runDeleteObjects(action({ objectIDs: ['a', 'b'] }), { sdk, markDone })
    expect(deleteObject.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
    expect(markDone.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
  })

  it('resolves a URL then deletes its object', async () => {
    const { sdk, deleteObject, sharedObject } = fakeSdk()
    const markDone = vi.fn()
    await runDeleteObjects(action({ urls: ['sia://x#k=1'] }), { sdk, markDone })
    expect(sharedObject).toHaveBeenCalledWith('sia://x#k=1')
    expect(deleteObject).toHaveBeenCalledWith('resolved-id')
    expect(markDone).toHaveBeenCalledWith('sia://x#k=1')
  })

  it('treats an already-gone object as success', async () => {
    const { sdk } = fakeSdk({
      deleteObject: vi.fn().mockRejectedValue(new Error('object not found')),
    })
    const markDone = vi.fn()
    await expect(
      runDeleteObjects(action({ objectIDs: ['gone'] }), { sdk, markDone }),
    ).resolves.toBeUndefined()
    expect(markDone).toHaveBeenCalledWith('gone')
  })

  it('marks an unresolvable URL done without deleting', async () => {
    const deleteObject = vi.fn().mockResolvedValue(undefined)
    const { sdk } = fakeSdk({
      deleteObject,
      sharedObject: vi.fn().mockRejectedValue(new Error('could not locate')),
    })
    const markDone = vi.fn()
    await runDeleteObjects(action({ urls: ['sia://gone#k=1'] }), {
      sdk,
      markDone,
    })
    expect(deleteObject).not.toHaveBeenCalled()
    expect(markDone).toHaveBeenCalledWith('sia://gone#k=1')
  })

  it('skips keys already recorded done (resume)', async () => {
    const { sdk, deleteObject } = fakeSdk()
    const markDone = vi.fn()
    await runDeleteObjects(action({ objectIDs: ['a', 'b'], done: ['a'] }), {
      sdk,
      markDone,
    })
    expect(deleteObject.mock.calls.map((c) => c[0])).toEqual(['b'])
    expect(markDone.mock.calls.map((c) => c[0])).toEqual(['b'])
  })

  it('rethrows a non-not-found error and leaves the key unmarked', async () => {
    const { sdk } = fakeSdk({
      deleteObject: vi.fn().mockRejectedValue(new Error('network down')),
    })
    const markDone = vi.fn()
    await expect(
      runDeleteObjects(action({ objectIDs: ['a'] }), { sdk, markDone }),
    ).rejects.toThrow('network down')
    expect(markDone).not.toHaveBeenCalled()
  })
})
