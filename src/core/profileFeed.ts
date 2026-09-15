import {
  entriesForChannel,
  type FeedEntry,
  feedTimeOf,
  type ResolvedPortalEntry,
} from './feed'
import type { ChannelManifest } from './types'

/** How many posts a profile shows.
 *
 *  PROVISIONAL, and the number is arbitrary on purpose. A manifest carries a channel's
 *  entire history and there is no pagination, so merging three channels is potentially
 *  thousands of items and this cap is the only thing keeping the page honest. The real
 *  answer is paging the manifest itself; until that lands, any value here is a placeholder
 *  and tuning it in isolation would be tuning the wrong thing. */
export const PROFILE_FEED_LIMIT = 50

/** One channel as the profile feed reads it.
 *
 *  `showOnProfile` comes from whichever source produced the channel — settings for your
 *  own, the crawl's record or the author's directory for somebody else's — and it is the
 *  same absent-means-yes flag in all three. */
export type ProfileChannel = {
  channelID: string
  showOnProfile?: boolean
  manifest: ChannelManifest
}

/** Whether a channel's posts belong on its author's profile.
 *
 *  Absent reads as YES, the opposite of `visibility` and right for the opposite reason:
 *  the safe direction there is refusing to enumerate an obscure channel, and here it is a
 *  channel the author already advertises showing the posts it already publishes. So every
 *  channel made before the flag existed keeps appearing. */
export function includedOnProfile(channel: ProfileChannel): boolean {
  return channel.showOnProfile !== false
}

/** Every post the included channels contributed, newest first.
 *
 *  The author is one person, so every row is presented under their did — the channel is
 *  still named, but which of their voices a post came from is a detail of the row rather
 *  than a separate list. That is what makes this a feed rather than a set of channels
 *  stacked.
 *
 *  Sorted by `feedTimeOf` so a circulated post lands when it was circulated, exactly as it
 *  does in the home feed. Portals contribute nothing until something resolves them — the
 *  same rule `entriesForChannel` states, and this page has no resolution pass yet, so a
 *  channel that only reposts shows empty here. */
export function buildProfileFeed(
  didDht: string,
  channels: readonly ProfileChannel[],
  portals: Readonly<Record<string, ResolvedPortalEntry | undefined>> = {},
  limit: number = PROFILE_FEED_LIMIT,
): FeedEntry[] {
  const entries: FeedEntry[] = []
  for (const channel of channels) {
    if (!includedOnProfile(channel)) continue
    entries.push(
      ...entriesForChannel(
        {
          // The handle is empty because a directory names channels by their author's did,
          // which is the identifier every row here resolves a name from.
          authorHandle: '',
          authorDidDht: didDht,
          channelID: channel.channelID,
          name: channel.manifest.name,
          avatar: channel.manifest.avatar,
        },
        channel.manifest,
        portals,
      ),
    )
  }

  entries.sort((a, b) => {
    const at = feedTimeOf(a)
    const bt = feedTimeOf(b)
    return at < bt ? 1 : at > bt ? -1 : 0
  })

  return entries.slice(0, limit)
}
