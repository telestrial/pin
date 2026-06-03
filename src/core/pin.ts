import type { Sdk } from '@siafoundation/sia-storage'

export type AccountSnapshot = {
  pinnedData: number
  pinnedSize: number
  // Actual content bytes across every pinned object in this AppKey's
  // scope — post bodies, attachments, channel covers, profile assets,
  // settings record, all of it. Computed by walking objectEvents and
  // summing slab lengths per object, so it accounts for everything Sia
  // is storing for the user without any byteSize-from-manifest guesswork.
  rawContentBytes: number
  maxPinnedData: number
  remainingStorage: number
  fetchedAt: string
}

export async function pinItemBytes(
  sdk: Sdk,
  itemURL: string,
): Promise<{ objectID: string }> {
  const handle = await sdk.sharedObject(itemURL)
  await sdk.pinObject(handle)
  return { objectID: handle.id() }
}

export async function unpinItemBytes(
  sdk: Sdk,
  objectID: string,
): Promise<void> {
  await sdk.deleteObject(objectID)
}

const EVENTS_PAGE_LIMIT = 200
// Defensive cap — 200 × 50 = 10000 events covers any plausible scope.
const EVENTS_MAX_PAGES = 50

// Walks every pinned object in scope and sums slab lengths. Each slab
// entry's `length` is this object's byte slice in that slab; summing
// across all an object's slabs gives the object's total content size,
// and across all objects in scope gives the user's total content bytes.
// Refresh is coalesced at the pinStore.refreshAccount layer so bursts
// collapse to ~1 walk regardless of how many pin events triggered them.
export async function fetchRawContentBytes(sdk: Sdk): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: SDK ObjectEvent / cursor types aren't exported
  const latestByID = new Map<string, any>()
  // biome-ignore lint/suspicious/noExplicitAny: SDK cursor type isn't exported
  let cursor: any = null
  for (let page = 0; page < EVENTS_MAX_PAGES; page++) {
    const events = await sdk.objectEvents(cursor, EVENTS_PAGE_LIMIT)
    if (events.length === 0) break
    for (const ev of events) {
      const prev = latestByID.get(ev.id)
      if (!prev || ev.updatedAt > prev.updatedAt) {
        latestByID.set(ev.id, ev)
      }
    }
    if (events.length < EVENTS_PAGE_LIMIT) break
    const last = events[events.length - 1]
    cursor = { id: last.id, after: last.updatedAt }
  }
  let total = 0
  for (const ev of latestByID.values()) {
    if (ev.deleted) continue
    const obj = ev.object
    if (!obj) continue
    try {
      const slabs = obj.slabs()
      for (const s of slabs) {
        if (Number.isFinite(s.length)) total += s.length
      }
    } catch {
      // Best-effort: a single object's slabs() failure shouldn't blow up
      // the whole snapshot. The next refresh tick gets another chance.
    }
  }
  return total
}

export async function fetchAccountSnapshot(sdk: Sdk): Promise<AccountSnapshot> {
  const [a, rawContentBytes] = await Promise.all([
    sdk.account(),
    fetchRawContentBytes(sdk),
  ])
  return {
    pinnedData: a.pinnedData,
    pinnedSize: a.pinnedSize,
    rawContentBytes,
    maxPinnedData: a.maxPinnedData,
    remainingStorage: a.remainingStorage,
    fetchedAt: new Date().toISOString(),
  }
}
