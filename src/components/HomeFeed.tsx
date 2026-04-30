import { useEffect, useMemo, useRef, useState } from 'react'
import { downloadItemBytes } from '../core/channels'
import type { FeedEntry } from '../core/feed'
import type { ItemRef } from '../core/types'
import { installAppBridge } from '../lib/appBridge'
import { APP_SANDBOX } from '../lib/constants'
import { renderMarkdown } from '../lib/markdown'
import { formatAbsolute, formatRelativeShort } from '../lib/time'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { ChannelMark } from './ChannelMark'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function useItemBytes(itemURL: string) {
  const sdk = useAuthStore((s) => s.sdk)
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sdk) return
    let cancelled = false
    setBytes(null)
    setError(null)
    downloadItemBytes(sdk, itemURL)
      .then((b) => {
        if (cancelled) return
        setBytes(b)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load')
      })
    return () => {
      cancelled = true
    }
  }, [sdk, itemURL])

  return { bytes, error }
}

function useItemBlobURL(itemURL: string, mimeType: string) {
  const { bytes, error } = useItemBytes(itemURL)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!bytes) return
    const blob = new Blob([bytes as BlobPart], { type: mimeType })
    const blobURL = URL.createObjectURL(blob)
    setUrl(blobURL)
    return () => {
      URL.revokeObjectURL(blobURL)
    }
  }, [bytes, mimeType])

  return { url, error }
}

