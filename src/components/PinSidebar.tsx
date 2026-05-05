import { CheckCircle2, HardDrive, Pin, RotateCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type PinnedItemRef, usePinStore } from '../stores/pin'
import type { ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useComposeStore } from '../stores/compose'
import { useFeedStore } from '../stores/feed'
import { useToastStore } from '../stores/toast'
import {
  type UploadTask,
  type UploadTaskState,
  useUploadQueueStore,
} from '../stores/uploadQueue'
import { ChannelAvatar } from './ChannelAvatar'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function itemTitle(item: ItemRef): string {
  if (item.title) return item.title
  if (item.summary) return item.summary
  return '(untitled)'
}

export const PIN_ITEM_DRAG_TYPE = 'application/x-pin-item'

function isDraggableItem(item: ItemRef): boolean {
  return item.type !== 'text'
}

function itemTypeLabel(item: ItemRef): string {
  if (item.type === 'text') return item.title === '' ? 'Note' : 'Post'
  return item.type.charAt(0).toUpperCase() + item.type.slice(1)
}

type LibraryEntry = {
  item: ItemRef
  channel: {
    channelID: string
    name: string
    authorHandle: string
  }
  isOwn: boolean
  pinnedAt?: string
}

function taskTitle(task: UploadTask): string {
  const p = task.payload
  if (p.title) return p.title
  if (p.summary) return p.summary.slice(0, 60)
  if (p.filename) return p.filename
  return 'item'
}

function taskStateLabel(state: UploadTaskState): string {
  if (state === 'pending') return 'Queued'
  if (state === 'uploading') return 'Uploading'
  if (state === 'publishing') return 'Publishing'
  if (state === 'success') return 'Published'
  return 'Failed'
}

