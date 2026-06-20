import type { ChannelImage } from '../../core/types'
import { useItemBlobURL } from '../../lib/hooks/useItemBytes'
import { ChannelMark } from './ChannelMark'

export function ChannelAvatar({
  channelID,
  channelName,
  authorHandle,
  avatar,
  size = 'md',
}: {
  channelID: string
  channelName: string
  authorHandle: string
  avatar?: ChannelImage
  size?: 'xs' | 'sm' | 'md' | 'lg'
}) {
  if (!avatar) {
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
    <AvatarImage
      avatar={avatar}
      channelID={channelID}
      channelName={channelName}
      authorHandle={authorHandle}
      size={size}
    />
  )
}

function AvatarImage({
  avatar,
  channelID,
  channelName,
  authorHandle,
  size,
}: {
  avatar: ChannelImage
  channelID: string
  channelName: string
  authorHandle: string
  size: 'xs' | 'sm' | 'md' | 'lg'
}) {
  const { url, error } = useItemBlobURL(
    avatar.itemURL,
    avatar.mimeType,
    avatar.contentHash,
  )
  const sizeClass =
    size === 'lg'
      ? 'size-16'
      : size === 'xs'
        ? 'size-5'
        : size === 'sm'
          ? 'size-7'
          : 'size-10'

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
