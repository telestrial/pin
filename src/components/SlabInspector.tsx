import { RotateCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'

// SDK default: 10 data shards × ~4 MiB each = ~40 MiB usable per slab
// (the same constant useUploadRunner.expectedShardCount uses).
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function shortKey(k: string): string {
  if (k.length <= 18) return k
  return `${k.slice(0, 10)}…${k.slice(-6)}`
}

function shortID(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

export function SlabInspector() {
  const sdk = useAuthStore((s) => s.sdk)
  const myChannels = useAuthStore((s) => s.myChannels)
  const feedEntries = useFeedStore((s) => s.entries)
  const pinned = usePinStore((s) => s.pinned)

  const [slabs, setSlabs] = useState<SlabGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)

  const candidates = useMemo(() => {
    const items: { id: string; label: string }[] = []
    const myChannelIDSet = new Set(myChannels.map((c) => c.channelID))
    for (const e of feedEntries) {
      if (!myChannelIDSet.has(e.channel.channelID)) continue
      const title =
        e.item.title || (e.item.summary ?? '').slice(0, 40) || `(${e.item.type})`
      items.push({ id: e.item.id, label: `${e.channel.name} · ${title}` })
    }
    for (const p of pinned) {
      if (!p.objectID) continue
      const title =
        p.item.title || (p.item.summary ?? '').slice(0, 40) || `(${p.item.type})`
      items.push({ id: p.objectID, label: `${p.channel.name} · ${title}` })
    }
    const seen = new Set<string>()
    return items.filter((x) => {
      if (seen.has(x.id)) return false
      seen.add(x.id)
      return true
    })
  }, [myChannels, feedEntries, pinned])

  useEffect(() => {
    if (!sdk) return
    let cancelled = false
    setLoading(true)
    setError(null)

    ;(async () => {
      try {
        const groups = new Map<string, SlabGroup>()
        await Promise.all(
          candidates.map(async ({ id, label }) => {
            try {
              const obj = await sdk.object(id)
              const objSlabs = obj.slabs()
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
            } catch (e) {
              console.warn(`slab fetch failed for ${id}:`, e)
            }
          }),
        )
        if (cancelled) return
        const result = Array.from(groups.values()).sort(
          (a, b) => b.bytesUsed - a.bytesUsed,
        )
        setSlabs(result)
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
  }, [sdk, candidates, refreshTick])

  if (!sdk) return null

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
