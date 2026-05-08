import type { Sdk } from '@siafoundation/sia-storage'
import { SETTINGS_METADATA_KIND } from './settings'

// Walks every pinned object in your scope, compares against the caller-
// supplied knownIDs, and deletes anything that's pinned-but-unreferenced.
// "Orphan" sources include: failed historic repacks (packed bytes uploaded
// but manifest swap or delete failed), edited items where deleteObject for
// the old bytes silently threw, accumulated test data from earlier dev
// builds, etc. None of those have any consumer left, but they keep
// charging pinnedData until something deletes them.
//
// Safety: settings get TWO protections. Caller is expected to include
// auth.settingsObjectID in knownIDs as a positive identification, AND
// the walk skips any object whose metadata.kind === 'pin:settings' as
// defense in depth (handles stale settingsObjectID, mid-save races, or
// historical settings objects from before deletes were idempotent).
//
// Age gate: objects whose createdAt is younger than AGE_GATE_MS are
// exempt. This protects in-flight uploads, just-pinned items, and any
// transient state that hasn't propagated to our stores yet.

const PAGE_LIMIT = 200
// Hard cap on event-walk pages — defensive against runaway pagination.
// 200 × 50 = 10000 events covers any plausible scope.
const MAX_PAGES = 50
const AGE_GATE_MS = 5 * 60 * 1000

export type SweepResult = {
  scanned: number
  knownProtected: number
  ageProtected: number
  metadataProtected: number
  orphansFound: number
  orphansDeleted: number
}

export async function sweepOrphans(
  sdk: Sdk,
  knownIDs: Set<string>,
  now = Date.now(),
): Promise<SweepResult> {
  // Walk objectEvents, building "current state" by keeping the latest
  // event per id (by updatedAt). Events come back newest-first per the
  // pattern in core/settings.ts; keeping latest-by-timestamp is robust
  // to either ordering.
  // biome-ignore lint/suspicious/noExplicitAny: SDK ObjectEvent type
  const latestByID = new Map<string, any>()
  // biome-ignore lint/suspicious/noExplicitAny: SDK cursor type isn't exported
  let cursor: any = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const events = await sdk.objectEvents(cursor, PAGE_LIMIT)
    if (events.length === 0) break
    for (const ev of events) {
      const prev = latestByID.get(ev.id)
      if (!prev || ev.updatedAt > prev.updatedAt) {
        latestByID.set(ev.id, ev)
      }
    }
    if (events.length < PAGE_LIMIT) break
    const last = events[events.length - 1]
    cursor = { id: last.id, after: last.updatedAt }
  }

  const currentlyPinned = Array.from(latestByID.values()).filter(
    (ev) => !ev.deleted,
  )

  let knownProtected = 0
  let ageProtected = 0
  let metadataProtected = 0
  const orphans: string[] = []

  for (const ev of currentlyPinned) {
    if (knownIDs.has(ev.id)) {
      knownProtected++
      continue
    }

    const obj = ev.object
    const createdAt = obj ? obj.createdAt() : ev.updatedAt
    if (now - createdAt.getTime() < AGE_GATE_MS) {
      ageProtected++
      continue
    }

    if (obj) {
      const metaBytes = obj.metadata()
      if (metaBytes.length > 0) {
        try {
          const meta = JSON.parse(new TextDecoder().decode(metaBytes))
          if (meta?.kind === SETTINGS_METADATA_KIND) {
            metadataProtected++
            continue
          }
        } catch {
          // Metadata isn't JSON — not a settings object. Fall through.
        }
      }
    }

    orphans.push(ev.id)
  }

  let orphansDeleted = 0
  for (const id of orphans) {
    try {
      await sdk.deleteObject(id)
      orphansDeleted++
    } catch (e) {
      console.warn(`sweep: failed to delete orphan ${id}:`, e)
    }
  }

  if (orphansDeleted > 0) {
    try {
      await sdk.pruneSlabs()
    } catch (e) {
      console.warn('sweep: pruneSlabs failed:', e)
    }
  }

  return {
    scanned: currentlyPinned.length,
    knownProtected,
    ageProtected,
    metadataProtected,
    orphansFound: orphans.length,
    orphansDeleted,
  }
}
