import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { describe, expect, it, vi } from 'vitest'
import { FakeAgent } from '../test/fakeAgent'
import { createFakeWorld, type FakeWorld } from '../test/fakeSdk'
import { deriveSettingsKey } from './crypto'
import { type DispatchSettings, SETTINGS_VERSION } from './settings'
import { loadOrMigrateSettings } from './settingsMigration'
import { loadSettingsRecord, saveSettingsRecord } from './settingsRecord'

const ALICE = 'did:plc:alice'

function agentFor(world: FakeWorld): Agent {
  return new FakeAgent(ALICE, world) as unknown as Agent
}

function sampleSettings(tag: string): DispatchSettings {
  return {
    version: SETTINGS_VERSION,
    myChannels: [],
    subscriptions: [
      {
        authorHandle: `${tag}.bsky.social`,
        authorDID: 'did:plc:bob',
        channelID: 'chan0000000000bb',
        channelKey: 'd29ybGQ=',
        addedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    updatedAt: '2026-01-03T00:00:00.000Z',
  }
}

// Minimal Sia stub — loadOrMigrateSettings only ever touches deleteObject +
// pruneSlabs on the real sdk (legacy reads go through the injected loader).
function sdkStub() {
  const deleteObject = vi.fn(async () => {})
  const pruneSlabs = vi.fn(async () => {})
  return {
    sdk: { deleteObject, pruneSlabs } as unknown as Sdk,
    deleteObject,
    pruneSlabs,
  }
}

describe('loadOrMigrateSettings', () => {
  it('returns the PDS record when one exists, without touching Sia', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const key = await deriveSettingsKey(new Uint8Array(32).fill(20))
    await saveSettingsRecord(agent, key, sampleSettings('pds'), null)

    const { sdk, deleteObject } = sdkStub()
    const legacyLoad = vi.fn()
    const result = await loadOrMigrateSettings(agent, sdk, key, legacyLoad)

    expect(result?.settings.subscriptions[0].authorHandle).toBe('pds.bsky.social')
    expect(legacyLoad).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('migrates the legacy Sia settings to the PDS and deletes the Sia object', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const key = await deriveSettingsKey(new Uint8Array(32).fill(21))

    const { sdk, deleteObject, pruneSlabs } = sdkStub()
    const legacyLoad = vi.fn(async () => ({
      settings: sampleSettings('legacy'),
      objectID: 'sia-obj-123',
    }))

    const result = await loadOrMigrateSettings(agent, sdk, key, legacyLoad)

    // Returned the migrated settings...
    expect(result?.settings.subscriptions[0].authorHandle).toBe(
      'legacy.bsky.social',
    )
    // ...wrote them to the PDS (a subsequent load finds them, no Sia)...
    const reload = await loadSettingsRecord(agent, key)
    expect(reload?.settings.subscriptions[0].authorHandle).toBe(
      'legacy.bsky.social',
    )
    // ...and reclaimed the Sia object.
    expect(deleteObject).toHaveBeenCalledWith('sia-obj-123')
    expect(pruneSlabs).toHaveBeenCalled()
  })

  it('returns null when settings exist in neither place', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const key = await deriveSettingsKey(new Uint8Array(32).fill(22))

    const { sdk, deleteObject } = sdkStub()
    const legacyLoad = vi.fn(async () => null)
    const result = await loadOrMigrateSettings(agent, sdk, key, legacyLoad)

    expect(result).toBeNull()
    expect(deleteObject).not.toHaveBeenCalled()
  })
})
