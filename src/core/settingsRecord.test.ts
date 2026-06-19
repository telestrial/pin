import type { Agent } from '@atproto/api'
import { describe, expect, it } from 'vitest'
import { FakeAgent } from '../test/fakeAgent'
import { createFakeWorld, type FakeWorld } from '../test/fakeSdk'
import { deriveSettingsKey } from './crypto'
import { type DispatchSettings, SETTINGS_VERSION } from './settings'
import {
  loadSettingsRecord,
  saveSettingsRecord,
  SETTINGS_LEXICON,
  SETTINGS_RKEY,
} from './settingsRecord'

const ALICE = 'did:plc:alice'

function agentFor(world: FakeWorld, did = ALICE): Agent {
  return new FakeAgent(did, world) as unknown as Agent
}

function sampleSettings(overrides: Partial<DispatchSettings> = {}): DispatchSettings {
  return {
    version: SETTINGS_VERSION,
    myChannels: [
      { channelID: 'chan0000000000aa', channelKey: 'aGVsbG8=', name: 'Mine', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    subscriptions: [
      {
        authorHandle: 'bob.bsky.social',
        authorDID: 'did:plc:bob',
        channelID: 'chan0000000000bb',
        channelKey: 'd29ybGQ=',
        addedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    updatedAt: '2026-01-03T00:00:00.000Z',
    ...overrides,
  }
}

describe('settingsRecord', () => {
  it('round-trips encrypted settings through the PDS record', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const key = await deriveSettingsKey(new Uint8Array(32).fill(9))
    const settings = sampleSettings()

    const cid = await saveSettingsRecord(agent, key, settings, null)
    expect(cid).toBeTruthy()

    const loaded = await loadSettingsRecord(agent, key)
    expect(loaded?.settings).toEqual(settings)
    expect(loaded?.cid).toBe(cid)
  })

  it('stores the body as ciphertext, not readable plaintext', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const key = await deriveSettingsKey(new Uint8Array(32).fill(10))
    await saveSettingsRecord(agent, key, sampleSettings(), null)

    const raw = world.records?.get(ALICE, SETTINGS_LEXICON, SETTINGS_RKEY)
    const value = raw?.value as { enc: string }
    // The channelKey must not leak into the public record body.
    expect(JSON.stringify(value)).not.toContain('d29ybGQ=')
    expect(value.enc).toBeTruthy()
  })

  it('returns null when no record exists', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const key = await deriveSettingsKey(new Uint8Array(32).fill(11))
    expect(await loadSettingsRecord(agent, key)).toBeNull()
  })

  it('fails to load with the wrong key', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const k1 = await deriveSettingsKey(new Uint8Array(32).fill(12))
    const k2 = await deriveSettingsKey(new Uint8Array(32).fill(13))
    await saveSettingsRecord(agent, k1, sampleSettings(), null)
    await expect(loadSettingsRecord(agent, k2)).rejects.toThrow()
  })

  it('overwrites in place — one record, new CID each write', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const key = await deriveSettingsKey(new Uint8Array(32).fill(14))

    const cid1 = await saveSettingsRecord(agent, key, sampleSettings(), null)
    const next = sampleSettings({ updatedAt: '2026-02-01T00:00:00.000Z' })
    const cid2 = await saveSettingsRecord(agent, key, next, cid1)

    expect(cid2).not.toBe(cid1)
    // Still exactly one record under (did, collection, self).
    expect(world.records?.list(ALICE, SETTINGS_LEXICON).length).toBe(1)
    const loaded = await loadSettingsRecord(agent, key)
    expect(loaded?.settings.updatedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('rejects a stale-CID write at the PDS (CAS guard)', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const key = await deriveSettingsKey(new Uint8Array(32).fill(15))

    const cid1 = await saveSettingsRecord(agent, key, sampleSettings(), null)
    // A concurrent writer advances the record past cid1.
    await saveSettingsRecord(agent, key, sampleSettings({ updatedAt: '2026-03-01T00:00:00.000Z' }), cid1)

    // A direct putRecord using the now-stale cid1 must be rejected by the fake.
    await expect(
      agent.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: SETTINGS_LEXICON,
        rkey: SETTINGS_RKEY,
        record: { $type: SETTINGS_LEXICON, enc: 'x', updatedAt: 'z' },
        swapRecord: cid1,
      }),
    ).rejects.toMatchObject({ error: 'InvalidSwap' })
  })

  it('recovers from a CAS conflict by re-reading the current CID and retrying', async () => {
    const world = createFakeWorld()
    const agent = agentFor(world)
    const key = await deriveSettingsKey(new Uint8Array(32).fill(16))

    const cid1 = await saveSettingsRecord(agent, key, sampleSettings(), null)
    // Another writer advances the record, so cid1 is now stale.
    await saveSettingsRecord(agent, key, sampleSettings({ updatedAt: '2026-04-01T00:00:00.000Z' }), cid1)

    // Saving with the stale cid1 should NOT throw — it retries against the
    // fresh CID and lands (last-writer-wins).
    const winner = sampleSettings({ updatedAt: '2026-05-01T00:00:00.000Z' })
    const cid3 = await saveSettingsRecord(agent, key, winner, cid1)
    expect(cid3).toBeTruthy()
    const loaded = await loadSettingsRecord(agent, key)
    expect(loaded?.settings.updatedAt).toBe('2026-05-01T00:00:00.000Z')
  })
})
