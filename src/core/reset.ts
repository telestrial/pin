// Full-account wipe primitive, used by the Settings → Full reset button. The
// destructive inverse of everything else: delete every Sia object in scope
// (which is where all durable content lives — channel manifests, the identity
// doc, the settings snapshot, item bytes). The caller (the Settings view) runs
// this while the sdk is alive, then clears local storage and reloads to the
// login screen. did:dht/pkarr records aren't deleted here — they expire by TTL.

import type { Sdk } from '@siafoundation/sia-storage'

const PAGE_LIMIT = 200
// Generous cap for a wipe — covers any realistic account.
const MAX_PAGES = 100

export type WipeResult = { deleted: number; failed: number }

// Delete every pinned object in the user's Sia scope, then prune the emptied
// slabs. Deletes are idempotent (already-gone counts as success) and get one
// retry pass so a QUIC blip doesn't strand objects. Returns counts.
export async function wipeAllSiaObjects(sdk: Sdk): Promise<WipeResult> {
  // Current pinned set = latest event per id that isn't a delete. Same walk
  // shape as fetchRawContentBytes (structured `{id, after}` cursor).
  // biome-ignore lint/suspicious/noExplicitAny: SDK ObjectEvent / cursor types aren't exported
  const latestByID = new Map<string, any>()
  // biome-ignore lint/suspicious/noExplicitAny: SDK cursor type isn't exported
  let cursor: any = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const events = await sdk.objectEvents(cursor, PAGE_LIMIT)
    if (events.length === 0) break
    for (const ev of events) {
      const prev = latestByID.get(ev.id)
      if (!prev || ev.updatedAt > prev.updatedAt) latestByID.set(ev.id, ev)
    }
    if (events.length < PAGE_LIMIT) break
    const last = events[events.length - 1]
    cursor = { id: last.id, after: last.updatedAt }
  }
  const ids: string[] = []
  for (const [id, ev] of latestByID) if (!ev.deleted) ids.push(id)

  let deleted = 0
  let remaining = ids
  for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt++) {
    const stillFailing: string[] = []
    for (const id of remaining) {
      try {
        await sdk.deleteObject(id)
        deleted++
      } catch (e) {
        if (isNotFound(e)) {
          deleted++ // already gone = success
          continue
        }
        stillFailing.push(id)
      }
    }
    remaining = stillFailing
  }

  await sdk.pruneSlabs().catch(() => {})
  return { deleted, failed: remaining.length }
}

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /not found|could not locate|does not exist|no such object/i.test(msg)
}
