import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { LIBRARY_CHANNEL } from '../lib/pinUpload'
import { type PinnedItemRef, usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'
import { ChannelAvatar } from './ChannelAvatar'
import { kindForMime } from './AttachmentMedia'
import { formatBytes } from '../lib/format'
import { useFadeCancelUnpin } from '../lib/useFadeCancelUnpin'
import { ItemTile } from './ItemTile'
import type { TileChannel, TileSource } from './ItemTile'
import { PIN_ITEM_DRAG_TYPE } from './PinSidebar'
import { SlabInspector } from './SlabInspector'

type TileEntry = {
  item: ItemRef
  channel: TileChannel
  source: TileSource
  objectID?: string
  pinnedAt?: string
}

export function MyStorage({
  sidebar,
  rightSidebar,
  onClose,
  onItemClick,
}: {
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
  onClose: () => void
  onItemClick: (ref: PinnedItemRef) => void
}) {
  const myChannels = useAuthStore((s) => s.myChannels)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const feedEntries = useFeedStore((s) => s.entries)
  const manifests = useFeedStore((s) => s.manifests)
  const pinned = usePinStore((s) => s.pinned)
  const isPinning = usePinStore((s) => s.isPinning)
  const addToast = useToastStore((s) => s.addToast)
  const enqueue = useUploadQueueStore((s) => s.enqueue)

  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const FADE_MS = 1500
  const { removingURLs, toggle: toggleTilePinFade } = useFadeCancelUnpin({
    fadeMs: FADE_MS,
  })

  const myChannelIDSet = useMemo(
    () => new Set(myChannels.map((c) => c.channelID)),
    [myChannels],
  )

  const ownedChannelStrip = useMemo(() => {
    return myChannels
      .map((c) => {
        const items = feedEntries.filter(
          (e) => e.channel.channelID === c.channelID,
        )
        const bytes = items.reduce((sum, e) => sum + e.item.byteSize, 0)
        const sub = subscriptions.find((s) => s.channelID === c.channelID)
        return {
          channel: c,
          itemCount: items.length,
          bytes,
          authorHandle: sub?.authorHandle ?? '',
          coverArt: manifests[c.channelID]?.coverArt,
        }
      })
      .sort((a, b) => b.bytes - a.bytes)
  }, [myChannels, feedEntries, subscriptions, manifests])

  // Flat entries — external pins + library items, no own-channel items.
  // Per the rule we settled: own-channel items live "in the channel"; you
  // reach them by selecting that channel chip, not as flat tiles.
  const flatEntries = useMemo<TileEntry[]>(() => {
    return pinned
      .filter((p) => !myChannelIDSet.has(p.channel.channelID))
      .map((p) => ({
        item: p.item,
        channel: p.channel,
        source: p.channel.channelID === LIBRARY_CHANNEL.channelID
          ? ('library' as const)
          : ('external' as const),
        objectID: p.objectID,
        pinnedAt: p.pinnedAt,
      }))
      .sort((a, b) =>
        (b.pinnedAt ?? b.item.publishedAt).localeCompare(
          a.pinnedAt ?? a.item.publishedAt,
        ),
      )
  }, [pinned, myChannelIDSet])

  // Channel-filtered view: items in a single owned channel, in publish order.
  const channelEntries = useMemo<TileEntry[]>(() => {
    if (!selectedChannel) return []
    const sub = subscriptions.find((s) => s.channelID === selectedChannel)
    return feedEntries
      .filter((e) => e.channel.channelID === selectedChannel)
      .map((e) => ({
        item: e.item,
        channel: {
          authorHandle: sub?.authorHandle ?? '',
          channelID: e.channel.channelID,
          name: e.channel.name,
        },
        source: 'own' as const,
      }))
      .sort((a, b) => b.item.publishedAt.localeCompare(a.item.publishedAt))
  }, [feedEntries, selectedChannel, subscriptions])

  const tiles = selectedChannel ? channelEntries : flatEntries

  function handleUnpinClick(url: string) {
    toggleTilePinFade(url)
  }

  function buildDragHandler(entry: TileEntry) {
    return (e: React.DragEvent) => {
      const payload: PinnedItemRef = {
        item: entry.item,
        channel: entry.channel,
        objectID: entry.objectID ?? '',
        pinnedAt: entry.pinnedAt ?? '',
      }
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData(PIN_ITEM_DRAG_TYPE, JSON.stringify(payload))
    }
  }

  function isFileDrag(e: React.DragEvent): boolean {
    // OS-file drag (always advertises 'Files'); in-app item drags advertise
    // PIN_ITEM_DRAG_TYPE and shouldn't trigger the intake overlay.
    return e.dataTransfer.types.includes('Files')
  }

  function handleDragEnter(e: React.DragEvent) {
    if (!isFileDrag(e)) return
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragOver(e: React.DragEvent) {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(e: React.DragEvent) {
    if (e.currentTarget === e.target) setIsDragging(false)
  }

  async function intakeFile(file: File) {
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const mime = file.type || 'application/octet-stream'
    const type = kindForMime(mime)
    const baseTitle = file.name.replace(/\.[^/.]+$/, '') || file.name
    enqueue({
      payload: {
        type,
        title: baseTitle,
        mimeType: mime,
        bytes,
        filename: file.name,
      },
      channelIDs: [],
      destination: 'library',
    })
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    for (const file of files) {
      await intakeFile(file)
    }
    addToast(
      files.length === 1
        ? `Pinning "${files[0].name}"`
        : `Pinning ${files.length} files`,
    )
  }

  return (
    <div className="flex-1 p-6">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <div className="flex-1 min-w-0">
          <div
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative bg-white border rounded-lg p-5 space-y-5 transition-colors ${
              isDragging
                ? 'border-green-600 ring-2 ring-green-600/30'
                : 'border-neutral-200'
            }`}
          >
            {isDragging && (
              <div className="absolute inset-0 z-10 rounded-lg bg-green-50/90 flex items-center justify-center pointer-events-none">
                <p className="text-sm font-medium text-green-700">
                  Drop to add to your library
                </p>
              </div>
            )}
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-2xl font-semibold text-neutral-900">
                My Storage
              </h1>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="p-1.5 rounded-full text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 transition-colors cursor-pointer shrink-0"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>

            {ownedChannelStrip.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                <button
                  type="button"
                  onClick={() => setSelectedChannel(null)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                    selectedChannel === null
                      ? 'bg-neutral-900 text-white'
                      : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                  }`}
                >
                  All
                </button>
                {ownedChannelStrip.map(
                  ({ channel, itemCount, bytes, authorHandle, coverArt }) => {
                    const active = selectedChannel === channel.channelID
                    return (
                      <button
                        type="button"
                        key={channel.channelID}
                        onClick={() => setSelectedChannel(channel.channelID)}
                        className={`shrink-0 inline-flex items-center gap-2 pl-1.5 pr-3 py-1 rounded-full text-xs transition-colors cursor-pointer ${
                          active
                            ? 'bg-neutral-900 text-white'
                            : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                        }`}
                        title={`${itemCount} item${
                          itemCount === 1 ? '' : 's'
                        } · ${formatBytes(bytes)}`}
                      >
                        <ChannelAvatar
                          channelID={channel.channelID}
                          channelName={channel.name}
                          authorHandle={authorHandle}
                          coverArt={coverArt}
                          size="sm"
                        />
                        <span className="font-medium truncate max-w-32">
                          {channel.name}
                        </span>
                        <span
                          className={
                            active ? 'text-white/70' : 'text-neutral-500'
                          }
                        >
                          {formatBytes(bytes)}
                        </span>
                      </button>
                    )
                  },
                )}
              </div>
            )}

            {tiles.length === 0 ? (
              <p className="text-sm text-neutral-500 py-8 text-center">
                {selectedChannel
                  ? 'This channel has no items yet.'
                  : 'Pin items to keep them here.'}
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {tiles.map((entry) => {
                  const url = entry.item.itemURL
                  const canUnpin =
                    entry.source !== 'own' && !!entry.objectID
                  return (
                    <ItemTile
                      key={`${entry.channel.channelID}:${entry.item.publishedAt}`}
                      item={entry.item}
                      channel={entry.channel}
                      source={entry.source}
                      removing={removingURLs.has(url)}
                      busy={isPinning(url)}
                      onOpen={() =>
                        onItemClick({
                          item: entry.item,
                          channel: entry.channel,
                          objectID: entry.objectID ?? '',
                          pinnedAt: entry.pinnedAt ?? '',
                        })
                      }
                      onUnpin={
                        canUnpin ? () => handleUnpinClick(url) : undefined
                      }
                      onDragStart={
                        entry.item.type === 'text'
                          ? undefined
                          : buildDragHandler(entry)
                      }
                    />
                  )
                })}
              </div>
            )}

            {/* Inspection view — debug-shape, not final UX. Surfaces the
                actual slab landscape so we can see what the repacker sees
                and what's left as orphans. Remove when packing is settled. */}
            <div className="pt-5 border-t border-neutral-200">
              <SlabInspector />
            </div>
          </div>
        </div>
        {rightSidebar}
      </div>
    </div>
  )
}
