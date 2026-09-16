import {
  unwatchOneChannel,
  watchOneChannel,
} from '../lib/hooks/useHandleFollowReconciliation'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { RelationButton } from './RelationButton'

// Follow a single channel — the iroh-native public edge. Writes a FollowEdge
// {didDht, channelID, name} to local settings (mirrored into the identity-doc
// by useIdentityDocPublish); carries no K.
//
// Following also WATCHES it, so the channel lands in your feed. It used to do
// neither: the edge carries no K, so following said something publicly and gave
// the follower nothing, which nobody would guess from a button labelled Follow.
// K comes from the author's directory, which is where the person-follow path
// already reads it — public channels advertise it, which is what public means.
//
// So the two relations split by what they are FOR rather than by what they
// fetch: Follow is public and gets you the channel; Watch is private, comes
// from a link, and works for unlisted channels a directory never names.
//
// Renders for public channels whose manifest carries the author's did:dht (the
// caller gates on that + on ownership — only mounted on non-owned channels).
export function FollowButton({
  authorDidDht,
  channelID,
  channelName,
}: {
  authorDidDht: string
  channelID: string
  channelName: string
}) {
  const following = useAuthStore((s) =>
    s.follows.some((f) => f.channelID === channelID),
  )
  const addFollow = useAuthStore((s) => s.addFollow)
  const removeFollow = useAuthStore((s) => s.removeFollow)
  const addToast = useToastStore((s) => s.addToast)

  // The edge toggles synchronously against the local store and the watch side-effect —
  // which resolves the author's directory for K — is what takes time. RelationButton owns
  // the busy state, because by the time this awaits, `following` already describes where
  // the click is going rather than where it came from.
  async function handleClick() {
    if (following) {
      removeFollow(channelID)
      await unwatchOneChannel(channelID).catch(() => false)
      addToast(`Unfollowed “${channelName}”`)
    } else {
      addFollow({ didDht: authorDidDht, channelID, name: channelName })
      // A follow stands whether or not the watch lands: the edge is the public
      // statement, and a directory that would not resolve is a reason the
      // channel is not readable yet rather than a reason not to have followed.
      const watched = await watchOneChannel(authorDidDht, channelID).catch(
        () => false,
      )
      addToast(
        watched
          ? `Following “${channelName}” · added to your feed`
          : `Following “${channelName}”`,
      )
    }
  }

  return (
    <RelationButton
      onLabel="Following"
      offLabel="Follow"
      turningOnLabel="Following…"
      turningOffLabel="Unfollowing…"
      active={following}
      // Public: a follow is a claim in your directory that anybody's crawl can read.
      tone="public"
      onClick={handleClick}
    />
  )
}
