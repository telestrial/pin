// Smoke test for the integration-test module mocks. Confirms the sia-storage
// vi.mock factory returns a working stub that respects the live FakeWorld.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@siafoundation/sia-storage', async () =>
  (await import('./fakeModules')).fakeSiaStorageModule(),
)

import { PinnedObject } from '@siafoundation/sia-storage'
import { resetAllStores } from './setupFakeApp'

describe('integration test module mocks', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('PinnedObject() constructs without WASM init (stub)', () => {
    const obj = new PinnedObject()
    expect(typeof obj.id()).toBe('string')
  })
})
