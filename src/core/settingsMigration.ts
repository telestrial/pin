// One-shot migration bridge: legacy Sia settings object → PDS settings record.
// Settings used to live as a Sia object (content-addressed, the source of the
// proliferation / convergence / ghost-channel bug class). Phase 3 moves them to
// a mutable dev.sia.pin.settings/self record. This loads from the PDS, falling
// back to the Sia object exactly once to migrate it across.

import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { type DispatchSettings, loadSettings } from './settings'
import {
  type LoadedSettingsRecord,
  loadSettingsRecord,
  saveSettingsRecord,
} from './settingsRecord'

export type LegacyLoader = (
  sdk: Sdk,
) => Promise<{ settings: DispatchSettings; objectID: string } | null>

// PDS first (the new home); if absent, read the legacy Sia settings object and
// write it to the PDS, then best-effort delete the Sia object so the account
// converges to the single PDS record. Idempotent — once the PDS record exists,
// the Sia path never runs again. Returns null when no settings exist anywhere
// (first-ever use). `legacyLoad` is injectable for testing; defaults to the Sia
// loader.
export async function loadOrMigrateSettings(
  agent: Agent,
  sdk: Sdk,
  settingsKey: Uint8Array,
  legacyLoad: LegacyLoader = loadSettings,
): Promise<LoadedSettingsRecord | null> {
  const pds = await loadSettingsRecord(agent, settingsKey)
  if (pds) return pds

  const legacy = await legacyLoad(sdk)
  if (!legacy) return null

  const cid = await saveSettingsRecord(agent, settingsKey, legacy.settings, null)
  // PDS now owns settings — drop the Sia object. Best-effort: a failed delete
  // just leaves a stale Sia object (a few KB; the migration runs once per
  // account, and no sweep reclaims it now — acceptable for the migration set).
  await sdk.deleteObject(legacy.objectID).catch(() => {})
  await sdk.pruneSlabs().catch(() => {})
  return { settings: legacy.settings, cid }
}
