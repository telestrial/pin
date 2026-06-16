import { useMemo } from 'react'
import type { ChannelImage, ItemRef } from '../core/types'
import { isValidAttachment } from '../core/types'
import { itemRefFromAttachment } from '../lib/filePin'
import { useItemBlobURL } from '../lib/hooks/useItemBytes'
import type { PinnedItemRef } from '../stores/pin'
import { ChannelAvatar } from './channel/ChannelAvatar'
import { ItemTile } from './ItemTile'
import { TabButton } from './ui/TabButton'

// The drill-in storage view for one owned channel, reached from a card on the
// My Channels tab. Mirrors the ChannelView header (cover + avatar + name +
// description) minus the public-page actions. Sub-tabs: Files (the byte-bearing
// attachments across the channel's posts — the storage lens) and Posts (the
// posts themselves; added next). Takes over the middle column; Back returns to
// the channel cards.
export function ChannelStorageDetail({
  channelID,
  channelName,
  authorHandle,
  avatar,
  cover,
  description,
  posts,
  onBack,
  onOpenItem,
}: {
  channelID: string
  channelName: string
  authorHandle: string
  avatar?: ChannelImage
  cover?: ChannelImage
  description?: string
  posts: ItemRef[]
  onBack: () => void
  onOpenItem: (ref: PinnedItemRef) => void
}) {
  // Flatten every valid attachment across the channel's posts into file tiles.
  // byteSize is coalesced to 0 when synthesizing the tile item so a legacy
  // attachment missing the field doesn't render "NaN B" on its tile.
  const fileTiles = useMemo(() => {
    return posts.flatMap((post) =>
      (post.attachments ?? []).filter(isValidAttachment).map((att) => ({
        key: att.objectID ?? att.url,
        item: { ...itemRefFromAttachment(att), byteSize: att.byteSize ?? 0 },
        objectID: att.objectID,
      })),
    )
  }, [posts])

  return (
    <div className="border border-neutral-200 rounded-lg bg-white overflow-hidden">
      <div className="relative">
        {cover ? (
          <DetailCover cover={cover} />
        ) : (
          <div className="h-32 bg-linear-to-br from-neutral-100 to-neutral-200" />
        )}
        <button
          type="button"
          onClick={onBack}
          className="absolute top-3 left-3 inline-flex items-center px-2.5 py-1 text-xs font-medium text-white bg-black/40 hover:bg-black/60 backdrop-blur-sm rounded-full transition-colors cursor-pointer"
        >
          Back
        </button>
      </div>
      <div className="px-5 pb-5 space-y-5">
        <div className="flex items-start gap-4">
          <div className="relative z-10 -mt-10 rounded-full ring-4 ring-white shrink-0">
            <ChannelAvatar
              channelID={channelID}
              channelName={channelName}
              authorHandle={authorHandle}
              avatar={avatar}
              size="lg"
            />
          </div>
          <div className="min-w-0 pt-3">
            <h1 className="text-xl font-semibold text-neutral-900 truncate">
              {channelName}
            </h1>
            {description && (
              <p className="text-sm text-neutral-600 line-clamp-2 pt-0.5">
                {description}
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-4 border-b border-neutral-200">
          <TabButton active onClick={() => {}}>
            Files
          </TabButton>
        </div>

        {fileTiles.length === 0 ? (
          <p className="text-sm text-neutral-500 py-8 text-center">
            No files in this channel yet.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {fileTiles.map((tile) => (
              <ItemTile
                key={tile.key}
                item={tile.item}
                channel={{ authorHandle, channelID, name: channelName }}
                source="own"
                onOpen={() =>
                  onOpenItem({
                    item: tile.item,
                    channel: { authorHandle, channelID, name: channelName },
                    objectID: tile.objectID ?? '',
                    pinnedAt: '',
                  })
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DetailCover({ cover }: { cover: ChannelImage }) {
  const { url, error } = useItemBlobURL(
    cover.itemURL,
    cover.mimeType,
    cover.contentHash,
  )
  if (error || !url) return <div className="h-32 bg-neutral-100" />
  return (
    <img src={url} alt="" className="w-full h-32 object-cover bg-neutral-100" />
  )
}
