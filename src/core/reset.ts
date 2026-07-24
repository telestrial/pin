// Full-account wipe primitive, used by the Settings → Full reset button. The
// destructive inverse of everything else: delete every Sia object in scope
// (which is where all durable content lives — channel manifests, the identity
// doc, the settings snapshot, item bytes). The caller (the Settings view) runs
// this while the sdk is alive, then clears local storage and reloads to the
// login screen. did:dht/pkarr records aren't deleted here — they expire by TTL.

import type { SiaClient } from './siaClient'

export type WipeResult = { deleted: number; failed: number }

// Delete every pinned object in the user's Sia scope, then prune the emptied
// slabs. Deletes are idempotent (already-gone counts as success) and get one
// retry pass so a QUIC blip doesn't strand objects. Returns counts.
export async function wipeAllSiaObjects(
  client: SiaClient,
): Promise<WipeResult> {
  // Current pinned set = the walk the client already dedups (latest event per
  // id, deleted ones dropped). We only need the ids here.
  const ids = (await client.listPinnedObjects()).map((o) => o.id)

  let deleted = 0
  let remaining = ids
  for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt++) {
    const stillFailing: string[] = []
    for (const id of remaining) {
      try {
        await client.deleteObject(id)
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

  await client.pruneSlabs().catch(() => {})
  return { deleted, failed: remaining.length }
}

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /not found|could not locate|does not exist|no such object/i.test(msg)
}
