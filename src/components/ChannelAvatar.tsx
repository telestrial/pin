import type { ChannelCover } from '../core/types'
import { useItemBlobURL } from '../lib/useItemBytes'
import { ChannelMark } from './ChannelMark'

export function ChannelAvatar({
  channelID,
  channelName,
  authorHandle,
  coverArt,
  size = 'md',
}: {
  channelID: string
  channelName: string
  authorHandle: string
  coverArt?: ChannelCover
  size?: 'sm' | 'md' | 'lg'
}) {
  if (!coverArt) {
    return (
      <ChannelMark
        channelID={channelID}
        channelName={channelName}
        authorHandle={authorHandle}
        size={size}
      />
    )
  }
  return (
    <CoverImage
      coverArt={coverArt}
      channelID={channelID}
      channelName={channelName}
      authorHandle={authorHandle}
      size={size}
    />
  )
}

function CoverImage({
  coverArt,
  channelID,
  channelName,
  authorHandle,
  size,
}: {
  coverArt: ChannelCover
  channelID: string
  channelName: string
  authorHandle: string
  size: 'sm' | 'md' | 'lg'
}) {
  const { url, error } = useItemBlobURL(coverArt.itemURL, coverArt.mimeType)
  const sizeClass =
    size === 'lg' ? 'size-16' : size === 'sm' ? 'size-7' : 'size-10'

  if (error || !url) {
    return (
      <ChannelMark
        channelID={channelID}
        channelName={channelName}
        authorHandle={authorHandle}
        size={size}
      />
    )
  }
  return (
    <img
      src={url}
      alt=""
      className={`${sizeClass} shrink-0 rounded-full object-cover bg-neutral-100`}
    />
  )
}
