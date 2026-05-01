import { CheckCircle2, HardDrive, RotateCw, X } from 'lucide-react'
import { useMemo } from 'react'
import { type PinnedItemRef, usePinStore } from '../stores/pin'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { useToastStore } from '../stores/toast'
import {
  type UploadTask,
  type UploadTaskState,
  useUploadQueueStore,
} from '../stores/uploadQueue'
import type { ChannelCover } from '../core/types'
import { ChannelAvatar } from './ChannelAvatar'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function pinTitle(ref: PinnedItemRef): string {
  if (ref.item.title) return ref.item.title
  if (ref.item.summary) return ref.item.summary
  return '(untitled)'
}

function typeLabel(ref: PinnedItemRef): string {
  if (ref.item.type === 'text') return ref.item.title === '' ? 'Note' : 'Post'
  return ref.item.type.charAt(0).toUpperCase() + ref.item.type.slice(1)
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

  const coverByChannelID = useMemo(() => {
    const map = new Map<string, ChannelCover>()
    for (const e of feedEntries) {
      if (e.channel.coverArt && !map.has(e.channel.channelID)) {
        map.set(e.channel.channelID, e.channel.coverArt)
      }
    }
    return map
  }, [feedEntries])

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
          coverArt: coverByChannelID.get(c.channelID),
        }
      })
      .sort((a, b) => b.bytes - a.bytes)
  }, [myChannels, feedEntries, subscriptions, coverByChannelID])

  const inFlight = [...tasks].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )

  const sorted = [...pinned].sort((a, b) =>
    b.pinnedAt.localeCompare(a.pinnedAt),
  )

  const pct =
    account && account.maxPinnedData > 0
      ? Math.min(100, (account.pinnedData / account.maxPinnedData) * 100)
      : 0

  const handleUnpin = async (e: React.MouseEvent, itemURL: string) => {
    e.stopPropagation()
    if (!sdk) return
    try {
      await unpin(sdk, itemURL)
      addToast('Unpinned')
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Unpin failed')
    }
  }

  return (
    <aside className="w-full xl:w-64 shrink-0 border border-neutral-200 rounded-lg bg-white p-3 space-y-5">
      <section className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          <HardDrive
            className="size-3.5 text-neutral-500"
            aria-hidden="true"
          />
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
          <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-500 px-1">
            Your channels
          </h2>
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

      <section className="space-y-2">
        <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-500 px-1">
          Pinned
        </h2>
        {sorted.length === 0 ? (
          <p className="text-xs text-neutral-500 px-1">
            Pin items to keep them in your storage.
          </p>
        ) : (
          <ul aria-label="Pinned items">
            {sorted.map((ref) => {
              const url = ref.item.itemURL
              const busy = isPinning(url)
              return (
                <li key={url} className="group relative">
                  <button
                    type="button"
                    onClick={() => onItemClick?.(ref)}
                    disabled={!onItemClick}
                    className="w-full px-2 py-1.5 rounded transition-colors text-left flex items-start gap-2 enabled:hover:bg-neutral-50 enabled:cursor-pointer"
                  >
                    <ChannelAvatar
                      channelID={ref.channel.channelID}
                      channelName={ref.channel.name}
                      authorHandle={ref.channel.authorHandle}
                      coverArt={coverByChannelID.get(ref.channel.channelID)}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-xs font-medium text-neutral-900 truncate">
                        {pinTitle(ref)}
                      </p>
                      <p className="text-[10px] text-neutral-500 truncate">
                        {ref.channel.name} · {typeLabel(ref)}
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleUnpin(e, url)}
                    disabled={busy || !sdk}
                    title="Unpin"
                    aria-label={`Unpin ${pinTitle(ref)}`}
                    className="absolute top-1.5 right-1.5 p-1 rounded text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-50"
                  >
                    {busy ? (
                      <span className="block size-3 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin" />
                    ) : (
                      <X className="size-3" aria-hidden="true" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </aside>
  )
}