export function PinSidebar({
  onItemClick,
  onChannelClick,
  activeChannelID,
}: {
  onItemClick?: (ref: PinnedItemRef) => void
  onChannelClick?: (authorHandle: string, channelID: string) => void
  activeChannelID?: string
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const myChannels = useAuthStore((s) => s.myChannels)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const account = usePinStore((s) => s.account)
  const pinned = usePinStore((s) => s.pinned)
  const isPinning = usePinStore((s) => s.isPinning)
  const unpin = usePinStore((s) => s.unpin)
  const addToast = useToastStore((s) => s.addToast)
  const tasks = useUploadQueueStore((s) => s.tasks)
  const retryTask = useUploadQueueStore((s) => s.retry)
  const removeTask = useUploadQueueStore((s) => s.remove)
  const feedEntries = useFeedStore((s) => s.entries)
  const manifests = useFeedStore((s) => s.manifests)
  const armedItem = useComposeStore((s) => s.armedItem)
  const toggleArm = useComposeStore((s) => s.toggle)
  const disarm = useComposeStore((s) => s.disarm)
  const [query, setQuery] = useState('')
  // Rows that have been click-pinned-off — opacity transitions to 0 over
  // FADE_MS, then we call unpin. Re-clicking the pin icon during that window
  // cancels the timeout and restores opacity (clean undo).
  const [removingURLs, setRemovingURLs] = useState<Set<string>>(new Set())
  const removeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  )
  // Rows that have just appeared since the last render — `animate-pin-enter`
  // class drives a CSS keyframe fade-in over the same FADE_MS as removal.
  // knownURLsRef is the set of URLs already settled; initializedRef gates
  // off the first render (so we don't animate every existing row on mount).
  const [enteringURLs, setEnteringURLs] = useState<Set<string>>(new Set())
  const knownURLsRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)

  // Esc clears the armed state regardless of focus — once you've loaded
  // an item, you can always abandon it. Scoped to whenever the sidebar
  // is mounted, which is "every middle-gutter screen" per FormCard.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && armedItem) {
        disarm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [armedItem, disarm])

  const ownedChannelStorage = useMemo(() => {
    return myChannels
      .map((c) => {
        const items = feedEntries.filter(
          (e) => e.channel.channelID === c.channelID,
        )
        const bytes = items.reduce((sum, e) => sum + e.item.byteSize, 0)
        const sub = subscriptions.find((s) => s.channelID === c.channelID)
        return {
          channel: c,
          bytes,
          itemCount: items.length,
          authorHandle: sub?.authorHandle ?? '',
          coverArt: manifests[c.channelID]?.coverArt,
        }
      })
      .sort((a, b) => b.bytes - a.bytes)
  }, [myChannels, feedEntries, subscriptions, manifests])

  const inFlight = [...tasks].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )

  const myChannelIDSet = useMemo(
    () => new Set(myChannels.map((c) => c.channelID)),
    [myChannels],
  )

  const ownItems = useMemo<LibraryEntry[]>(() => {
    return feedEntries
      .filter((e) => myChannelIDSet.has(e.channel.channelID))
      .map((e) => ({
        item: e.item,
        channel: {
          channelID: e.channel.channelID,
          name: e.channel.name,
          authorHandle: e.channel.authorHandle,
        },
        isOwn: true,
      }))
  }, [feedEntries, myChannelIDSet])

  const ownItemURLSet = useMemo(
    () => new Set(ownItems.map((e) => e.item.itemURL)),
    [ownItems],
  )

  const externalPins = useMemo<LibraryEntry[]>(() => {
    return pinned
      .filter((p) => !ownItemURLSet.has(p.item.itemURL))
      .map((p) => ({
        item: p.item,
        channel: p.channel,
        isOwn: false,
        pinnedAt: p.pinnedAt,
      }))
      .sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''))
  }, [pinned, ownItemURLSet])

  const q = query.trim().toLowerCase()

  function matchesQuery(e: LibraryEntry): boolean {
    const fields = [
      itemTitle(e.item),
      e.item.title,
      e.item.summary ?? '',
      e.item.filename ?? '',
      e.channel.name,
      e.channel.authorHandle,
      itemTypeLabel(e.item),
    ]
    return fields.some((f) => f.toLowerCase().includes(q))
  }

  const displayList: LibraryEntry[] = q
    ? [...externalPins, ...ownItems]
        .filter(matchesQuery)
        .sort((a, b) =>
          (b.pinnedAt ?? b.item.publishedAt).localeCompare(
            a.pinnedAt ?? a.item.publishedAt,
          ),
        )
    : externalPins

  const pct =
    account && account.maxPinnedData > 0
      ? Math.min(100, (account.pinnedData / account.maxPinnedData) * 100)
      : 0

  const FADE_MS = 1500

  // Detect rows that just appeared in displayList — apply the
  // animate-pin-enter class for FADE_MS so they fade in symmetrically
  // with the click-to-unpin fade-out. The first render is special-cased:
  // every visible URL gets marked "known" without animating, so we don't
  // wash everything in on initial mount.
  useEffect(() => {
    if (!initializedRef.current) {
      for (const e of displayList) knownURLsRef.current.add(e.item.itemURL)
      initializedRef.current = true
      return
    }
    const newURLs: string[] = []
    for (const e of displayList) {
      const url = e.item.itemURL
      if (!knownURLsRef.current.has(url)) {
        newURLs.push(url)
        knownURLsRef.current.add(url)
      }
    }
    if (newURLs.length === 0) return
    setEnteringURLs((prev) => {
      const next = new Set(prev)
      for (const url of newURLs) next.add(url)
      return next
    })
    const id = setTimeout(() => {
      setEnteringURLs((prev) => {
        const next = new Set(prev)
        for (const url of newURLs) next.delete(url)
        return next
      })
    }, FADE_MS)
    return () => clearTimeout(id)
  }, [displayList])

  function startRemove(url: string) {
    setRemovingURLs((prev) => {
      const next = new Set(prev)
      next.add(url)
      return next
    })
    const id = setTimeout(async () => {
      removeTimers.current.delete(url)
      if (!sdk) return
      try {
        await unpin(sdk, url)
      } catch (err) {
        // Restore opacity on failure so the user can retry.
        setRemovingURLs((prev) => {
          const next = new Set(prev)
          next.delete(url)
          return next
        })
        addToast(err instanceof Error ? err.message : 'Unpin failed')
      }
    }, FADE_MS)
    removeTimers.current.set(url, id)
  }

  function cancelRemove(url: string) {
    const id = removeTimers.current.get(url)
    if (id !== undefined) {
      clearTimeout(id)
      removeTimers.current.delete(url)
    }
    setRemovingURLs((prev) => {
      const next = new Set(prev)
      next.delete(url)
      return next
    })
  }

  function handlePinIconClick(e: React.MouseEvent, url: string) {
    e.stopPropagation()
    if (removingURLs.has(url)) {
      cancelRemove(url)
    } else {
      startRemove(url)
    }
  }

  return (
    <aside className="w-full lg:w-64 shrink-0 border border-neutral-200 rounded-lg bg-white p-3 space-y-5">
      <section className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          <HardDrive className="size-3.5 text-neutral-500" aria-hidden="true" />
          <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-500">
            Your storage
          </h2>
        </div>
        <div className="px-1 space-y-2">
          <div
            className="h-1.5 rounded-full bg-neutral-100 overflow-hidden"
            title={
              account
                ? `${formatBytes(account.pinnedSize)} encoded on the network`
                : undefined
            }
          >
            <div
              className="h-full bg-green-600 transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          {account ? (
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-neutral-900 font-medium">
                {formatBytes(account.pinnedData)}
              </span>
              <span className="text-neutral-500">
                of {formatBytes(account.maxPinnedData)}
              </span>
            </div>
          ) : (
            <p className="text-xs text-neutral-500">Loading…</p>
          )}
        </div>
      </section>

      {ownedChannelStorage.length > 0 && (
        <section className="space-y-2">
          <ul aria-label="Your channels">
            {ownedChannelStorage.map(
              ({ channel, bytes, itemCount, authorHandle, coverArt }) => {
                const active = channel.channelID === activeChannelID
                return (
                  <li key={channel.channelID}>
                    <button
                      type="button"
                      onClick={() =>
                        authorHandle &&
                        onChannelClick?.(authorHandle, channel.channelID)
                      }
                      disabled={!onChannelClick || !authorHandle}
                      className="w-full px-2 py-1.5 rounded transition-colors text-left flex items-start gap-2 enabled:hover:bg-neutral-50 enabled:cursor-pointer disabled:opacity-50"
                    >
                      <ChannelAvatar
                        channelID={channel.channelID}
                        channelName={channel.name}
                        authorHandle={authorHandle}
                        coverArt={coverArt}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-xs font-medium text-neutral-900 truncate">
                          {channel.name}
                        </p>
                        <p className="text-[10px] text-neutral-500 truncate">
                          {itemCount === 0
                            ? 'Empty'
                            : `${itemCount} item${itemCount === 1 ? '' : 's'} · ${formatBytes(bytes)}`}
                        </p>
                      </div>
                      {active && (
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-neutral-900 shrink-0 mt-2"
                        />
                      )}
                    </button>
                  </li>
                )
              },
            )}
          </ul>
        </section>
      )}

      {inFlight.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-500 px-1">
            In flight
          </h2>
          <ul aria-label="Upload queue">
            {inFlight.map((task) => {
              const stateColor =
                task.state === 'failed'
                  ? 'text-red-600'
                  : task.state === 'success'
                    ? 'text-green-600'
                    : 'text-neutral-500'
              const showProgress =
                task.state === 'uploading' || task.state === 'publishing'
              return (
                <li
                  key={task.id}
                  className="px-2 py-1.5 rounded space-y-1 bg-neutral-50/60"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-neutral-900 truncate">
                        {taskTitle(task)}
                      </p>
                      <p className={`text-[10px] ${stateColor} truncate`}>
                        {taskStateLabel(task.state)}
                        {task.state === 'success' && (
                          <CheckCircle2 className="inline size-3 ml-1 align-text-bottom" />
                        )}
                        {task.error ? ` — ${task.error}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {task.state === 'failed' && (
                        <button
                          type="button"
                          onClick={() => retryTask(task.id)}
                          title="Retry"
                          aria-label={`Retry ${taskTitle(task)}`}
                          className="p-1 rounded text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100"
                        >
                          <RotateCw className="size-3" aria-hidden="true" />
                        </button>
                      )}
                      {task.state !== 'uploading' &&
                        task.state !== 'publishing' && (
                          <button
                            type="button"
                            onClick={() => removeTask(task.id)}
                            title="Dismiss"
                            aria-label={`Dismiss ${taskTitle(task)}`}
                            className="p-1 rounded text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100"
                          >
                            <X className="size-3" aria-hidden="true" />
                          </button>
                        )}
                    </div>
                  </div>
                  {showProgress && (
                    <div className="h-1 rounded-full bg-neutral-200 overflow-hidden">
                      <div
                        className="h-full bg-green-600 transition-[width] duration-200"
                        style={{ width: `${Math.max(2, task.progress)}%` }}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="-mx-3 -mb-3 border-t border-neutral-200">
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 size-3 text-neutral-400 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search your library"
            className="w-full pl-7 pr-2 py-2 text-xs bg-white border-0 border-b border-neutral-200 focus:outline-none focus:border-green-600 placeholder-neutral-400"
          />
        </div>
        {displayList.length === 0 ? (
          <p className="text-xs text-neutral-500 px-3 py-2">
            {q
              ? 'No matches.'
              : 'Pin items from other channels to keep them here.'}
          </p>
        ) : (
          <ul aria-label="Library items">
            {displayList.map((entry) => {
              const url = entry.item.itemURL
              const busy = isPinning(url)
              const draggable = isDraggableItem(entry.item)
              const dragPayload: PinnedItemRef = {
                item: entry.item,
                channel: entry.channel,
                objectID: '',
                pinnedAt: entry.pinnedAt ?? '',
              }
              const armed = armedItem?.item.itemURL === url
              const removing = removingURLs.has(url)
              const entering = enteringURLs.has(url)
              return (
                <li key={url}>
                  {/* biome-ignore lint/a11y/useSemanticElements: row contains nested interactive buttons (title link, unpin pin) so a button element would nest interactives */}
                  <div
                    role="button"
                    tabIndex={0}
                    data-pin-item-row="true"
                    draggable={draggable}
                    onDragStart={
                      draggable
                        ? (e) => {
                            e.dataTransfer.effectAllowed = 'copy'
                            e.dataTransfer.setData(
                              PIN_ITEM_DRAG_TYPE,
                              JSON.stringify(dragPayload),
                            )
                          }
                        : undefined
                    }
                    onClick={() => toggleArm(dragPayload)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleArm(dragPayload)
                      }
                    }}
                    title={
                      armed
                        ? 'Click again to unload · Esc cancels'
                        : 'Click to load as a link target'
                    }
                    className={`px-3 py-2 transition-opacity duration-1500 cursor-pointer flex items-start gap-2 ${
                      armed ? 'bg-[#FDF4D1]' : 'hover:bg-neutral-50'
                    } ${removing ? 'opacity-0' : 'opacity-100'} ${
                      entering ? 'animate-pin-enter' : ''
                    }`}
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      {onItemClick ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onItemClick(dragPayload)
                          }}
                          className="block max-w-full text-xs font-medium text-neutral-900 truncate text-left hover:underline cursor-pointer"
                        >
                          {itemTitle(entry.item)}
                        </button>
                      ) : (
                        <p className="text-xs font-medium text-neutral-900 truncate">
                          {itemTitle(entry.item)}
                        </p>
                      )}
                      <p className="text-[10px] text-neutral-500 truncate">
                        {entry.channel.name} · {itemTypeLabel(entry.item)}
                      </p>
                    </div>
                    {!entry.isOwn && (
                      <button
                        type="button"
                        onClick={(e) => handlePinIconClick(e, url)}
                        disabled={busy || !sdk}
                        title={removing ? 'Click to undo · Pin back' : 'Unpin'}
                        aria-label={
                          removing
                            ? `Re-pin ${itemTitle(entry.item)}`
                            : `Unpin ${itemTitle(entry.item)}`
                        }
                        className="shrink-0 self-center p-1 rounded text-green-600 hover:text-green-700 hover:bg-green-50 cursor-pointer disabled:opacity-50"
                      >
                        {busy ? (
                          <span className="block size-3.5 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin" />
                        ) : (
                          <Pin
                            className={`size-3.5 ${removing ? '' : 'fill-current'}`}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </aside>
  )
}
