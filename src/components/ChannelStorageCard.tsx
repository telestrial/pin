import type { ChannelImage } from '../core/types'
import { formatBytes } from '../lib/format'
import { useItemBlobURL } from '../lib/hooks/useItemBytes'
import { ChannelAvatar } from './channel/ChannelAvatar'

// A storage-flavored representation of a channel for the My Channels tab —
// mirrors the ChannelView header (cover banner + overlapping avatar + name +
// description) but read-only: no Follow / Edit / pin / context-menu. The stat
// line carries the storage story (item count + total bytes). When `onClick` is
// set the whole card is a button (drill into the channel storage detail);
// without it the card is inert display.
export function ChannelStorageCard({
  channelID,
  channelName,
  authorHandle,
  avatar,
  cover,
  description,
  itemCount,
  bytes,
  onClick,
}: {
  channelID: string
  channelName: string
  authorHandle: string
  avatar?: ChannelImage
  cover?: ChannelImage
  description?: string
  itemCount: number
  bytes: number
  onClick?: () => void
}) {
  const inner = (
    <>
      <div className="relative">
        {cover ? (
          <CardCover cover={cover} />
        ) : (
          <div className="h-20 bg-linear-to-br from-neutral-100 to-neutral-200" />
        )}
      </div>
      <div className="px-4 pb-4">
        <div className="flex items-start gap-3">
          <div className="relative z-10 -mt-8 rounded-full ring-4 ring-white shrink-0">
            <ChannelAvatar
              channelID={channelID}
              channelName={channelName}
              authorHandle={authorHandle}
              avatar={avatar}
              size="md"
            />
          </div>
          <div className="min-w-0 flex-1 pt-2">
            <div className="text-sm font-semibold text-neutral-900 truncate">
              {channelName}
            </div>
            <div className="text-xs text-neutral-500">
              {itemCount} item{itemCount === 1 ? '' : 's'} · {formatBytes(bytes)}
            </div>
          </div>
        </div>
        {description && (
          <p className="text-xs text-neutral-600 line-clamp-2 pt-2">
            {description}
          </p>
        )}
      </div>
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="text-left bg-white border border-neutral-200 rounded-lg overflow-hidden hover:border-neutral-300 hover:shadow-sm transition-all cursor-pointer"
      >
        {inner}
      </button>
    )
  }
  return (
    <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
      {inner}
    </div>
  )
}

function CardCover({ cover }: { cover: ChannelImage }) {
  const { url, error } = useItemBlobURL(
    cover.itemURL,
    cover.mimeType,
    cover.contentHash,
  )
  if (error || !url) return <div className="h-20 bg-neutral-100" />
  return (
    <img src={url} alt="" className="w-full h-20 object-cover bg-neutral-100" />
  )
}
