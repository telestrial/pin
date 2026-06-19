import type { Sdk } from '@siafoundation/sia-storage'
import type { DeleteObjectsAction } from '../../stores/actionQueue'

// What the runner hands the handler: the SDK plus an id-bound mutator that
// records one intent key (object ID or URL) as reclaimed, so a resume skips it.
export type DeleteObjectsContext = {
  sdk: Sdk
  markDone: (key: string) => void
}

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /not found|could not locate|does not exist|no such object/i.test(msg)
}

// Delete an object, treating "already gone" as success — so a retry after a
// partial failure (or a duplicate enqueue) converges instead of looping.
async function deleteIdempotent(sdk: Sdk, id: string): Promise<void> {
  try {
    await sdk.deleteObject(id)
  } catch (e) {
    if (isNotFound(e)) return
    throw e
  }
}

// Reclaim the orphaned bytes a mutation scheduled. Positive-identification:
// deletes only the ids/urls in the intent (the reference-safety prune happened
// at enqueue time). Idempotent and resumable — each key is marked done as it
// completes, so a crash/retry picks up where it left off.
export async function runDeleteObjects(
  action: DeleteObjectsAction,
  ctx: DeleteObjectsContext,
): Promise<void> {
  const { sdk, markDone } = ctx
  const done = new Set(action.ledger.done ?? [])
  let didWork = false

  for (const id of action.intent.objectIDs) {
    if (done.has(id)) continue
    await deleteIdempotent(sdk, id)
    markDone(id)
    didWork = true
  }

  for (const url of action.intent.urls) {
    if (done.has(url)) continue
    let objectID: string
    try {
      objectID = (await sdk.sharedObject(url)).id()
    } catch (e) {
      // Can't resolve the URL → the bytes aren't reachable in our scope, so
      // there's nothing to delete. Treat the key as done.
      if (isNotFound(e)) {
        markDone(url)
        didWork = true
        continue
      }
      throw e
    }
    await deleteIdempotent(sdk, objectID)
    markDone(url)
    didWork = true
  }

  // Reclaim the now-empty slab capacity. deleteObject frees the bytes but the
  // indexer doesn't auto-drop emptied slabs, so without this a retract leaves
  // `pinnedData` inflated until some later repack happens to prune. This is the
  // only prune on the delete path (repack covers the pin path). Best-effort and
  // skipped on a no-op resume so we don't prune for nothing.
  if (didWork) await sdk.pruneSlabs().catch(() => {})
}
