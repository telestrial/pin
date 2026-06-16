import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { LIBRARY_CHANNEL } from '../lib/pinUpload'
import { type PinnedItemRef, usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'
import { kindForMime } from './AttachmentMedia'
import { ChannelStorageCard } from './ChannelStorageCard'
import { useFadeCancelUnpin } from '../lib/hooks/useFadeCancelUnpin'
import { ItemTile } from './ItemTile'
import type { TileChannel, TileSource } from './ItemTile'
import { PIN_ITEM_DRAG_TYPE } from './pin/PinSidebar'
import { SlabInspector } from './SlabInspector'

type TileEntry = {
  item: ItemRef
  channel: TileChannel
  source: TileSource
  objectID?: string
  pinnedAt?: string
}

type TopTab = 'files' | 'channels'

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

  const [topTab, setTopTab] = useState<TopTab>('files')
  const [isDragging, setIsDragging] = useState(false)
  const FADE_MS = 1500
  const { removingURLs, toggle: toggleTilePinFade } = useFadeCancelUnpin({
    fadeMs: FADE_MS,
  })

  const myChannelIDSet = useMemo(
    () => new Set(myChannels.map((c) => c.channelID)),
    [myChannels],
  )

  // One storage card per owned channel. bytes is the channel's full storage
  // footprint — post bodies plus their attachment files — not just the body
  // bytes, so the card's stat is the honest "what this channel costs."
  const ownedChannelCards = useMemo(() => {
    return myChannels
      .map((c) => {
        const items = feedEntries.filter(
          (e) => e.channel.channelID === c.channelID,
        )
        // Coalesce undefined byteSize to 0 — a corrupt/legacy item or
        // attachment missing the field would otherwise NaN-poison the sum
        // and render "NaN GB". We can't know its size, so it undercounts.
        const bytes = items.reduce((sum, e) => {
          const attBytes =
            e.item.attachments?.reduce((s, a) => s + (a.byteSize ?? 0), 0) ?? 0
          return sum + (e.item.byteSize ?? 0) + attBytes
        }, 0)
        const sub = subscriptions.find((s) => s.channelID === c.channelID)
        const manifest = manifests[c.channelID]
        return {
          channel: c,
          itemCount: items.length,
          bytes,
          authorHandle: sub?.authorHandle ?? '',
          avatar: manifest?.avatar,
          cover: manifest?.cover,
          description: manifest?.description ?? '',
        }
      })
      .sort((a, b) => b.bytes - a.bytes)
  }, [myChannels, feedEntries, subscriptions, manifests])

  // My Files = external pins + library drops. Own-channel items deliberately
  // excluded — they live under My Channels, reachable by drilling into the
  // channel, not as flat tiles here.
  const flatEntries = useMemo<TileEntry[]>(() => {
    return pinned
      .filter((p) => !myChannelIDSet.has(p.channel.channelID))
      .map((p) => ({
        item: p.item,
        channel: p.channel,
        source:
          p.channel.channelID === LIBRARY_CHANNEL.channelID
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

  // Drag-drop intake belongs to My Files only — dropping an OS file pins it
  // into your library. The handlers are attached only on that tab so a drop
  // on My Channels does nothing.
  const dragProps =
    topTab === 'files'
      ? {
          onDragEnter: handleDragEnter,
          onDragOver: handleDragOver,
          onDragLeave: handleDragLeave,
          onDrop: handleDrop,
        }
      : {}

  return (
    <div className="flex-1 p-6">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <div className="flex-1 min-w-0">
          <div
            {...dragProps}
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

            <div className="flex gap-4 border-b border-neutral-200">
              <TabButton
                active={topTab === 'files'}
                onClick={() => setTopTab('files')}
              >
                My Files
              </TabButton>
              <TabButton
                active={topTab === 'channels'}
                onClick={() => setTopTab('channels')}
              >
                My Channels
              </TabButton>
            </div>

            {topTab === 'files' ? (
              <>
                {flatEntries.length === 0 ? (
                  <p className="text-sm text-neutral-500 py-8 text-center">
                    Pin items to keep them here.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {flatEntries.map((entry) => {
                      const url = entry.item.itemURL
                      const canUnpin = !!entry.objectID
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
              </>
            ) : ownedChannelCards.length === 0 ? (
              <p className="text-sm text-neutral-500 py-8 text-center">
                Channels you create show up here.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {ownedChannelCards.map((c) => (
                  <ChannelStorageCard
                    key={c.channel.channelID}
                    channelID={c.channel.channelID}
                    channelName={c.channel.name}
                    authorHandle={c.authorHandle}
                    avatar={c.avatar}
                    cover={c.cover}
                    description={c.description}
                    itemCount={c.itemCount}
                    bytes={c.bytes}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        {rightSidebar}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px px-1 pb-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
        active
          ? 'border-green-600 text-neutral-900'
          : 'border-transparent text-neutral-500 hover:text-neutral-900'
      }`}
    >
      {children}
    </button>
  )
}
