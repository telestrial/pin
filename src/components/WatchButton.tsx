import type { ChannelManifest } from '../core/types'
import { unwatchOneChannel } from '../lib/channelWatch'
import { startWatching } from '../lib/watch'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { RelationButton } from './RelationButton'

/** Watch a channel: the private half of following.
 *
 *  It gets you the channel and says nothing in public — no edge in your directory, nothing
 *  the crawl walks, nothing anybody can read off you. That is the whole difference from
 *  Follow, and it is why this is a separate control rather than a mode of that one.
 *
 *  It is also the ONLY relation an unlisted channel can have. A `FollowEdge` carries no K
 *  and resolves through the author's directory, where an unlisted channel is absent by
 *  construction — so there is nothing to follow through, and the caller renders Follow only
 *  for public channels. Here the key is in hand, which is why this works either way.
 *
 *  Hidden once you follow, because following already watches: offering Watch beside
 *  Following would name a fourth state that does not exist. */
export function WatchButton({
  authorHandle,
  didDht,
  channelID,
  channelKey,
  channelName,
  manifest,
}: {
  authorHandle: string
  didDht?: string
  channelID: string
  /** K, from the navigation that opened this page or from the subscription itself. */
  channelKey: string
  channelName: string
  /** What starting a watch seeds the feed from. Absent on a channel that cannot be read,
   *  where the only thing to do is stop watching it. */
  manifest?: ChannelManifest
}) {
  const watching = useAuthStore((s) =>
    s.subscriptions.some((x) => x.channelID === channelID),
  )
  const addToast = useToastStore((s) => s.addToast)

  // No busy state here: RelationButton holds it, along with which way the click was
  // going — `watching` has already flipped by the time this awaits its settings write.
  async function handleClick() {
    if (watching) {
      await unwatchOneChannel(channelID)
      addToast(`Stopped watching “${channelName}”`)
    } else {
      if (!manifest) return
      // No fetch: the manifest is the one this page is already rendering, so starting to
      // watch costs a settings write and nothing else.
      await startWatching({
        authorHandle,
        didDht,
        channelID,
        channelKey,
        manifest,
      })
      addToast(`Watching “${channelName}”`)
    }
  }

  return (
    <RelationButton
      onLabel="Watching"
      offLabel="Watch"
      turningOnLabel="Watching…"
      turningOffLabel="Stopping…"
      active={watching}
      tone="private"
      onClick={handleClick}
    />
  )
}
