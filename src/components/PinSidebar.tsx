import { Box, CheckCircle2, HardDrive, RotateCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type PinnedItemRef, usePinStore } from '../stores/pin'
import type { ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useComposeStore } from '../stores/compose'
import {
  type UploadTask,
  type UploadTaskState,
  useUploadQueueStore,
} from '../stores/uploadQueue'
import { useStorageActivityStore } from '../stores/storageActivity'
import { formatBytes } from '../lib/format'
import { useFadeCancelUnpin } from '../lib/useFadeCancelUnpin'
import { PinIcon } from './PinIcon'

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
  if (item.type === 'text') return 'Post'
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
  onStorageClick,
}: {
  onItemClick?: (ref: PinnedItemRef) => void
  onStorageClick?: () => void
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const myChannels = useAuthStore((s) => s.myChannels)
  const account = usePinStore((s) => s.account)
  const pinned = usePinStore((s) => s.pinned)
  const isPinning = usePinStore((s) => s.isPinning)
  const tasks = useUploadQueueStore((s) => s.tasks)
  const retryTask = useUploadQueueStore((s) => s.retry)
  const removeTask = useUploadQueueStore((s) => s.remove)
  const armedItem = useComposeStore((s) => s.armedItem)
  const toggleArm = useComposeStore((s) => s.toggle)
  const disarm = useComposeStore((s) => s.disarm)
  const storageActive = useStorageActivityStore(
    (s) => s.running || s.sweeping || s.savingSettings,
  )
  // Click-pin → opacity transitions to 0 over FADE_MS, then unpin commits.
  // Re-click during the fade cancels (clean undo). Shared with MyStorage's
  // tile pin via the hook.
  const FADE_MS = 1500
  const { removingURLs, toggle: togglePinFade } = useFadeCancelUnpin({
    fadeMs: FADE_MS,
  })
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

  const inFlight = [...tasks].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )

  const myChannelIDSet = useMemo(
    () => new Set(myChannels.map((c) => c.channelID)),
    [myChannels],
  )

  // "Last 5 things you pinned" — most recent external pins. Library items
  // (LIBRARY_CHANNEL) ride along since they're also things you pinned.
  // Own-channel items are excluded — those are managed in the channel UX.
  const RECENT_LIMIT = 5
  const recentPins = useMemo<LibraryEntry[]>(() => {
    return pinned
      .filter((p) => !myChannelIDSet.has(p.channel.channelID))
      .map((p) => ({
        item: p.item,
        channel: p.channel,
        isOwn: false,
        pinnedAt: p.pinnedAt,
      }))
      .sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''))
      .slice(0, RECENT_LIMIT)
  }, [pinned, myChannelIDSet])

  const displayList = recentPins

  // rawContentBytes is the actual byte total across every pinned object in
  // scope (computed by walking objectEvents + summing slab lengths), so it
  // accounts for everything Sia is storing for the user — post bodies,
  // attachments, channel covers, profile assets, settings — without any
  // schema-field-summing guesswork. Slab-allocation vocabulary belongs in
  // My Storage proper, not on this calm-sidebar surface.
  const pct =
    account && account.maxPinnedData > 0
      ? Math.min(100, (account.rawContentBytes / account.maxPinnedData) * 100)
      : 0

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

  function handlePinIconClick(e: React.MouseEvent, url: string) {
    e.stopPropagation()
    togglePinFade(url)
  }

  return (
    <aside className="w-full lg:w-64 lg:ml-auto shrink-0 border border-neutral-200 rounded-lg bg-white p-3 space-y-5">
      <section>
        {/* biome-ignore lint/a11y/useSemanticElements: clickable region wraps a heading + progress bar; a button element would nest a heading inside an interactive control */}
        <div
          role={onStorageClick ? 'button' : undefined}
          tabIndex={onStorageClick ? 0 : undefined}
          onClick={onStorageClick}
          onKeyDown={
            onStorageClick
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onStorageClick()
                  }
                }
              : undefined
          }
          className={`-mx-1 px-2 py-1.5 rounded-md space-y-2 transition-colors ${
            onStorageClick ? 'cursor-pointer hover:bg-neutral-50' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <HardDrive
              className="size-3.5 text-neutral-500"
              aria-hidden="true"
            />
            <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-500">
              My Storage
            </h2>
          </div>
          <div className="space-y-2">
            <div className="h-1.5 rounded-full bg-neutral-100 overflow-hidden">
              <div
                className="h-full bg-green-600 transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            {account ? (
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="text-neutral-900 font-medium">
                    {formatBytes(account.rawContentBytes)}
                  </span>
                  {/* Always rendered to reserve layout space — opacity toggles
                      so the size number doesn't shift when packing starts. */}
                  <Box
                    className={`size-3.5 text-neutral-500 transition-opacity duration-300 ${
                      storageActive ? 'opacity-100' : 'opacity-0'
                    }`}
                    aria-hidden={!storageActive}
                    aria-label={storageActive ? 'Saving to Sia' : undefined}
                  />
                </span>
                <span className="text-neutral-500">
                  of {formatBytes(account.maxPinnedData)}
                </span>
              </div>
            ) : (
              <p className="text-xs text-neutral-500">Loading…</p>
            )}
          </div>
        </div>
      </section>

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
        <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-500 px-3 pt-3 pb-1">
          Recent pins
        </h2>
        {displayList.length === 0 ? (
          <p className="text-xs text-neutral-500 px-3 py-2">
            Pin items from other channels to keep them here.
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
                <li
                  key={`${entry.channel.channelID}:${entry.item.publishedAt}`}
                >
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
                      armed ? 'bg-[#FDF1CC]' : 'hover:bg-neutral-50'
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
                        className="shrink-0 self-center p-1 rounded text-green-600 hover:bg-green-50 cursor-pointer disabled:opacity-50"
                      >
                        {busy ? (
                          <span className="block size-5 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin" />
                        ) : (
                          <PinIcon
                            className={removing ? '' : 'fill-current'}
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
