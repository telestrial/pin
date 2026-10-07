import { channelKeyFromBase64 } from '../core/crypto'
import { isStanding, requestAccess } from '../lib/access'
import { unwatchOneChannel } from '../lib/channelWatch'
import { useMyRequest } from '../lib/hooks/useMyRequest'
import { startWatchingByKey } from '../lib/watch'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { RelationButton } from './RelationButton'

/** Follow, on a private channel: asking its author to be let in.
 *
 *  The relation a private channel offers a non-member is a request rather than a follow,
 *  because reading it takes the author's leave. Pressing it signs a request the Curator
 *  knocks to the author, AND starts watching the channel: following a private channel is
 *  membership plus a watch, so with the watch already in place an approval makes this
 *  identity a follower with nothing further to do. Pressing "Requested" takes both back.
 *  Nothing public is written either way — who asked to read what stays between the two of
 *  them, which is why it takes the private tone. */
export function RequestButton({
  channelID,
  channelKey,
  author,
  channelName,
}: {
  channelID: string
  /** K, base64, from the navigation that opened the page. */
  channelKey: string
  /** The channel's author, as did:dht: who the request is for. */
  author: string
  /** What the sidebar calls the channel while it cannot be read. */
  channelName?: string
}) {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const addToast = useToastStore((s) => s.addToast)
  const mine = useMyRequest(channelID, true)
  const standing = isStanding(mine?.request ?? null)
  // Turned down: still standing until taken back, which is what pressing it does — and
  // what leaves room to ask again.
  const denied = standing && !!mine?.denied

  async function handleClick() {
    if (!storedKeyHex) return
    await requestAccess(
      storedKeyHex,
      channelKeyFromBase64(channelKey),
      author,
      standing,
    )
    if (standing) {
      await unwatchOneChannel(channelID)
    } else {
      await startWatchingByKey({
        didDht: author,
        channelID,
        channelKey,
        name: channelName,
      })
    }
    addToast(standing ? 'Request withdrawn' : 'Request sent')
  }

  return (
    <RelationButton
      onLabel={denied ? 'Not approved' : 'Requested'}
      offLabel="Follow"
      turningOnLabel="Requesting…"
      turningOffLabel="Withdrawing…"
      active={standing}
      tone="private"
      onClick={handleClick}
    />
  )
}
