import { AppWindow, FileText, Music, Play, Quote } from 'lucide-react'
import type { ItemRef } from '../core/types'
import { formatBytes } from './AttachmentMedia'
import { useItemBlobURL } from '../lib/useItemBytes'
import { PinIcon } from './PinIcon'

export type TileSource = 'external' | 'library' | 'own'

export type TileChannel = {
  authorHandle: string
  channelID: string
  name: string
}

function itemTitle(item: ItemRef): string {
  if (item.title) return item.title
  if (item.summary) return item.summary
  if (item.filename) return item.filename
  return '(untitled)'
}

function ImageVisual({ item }: { item: ItemRef }) {
  const { url } = useItemBlobURL(item.itemURL, item.mimeType)
  if (!url) {
    return <div className="w-full h-full bg-neutral-100 animate-pulse" />
  }
  return (
    <img
      src={url}
      alt={itemTitle(item)}
      className="block w-full h-full object-cover"
    />
  )
}

function TextVisual({ item }: { item: ItemRef }) {
  const body = item.summary ?? ''
  const display = body.trim() || '(empty)'
  return (
    <div className="w-full h-full p-3 flex flex-col gap-1.5">
      {item.title && (
        <p className="text-xs font-semibold text-neutral-900 line-clamp-2">
          {item.title}
        </p>
      )}
      <p className="text-[11px] text-neutral-600 line-clamp-6 leading-snug">
        {display}
      </p>
    </div>
  )
}

function IconVisual({
  Icon,
  label,
}: {
  Icon: typeof Play
  label?: string
}) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-neutral-500">
      <Icon className="size-10" aria-hidden="true" />
      {label && (
        <span className="text-[10px] uppercase tracking-wide">{label}</span>
      )}
    </div>
  )
}

function VisualForType({ item }: { item: ItemRef }) {
  if (item.type === 'image') return <ImageVisual item={item} />
  if (item.type === 'text') return <TextVisual item={item} />
  if (item.type === 'video') return <IconVisual Icon={Play} label="Video" />
  if (item.type === 'audio') return <IconVisual Icon={Music} label="Audio" />
  if (item.type === 'app') return <IconVisual Icon={AppWindow} label="App" />
  return <IconVisual Icon={FileText} label="File" />
}

function PostIcon({ item }: { item: ItemRef }) {
  // Subtle per-type indicator in the corner of the visual area, so a glance
  // at the tile resolves to a type without reading the label.
  if (item.type === 'image') return null
  if (item.type === 'text')
    return <Quote className="size-3.5" aria-hidden="true" />
  if (item.type === 'video')
    return <Play className="size-3.5" aria-hidden="true" />
  if (item.type === 'audio')
    return <Music className="size-3.5" aria-hidden="true" />
  if (item.type === 'app')
    return <AppWindow className="size-3.5" aria-hidden="true" />
  return <FileText className="size-3.5" aria-hidden="true" />
}

export function ItemTile({
  item,
  channel,
  source,
  onOpen,
  onUnpin,
  onDragStart,
  removing = false,
  busy = false,
}: {
  item: ItemRef
  channel: TileChannel
  source: TileSource
  onOpen?: () => void
  onUnpin?: () => void
  onDragStart?: (e: React.DragEvent) => void
  removing?: boolean
  busy?: boolean
}) {
  const title = itemTitle(item)
  const channelLabel =
    source === 'library' ? 'Library' : channel.name || channel.authorHandle

  return (
    <div
      className={`group relative bg-white border rounded-lg overflow-hidden transition-opacity duration-1500 ${
        removing
          ? 'opacity-0 border-neutral-200'
          : 'opacity-100 border-neutral-200 hover:border-neutral-300'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        draggable={!!onDragStart}
        onDragStart={onDragStart}
        className="block w-full text-left cursor-pointer focus:outline-none focus:ring-2 focus:ring-green-500/40"
      >
        <div className="aspect-square bg-neutral-50 relative overflow-hidden">
          <VisualForType item={item} />
          {item.type !== 'image' && (
            <span className="absolute top-1.5 left-1.5 inline-flex items-center justify-center size-5 rounded-full bg-white/90 text-neutral-700 backdrop-blur-sm shadow-sm">
              <PostIcon item={item} />
            </span>
          )}
        </div>
        <div className="px-2.5 py-2 space-y-0.5">
          <p className="text-xs font-medium text-neutral-900 truncate">
            {title}
          </p>
          <div className="flex items-baseline justify-between gap-1">
            <span className="text-[10px] text-neutral-500 truncate">
              {channelLabel}
            </span>
            <span className="text-[10px] text-neutral-400 shrink-0">
              {formatBytes(item.byteSize)}
            </span>
          </div>
        </div>
      </button>
      {onUnpin && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onUnpin()
          }}
          disabled={busy}
          title={removing ? 'Click to undo' : 'Unpin'}
          aria-label={
            removing ? `Re-pin ${title}` : `Unpin ${title}`
          }
          className="absolute top-1.5 right-1.5 inline-flex items-center justify-center size-7 rounded-full bg-white/80 backdrop-blur-sm text-green-600 hover:bg-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-[opacity,background-color] cursor-pointer disabled:opacity-50"
        >
          <PinIcon
            className={removing ? 'size-4' : 'size-4 fill-current'}
            aria-hidden="true"
          />
        </button>
      )}
    </div>
  )
}
