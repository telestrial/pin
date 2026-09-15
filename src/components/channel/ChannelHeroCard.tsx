import type { ChannelImage } from '../../core/types'
import { useItemBlobURL } from '../../lib/hooks/useItemBytes'
import { ChannelAvatar } from './ChannelAvatar'
import { channelPalette } from './ChannelMark'

// Full-bodied "hero" card for a channel: the cover art (or an identity-derived
// gradient when there's none) fills the card, a dark scrim anchors white
// name/description + avatar at the bottom, and an optional badge sits top-right
// (item count on a profile, item count + storage bytes where it's yours). The
// whole card is the click target. Shared by the profile directory and the My
// Storage "My Channels" tab.
//
// `compact` is the same card at a smaller footprint, for a surface where the channels are
// no longer the point. A profile is a feed now, so its channels sit above it as a strip
// rather than filling the screen before a reader reaches a post — and they keep their
// cover art, because a channel's art is a channel's identity and a text row would throw it
// away to save the same space a shorter card saves.
export function ChannelHeroCard({
  channelID,
  channelName,
  authorHandle,
  avatar,
  cover,
  description,
  badge,
  compact = false,
  onClick,
}: {
  channelID: string
  channelName: string
  authorHandle: string
  avatar?: ChannelImage
  cover?: ChannelImage
  description?: string
  badge?: string
  compact?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative block w-full rounded-lg overflow-hidden text-left cursor-pointer ${
        compact ? 'h-28' : 'h-44'
      }`}
    >
      <HeroBackground cover={cover} channelID={channelID} />
      {/* Scrim: darkest at the bottom where the text sits. */}
      <div className="absolute inset-0 bg-linear-to-t from-black/75 via-black/15 to-black/5" />
      {badge && (
        <span className="absolute top-3 right-3 rounded-full bg-black/35 backdrop-blur-sm px-2 py-0.5 text-xs font-medium text-white">
          {badge}
        </span>
      )}
      <div
        className={`absolute inset-x-0 bottom-0 flex items-end gap-3 ${
          compact ? 'p-3' : 'p-4'
        }`}
      >
        <div className="rounded-full ring-2 ring-white/90 shrink-0">
          <ChannelAvatar
            channelID={channelID}
            channelName={channelName}
            authorHandle={authorHandle}
            avatar={avatar}
            size={compact ? 'sm' : 'md'}
          />
        </div>
        <div className="min-w-0 flex-1 pb-0.5">
          <div
            className={`font-semibold text-white truncate drop-shadow-sm ${
              compact ? 'text-sm' : 'text-base'
            }`}
          >
            {channelName}
          </div>
          {description && (
            <div
              className={`text-white/85 truncate drop-shadow-sm ${
                compact ? 'text-xs' : 'text-sm'
              }`}
            >
              {description}
            </div>
          )}
        </div>
      </div>
    </button>
  )
}

function HeroBackground({
  cover,
  channelID,
}: {
  cover?: ChannelImage
  channelID: string
}) {
  if (cover?.itemURL) return <HeroCover cover={cover} channelID={channelID} />
  return <IdentityGradient channelID={channelID} />
}

function HeroCover({
  cover,
  channelID,
}: {
  cover: ChannelImage
  channelID: string
}) {
  const { url, error } = useItemBlobURL(
    cover.itemURL,
    cover.mimeType,
    cover.contentHash,
  )
  if (error || !url) return <IdentityGradient channelID={channelID} />
  return (
    <img src={url} alt="" className="absolute inset-0 size-full object-cover" />
  )
}

// No-cover fallback: a diagonal gradient from the channel's identity palette
// (dark → pale), so a cover-less channel still has a distinct backdrop tied to
// its mark color.
function IdentityGradient({ channelID }: { channelID: string }) {
  const [bg, fg] = channelPalette(channelID)
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0"
      style={{ backgroundImage: `linear-gradient(135deg, ${fg}, ${bg})` }}
    />
  )
}
