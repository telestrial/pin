import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { resolveChannelImageIDs } from '../core/channelImages'
import type { SiaClient } from '../core/siaClient'
import { formatBytes } from '../lib/format'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'

// SDK default: 10 data shards × ~4 MiB each = ~40 MiB usable per slab
// (the same constant the publish handler in lib/actions/publish uses).
const SHARD_BYTES = 4 * 1024 * 1024

type SlabPiece = {
  objectID: string
  label: string
  offset: number
  length: number
}

type SlabGroup = {
  encryptionKey: string
  minShards: number
  totalShards: number
  bytesUsed: number
  capacityBytes: number
  pieces: SlabPiece[]
}

function shortKey(k: string): string {
  if (k.length <= 18) return k
  return `${k.slice(0, 10)}…${k.slice(-6)}`
}

function shortID(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

// Build a best-effort label for an object from whatever local state knows
// about it — own-channel items, pins, settings, channel cover/avatar. Objects
// the local state doesn't recognize (e.g. profile-record assets, or anything
// when the local state is empty) fall back to their metadata `kind`, then to a
// generic marker. This is enrichment only; the authoritative object set comes
// from the objectEvents walk below, so an unlabeled object still shows up.
async function buildLabelMap(client: SiaClient): Promise<Map<string, string>> {
  const labelByID = new Map<string, string>()
  const auth = useAuthStore.getState()
  const feed = useFeedStore.getState()
  const pin = usePinStore.getState()

  const myChannelIDSet = new Set(auth.myChannels.map((c) => c.channelID))
  const titleOf = (item: { title?: string; summary?: string; type: string }) =>
    item.title || (item.summary ?? '').slice(0, 40) || `(${item.type})`

  for (const e of feed.entries) {
    if (!myChannelIDSet.has(e.channel.channelID)) continue
    labelByID.set(e.item.id, `${e.channel.name} · ${titleOf(e.item)}`)
  }
  for (const p of pin.pinned) {
    if (!p.objectID) continue
    labelByID.set(p.objectID, `${p.channel.name} · ${titleOf(p.item)}`)
  }
  if (auth.settingsObjectID) labelByID.set(auth.settingsObjectID, 'Settings')

  try {
    const images = await resolveChannelImageIDs(
      client,
      auth.myChannels,
      feed.manifests,
    )
    const channelNameByID = new Map(
      auth.myChannels.map((c) => [c.channelID, c.name]),
    )
    for (const img of images.resolved) {
      labelByID.set(
        img.objectID,
        `${channelNameByID.get(img.channelID) ?? img.channelID} · ${img.kind}`,
      )
    }
  } catch {
    // image resolution is best-effort enrichment; ignore failures
  }
  return labelByID
}

export function SlabInspector() {
  const client = useAuthStore((s) => s.client)
  const account = usePinStore((s) => s.account)

  const [slabs, setSlabs] = useState<SlabGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is a manual-refresh trigger — bumping it re-runs the fetch
  useEffect(() => {
    if (!client) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const labelByID = await buildLabelMap(client)

        // Walk EVERY pinned object in scope (account-wide) via the client —
        // the same enumeration the storage meter's rawContentBytes uses. This
        // is what makes the inspector complete: it no longer depends on local
        // channel/pin state, so profile assets and anything the app has
        // forgotten still show up. (Objects the local label map doesn't know
        // fall back to a generic marker — the client's descriptor carries no
        // metadata to derive a `kind` from.)
        const pinnedObjects = await client.listPinnedObjects()

        const groups = new Map<string, SlabGroup>()
        for (const info of pinnedObjects) {
          const id: string = info.id
          const label = labelByID.get(id) ?? '(unlabeled object)'
          const objSlabs = info.slabs
          for (const s of objSlabs) {
            let g = groups.get(s.encryptionKey)
            if (!g) {
              g = {
                encryptionKey: s.encryptionKey,
                minShards: s.minShards,
                totalShards: s.sectors.length,
                bytesUsed: 0,
                capacityBytes: s.minShards * SHARD_BYTES,
                pieces: [],
              }
              groups.set(s.encryptionKey, g)
            }
            g.bytesUsed += s.length
            g.pieces.push({
              objectID: id,
              label,
              offset: s.offset,
              length: s.length,
            })
          }
        }
        if (cancelled) return
        setSlabs(
          Array.from(groups.values()).sort((a, b) => b.bytesUsed - a.bytesUsed),
        )
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load slabs')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client, refreshTick])

  if (!client) return null

  const totalUsed = slabs?.reduce((acc, s) => acc + s.bytesUsed, 0) ?? 0
  const totalCapacity = slabs?.reduce((acc, s) => acc + s.capacityBytes, 0) ?? 0
  const overallFillPct =
    totalCapacity > 0 ? (totalUsed / totalCapacity) * 100 : 0

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">
          Slabs{slabs ? ` (${slabs.length})` : ''}
        </h2>
        <button
          type="button"
          onClick={() => setRefreshTick((t) => t + 1)}
          disabled={loading}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 transition-colors cursor-pointer disabled:opacity-50"
          title="Refresh"
        >
          <RotateCw
            className={`size-3 ${loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          Refresh
        </button>
      </div>

      {slabs && slabs.length > 0 && (
        <p className="text-xs text-neutral-500">
          {formatBytes(totalUsed)} packed across {slabs.length} slab
          {slabs.length === 1 ? '' : 's'} · {overallFillPct.toFixed(1)}% used of{' '}
          {formatBytes(totalCapacity)} slab capacity
        </p>
      )}

      {/* Account-level allocation for contrast: pinnedData counts allocated
          40 MiB slabs (incl. emptied-but-unpruned ones), so it can sit far
          above the content actually packed below. A large gap = empty slabs
          awaiting pruneSlabs. */}
      {account && (
        <p className="text-xs text-neutral-400">
          Account allocation (pinnedData): {formatBytes(account.pinnedData)}
          {totalUsed > 0 &&
            account.pinnedData > totalUsed * 2 &&
            ' · gap = empty slabs awaiting prune'}
        </p>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
      {loading && !slabs && (
        <p className="text-xs text-neutral-500">Loading slabs…</p>
      )}
      {slabs && slabs.length === 0 && !loading && (
        <p className="text-xs text-neutral-500">
          No slabs found. Publish or pin an item to fill one.
        </p>
      )}

      {slabs && slabs.length > 0 && (
        <ul className="space-y-3">
          {slabs.map((g) => {
            const fillPct = Math.min(100, (g.bytesUsed / g.capacityBytes) * 100)
            return (
              <li
                key={g.encryptionKey}
                className="border border-neutral-200 rounded-md p-3 space-y-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <code
                    className="text-xs text-neutral-700 font-mono"
                    title={g.encryptionKey}
                  >
                    {shortKey(g.encryptionKey)}
                  </code>
                  <span className="text-xs text-neutral-500">
                    {g.minShards}+{g.totalShards - g.minShards} shards ·{' '}
                    {g.pieces.length} object
                    {g.pieces.length === 1 ? '' : 's'}
                  </span>
                </div>

                <div className="h-1.5 rounded-full bg-neutral-100 overflow-hidden">
                  <div
                    className="h-full bg-neutral-900"
                    style={{ width: `${Math.max(0.5, fillPct)}%` }}
                  />
                </div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-neutral-900 font-medium">
                    {formatBytes(g.bytesUsed)}
                  </span>
                  <span className="text-neutral-500">
                    of {formatBytes(g.capacityBytes)} ({fillPct.toFixed(2)}%)
                  </span>
                </div>

                <ul className="pt-2 space-y-1 border-t border-neutral-100">
                  {g.pieces.map((p, i) => (
                    <li
                      key={`${p.objectID}-${i}`}
                      className="flex items-center gap-2 text-xs"
                    >
                      <code
                        className="text-neutral-400 font-mono shrink-0"
                        title={p.objectID}
                      >
                        {shortID(p.objectID)}
                      </code>
                      <span className="text-neutral-700 truncate flex-1">
                        {p.label}
                      </span>
                      <span className="text-neutral-400 shrink-0">
                        {formatBytes(p.length)}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
