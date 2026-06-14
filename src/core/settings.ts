import { PinnedObject, type Sdk } from '@siafoundation/sia-storage'
import type { OwnedChannel } from '../stores/auth'
import type { SubscriptionRef } from './types'

export const SETTINGS_VERSION = 1
export const SETTINGS_METADATA_KIND = 'pin:settings'

export type DispatchSettings = {
  version: typeof SETTINGS_VERSION
  myChannels: OwnedChannel[]
  subscriptions: SubscriptionRef[]
  updatedAt: string
}

type SettingsMetadata = {
  kind: typeof SETTINGS_METADATA_KIND
  version: typeof SETTINGS_VERSION
  updatedAt: string
}

export type LoadedSettings = {
  settings: DispatchSettings
  objectID: string
}

const PAGE_LIMIT = 200

type SettingsCandidate = { id: string; updatedAt: string }

// Of all the settings objects found in scope, which are safe to delete: every
// one STRICTLY OLDER than the object we kept. Never the kept object, never one
// with an equal-or-newer updatedAt — so a transiently-unreadable newer object
// (we fell back to an older readable one) is never destroyed by mistake.
export function staleSettingsIds(
  candidates: SettingsCandidate[],
  keepId: string,
  keepUpdatedAt: string,
): string[] {
  return candidates
    .filter((c) => c.id !== keepId && c.updatedAt < keepUpdatedAt)
    .map((c) => c.id)
}

// Loads the authoritative settings object and converges the account to a
// single one. Content-addressing means every save is a NEW object, so over
// time (especially when a prior delete failed) several settings objects can
// coexist; picking by raw event-order is unstable and flip-flops the loaded
// state. Instead: collect EVERY settings-tagged object, pick the latest by the
// updatedAt in its metadata (deterministic), then delete the strictly-older
// duplicates so the next load has exactly one to find. Returns null if none.
export async function loadSettings(sdk: Sdk): Promise<LoadedSettings | null> {
  // Pass 1: collect every settings-tagged object (id + updatedAt from
  // metadata — no body download yet).
  const candidates: SettingsCandidate[] = []
  let cursor: unknown
  // Hard cap: ~5 pages of events. Settings sits near the top by recency since
  // it's rewritten on every channel/sub change; objects older than that are
  // already superseded.
  for (let page = 0; page < 5; page++) {
    // biome-ignore lint/suspicious/noExplicitAny: SDK cursor type isn't exported
    const events = await sdk.objectEvents(cursor as any, PAGE_LIMIT)
    if (events.length === 0) break

    for (const ev of events) {
      if (ev.deleted || !ev.object) continue
      const metaBytes = ev.object.metadata()
      if (metaBytes.length === 0) continue
      let meta: SettingsMetadata
      try {
        meta = JSON.parse(new TextDecoder().decode(metaBytes))
      } catch {
        continue
      }
      if (meta.kind !== SETTINGS_METADATA_KIND) continue
      if (meta.version !== SETTINGS_VERSION) continue
      candidates.push({ id: ev.id, updatedAt: meta.updatedAt ?? '' })
    }

    if (events.length < PAGE_LIMIT) break
    // biome-ignore lint/suspicious/noExplicitAny: events carry an opaque cursor
    cursor = (events[events.length - 1] as any).cursor ?? undefined
    if (!cursor) break
  }

  if (candidates.length === 0) return null

  // Newest first (updatedAt is ISO-8601, so lexicographic = chronological;
  // id breaks ties for stable ordering).
  const ordered = [...candidates].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
  )

  // Pass 2: load the newest readable+valid object's body, falling back through
  // older candidates if one is unreadable/invalid.
  let loaded: LoadedSettings | null = null
  let keptUpdatedAt = ''
  for (const cand of ordered) {
    try {
      const handle = await sdk.object(cand.id)
      const text = await new Response(sdk.download(handle)).text()
      const settings = JSON.parse(text) as DispatchSettings
      if (settings.version !== SETTINGS_VERSION) continue
      loaded = { settings, objectID: cand.id }
      keptUpdatedAt = cand.updatedAt
      break
    } catch {
      // try the next-newest candidate
    }
  }
  if (!loaded) return null

  // Converge to one: delete the strictly-older duplicates. The orphan sweep
  // protects all settings-tagged objects, so this is the only place stale
  // ones get reclaimed. Best-effort — a failed delete just retries next load.
  const stale = staleSettingsIds(candidates, loaded.objectID, keptUpdatedAt)
  if (stale.length > 0) {
    await Promise.all(stale.map((id) => sdk.deleteObject(id).catch(() => {})))
    await sdk.pruneSlabs().catch(() => {})
  }

  return loaded
}

// Uploads a fresh settings object, tags its metadata, pins it, and deletes the
// prior one. Returns the new object ID for the caller to track. The delete is
// AWAITED (not fire-and-forget) so a successful save leaves exactly one object;
// if the delete fails it's logged and loadSettings' convergence reclaims the
// straggler on the next load.
export async function saveSettings(
  sdk: Sdk,
  settings: DispatchSettings,
  previousObjectID: string | null,
): Promise<string> {
  const json = JSON.stringify(settings)
  const bytes = new TextEncoder().encode(json)
  const obj = await sdk.upload(
    new PinnedObject(),
    new Blob([bytes as BlobPart]).stream(),
  )
  const meta: SettingsMetadata = {
    kind: SETTINGS_METADATA_KIND,
    version: SETTINGS_VERSION,
    updatedAt: settings.updatedAt,
  }
  obj.updateMetadata(new TextEncoder().encode(JSON.stringify(meta)))
  await sdk.pinObject(obj)
  await sdk.updateObjectMetadata(obj)
  const newID = obj.id()

  if (previousObjectID && previousObjectID !== newID) {
    try {
      await sdk.deleteObject(previousObjectID)
    } catch (e) {
      console.warn('Failed to delete previous settings object:', e)
    }
  }
  return newID
}