export function HomeFeed({
  onItemClick,
  onChannelClick,
}: {
  onItemClick: (entry: FeedEntry) => void
  onChannelClick: (authorHandle: string, channelID: string) => void
}) {
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const sortOrder = useAuthStore((s) => s.feedSortOrder)
  const setSortOrder = useAuthStore((s) => s.setFeedSortOrder)
  const entries = useFeedStore((s) => s.entries)
  const errors = useFeedStore((s) => s.errors)
  const loading = useFeedStore((s) => s.loading)
  const lastRefreshedAt = useFeedStore((s) => s.lastRefreshedAt)
  const live = useFeedStore((s) => s.live)
  const refresh = useFeedStore((s) => s.refresh)

  useEffect(() => {
    if (lastRefreshedAt === null) {
      refresh(subscriptions)
    }
  }, [lastRefreshedAt, refresh, subscriptions])

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      const cmp = a.item.publishedAt.localeCompare(b.item.publishedAt)
      return sortOrder === 'oldest' ? cmp : -cmp
    })
  }, [entries, sortOrder])

  const toolbar = (
    <div className="flex items-center justify-between gap-3">
      <div
        className="flex gap-0.5 bg-neutral-100 rounded-md p-0.5"
        role="tablist"
        aria-label="Sort feed"
      >
        {(['newest', 'oldest'] as const).map((order) => {
          const active = sortOrder === order
          return (
            <button
              key={order}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSortOrder(order)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                active
                  ? 'bg-white text-neutral-900 shadow-sm'
                  : 'text-neutral-600 hover:text-neutral-900'
              }`}
            >
              {order === 'newest' ? 'Newest' : 'Oldest'}
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        {live ? (
          <span className="hidden sm:inline-flex items-center gap-1.5">
            <span className="relative flex size-1.5">
              <span className="animate-ping absolute inline-flex size-full rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex rounded-full size-1.5 bg-green-600" />
            </span>
            Live
          </span>
        ) : (
          <span className="hidden sm:inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-neutral-400" />
            Offline
          </span>
        )}
        <button
          type="button"
          onClick={() => refresh(subscriptions)}
          disabled={loading}
          className="relative px-2.5 py-1 text-xs font-medium text-neutral-700 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors disabled:opacity-50"
        >
          <span className={loading ? 'invisible' : ''}>Refresh</span>
          {loading && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="size-3 border-2 border-neutral-300 border-t-neutral-700 rounded-full animate-spin" />
            </span>
          )}
        </button>
      </div>
    </div>
  )

  if (loading && entries.length === 0 && errors.length === 0) {
    return (
      <div className="border border-neutral-200 rounded-lg bg-white p-4 space-y-4">
        {toolbar}
        <p className="text-neutral-500 text-sm">Loading feed…</p>
      </div>
    )
  }

  return (
    <div className="border border-neutral-200 rounded-lg bg-white p-4 space-y-4">
      {toolbar}
      {errors.length > 0 && (
        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-800 text-xs space-y-1">
          <p className="font-medium">
            {errors.length} channel{errors.length === 1 ? '' : 's'} failed to
            load
          </p>
          <ul className="space-y-0.5">
            {errors.map((e) => (
              <li
                key={`${e.authorHandle}/${e.channelID}`}
                className="wrap-break-word"
              >
                {e.label || `${e.authorHandle}/${e.channelID}`}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sortedEntries.length > 0 ? (
        <ul className="divide-y divide-neutral-200/80">
          {sortedEntries.map((entry) => (
            <FeedRow
              key={entry.item.id}
              entry={entry}
              onItemClick={onItemClick}
              onChannelClick={onChannelClick}
            />
          ))}
        </ul>
      ) : (
        <p className="text-neutral-500 text-sm">
          No items yet from your subscriptions.
        </p>
      )}
    </div>
  )
}

function NoteBody({ item }: { item: ItemRef }) {
  const html = useMemo(() => renderMarkdown(item.summary ?? ''), [item.summary])
  return (
    <div
      className="markdown wrap-break-word text-sm text-neutral-900"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via DOMPurify
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function ImageBody({ item }: { item: ItemRef }) {
  const { url, error } = useItemBlobURL(item.itemURL, item.mimeType)
  if (error) return <p className="text-xs text-red-600">{error}</p>
  if (!url)
    return (
      <div className="w-full h-48 bg-neutral-100 rounded-lg animate-pulse" />
    )
  return (
    <img
      src={url}
      alt={item.title}
      className="block w-full max-h-96 object-contain rounded-lg border border-neutral-200 bg-neutral-50"
    />
  )
}

function AudioBody({ item }: { item: ItemRef }) {
  const { url, error } = useItemBlobURL(item.itemURL, item.mimeType)
  if (error) return <p className="text-xs text-red-600">{error}</p>
  if (!url)
    return <div className="w-full h-14 bg-neutral-100 rounded animate-pulse" />
  return (
    <audio
      controls
      src={url}
      onClick={(e) => e.stopPropagation()}
      className="w-full"
    >
      <track kind="captions" />
    </audio>
  )
}

function VideoBody({ item }: { item: ItemRef }) {
  const { url, error } = useItemBlobURL(item.itemURL, item.mimeType)
  if (error) return <p className="text-xs text-red-600">{error}</p>
  if (!url)
    return (
      <div className="w-full aspect-video bg-neutral-100 rounded-lg animate-pulse" />
    )
  return (
    <video
      controls
      src={url}
      onClick={(e) => e.stopPropagation()}
      className="w-full max-h-96 rounded-lg border border-neutral-200 bg-black"
    >
      <track kind="captions" />
    </video>
  )
}

function AppBody({ item }: { item: ItemRef }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const { bytes, error } = useItemBytes(item.itemURL)
  const html = useMemo(
    () => (bytes ? new TextDecoder().decode(bytes) : null),
    [bytes],
  )

  useEffect(() => {
    return installAppBridge(() => iframeRef.current, item.id)
  }, [item.id])

  if (error) return <p className="text-xs text-red-600">{error}</p>
  if (!html)
    return (
      <div className="w-full aspect-4/3 bg-neutral-100 rounded-lg animate-pulse" />
    )
  return (
    <iframe
      ref={iframeRef}
      title={item.title}
      srcDoc={html}
      sandbox={APP_SANDBOX}
      allow="fullscreen"
      className="w-full aspect-4/3 rounded-lg border border-neutral-200 bg-white"
    />
  )
}

function FileBody({ item }: { item: ItemRef }) {
  const sdk = useAuthStore((s) => s.sdk)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDownload(e: React.MouseEvent) {
    e.stopPropagation()
    if (!sdk) return
    setDownloading(true)
    setError(null)
    try {
      const bytes = await downloadItemBytes(sdk, item.itemURL)
      const blob = new Blob([bytes as BlobPart], { type: item.mimeType })
      const blobURL = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobURL
      a.download = item.filename ?? item.title
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(blobURL)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to download')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex items-center gap-3 p-3 bg-neutral-50 border border-neutral-200 rounded-lg">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-neutral-900 truncate">
          {item.filename ?? item.title}
        </p>
        <p className="text-xs text-neutral-500">
          {item.mimeType} · {formatBytes(item.byteSize)}
        </p>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 text-white rounded transition-colors shrink-0"
      >
        {downloading ? 'Downloading…' : 'Download'}
      </button>
    </div>
  )
}

function typeLabel(item: ItemRef): string {
  if (item.type === 'text') return item.title === '' ? 'Note' : 'Post'
  return item.type.charAt(0).toUpperCase() + item.type.slice(1)
}

function renderBody(item: ItemRef): React.ReactNode {
  if (item.type === 'text') {
    if (item.title === '') return <NoteBody item={item} />
    return item.summary ? (
      <p className="text-sm text-neutral-600">{item.summary}</p>
    ) : null
  }
  if (item.type === 'image') return <ImageBody item={item} />
  if (item.type === 'audio') return <AudioBody item={item} />
  if (item.type === 'video') return <VideoBody item={item} />
  if (item.type === 'app') return <AppBody item={item} />
  if (item.type === 'file') return <FileBody item={item} />
  return null
}

export function FeedRow({
  entry,
  onItemClick,
  onChannelClick,
}: {
  entry: FeedEntry
  onItemClick: (entry: FeedEntry) => void
  onChannelClick: (authorHandle: string, channelID: string) => void
}) {
  const { item, channel } = entry
  const isNote = item.type === 'text' && item.title === ''
  const showTitle = !isNote && !!item.title

  const handleChannelClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    onChannelClick(channel.authorHandle, channel.channelID)
  }

  const inner = (
    <div className="flex gap-3">
      <button
        type="button"
        onClick={handleChannelClick}
        className="self-start shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-green-600 cursor-pointer"
        aria-label={`View channel ${channel.name}`}
      >
        <ChannelMark
          channelID={channel.channelID}
          channelName={channel.name}
          authorHandle={channel.authorHandle}
        />
      </button>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <button
              type="button"
              onClick={handleChannelClick}
              className="block max-w-full text-sm font-semibold text-neutral-900 truncate hover:underline cursor-pointer text-left"
            >
              {channel.name}
            </button>
            {showTitle && (
              <p className="text-base font-semibold text-neutral-900 wrap-break-word">
                {item.title}
              </p>
            )}
            <button
              type="button"
              onClick={handleChannelClick}
              className="block max-w-full text-xs text-neutral-500 truncate hover:underline cursor-pointer text-left"
            >
              @{channel.authorHandle}
            </button>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-medium px-2 py-0.5 bg-neutral-100 text-neutral-600 rounded-full whitespace-nowrap">
              {typeLabel(item)}
            </span>
            <p
              className="text-xs text-neutral-500 whitespace-nowrap"
              title={formatAbsolute(item.publishedAt)}
            >
              {formatRelativeShort(item.publishedAt)}
            </p>
          </div>
        </div>
        {renderBody(item)}
      </div>
    </div>
  )

  if (isNote) {
    return (
      <li>
        <div className="py-4 px-2 -mx-2">{inner}</div>
      </li>
    )
  }

  return (
    <li>
      {/* biome-ignore lint/a11y/useSemanticElements: row contains nested interactives (audio/video controls, download button) so a button element would nest interactives */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onItemClick(entry)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onItemClick(entry)
          }
        }}
        className="py-4 px-2 -mx-2 rounded hover:bg-neutral-50 cursor-pointer transition-colors"
      >
        {inner}
      </div>
    </li>
  )
}
