import { channelKeyFromBase64 } from '../core/crypto'
import { isStanding, requestAccess } from '../lib/access'
import { useMyRequest } from '../lib/hooks/useMyRequest'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { RelationButton } from './RelationButton'

/** Follow, on a private channel: asking its author to be let in.
 *
 *  The relation a private channel offers a non-member is a request rather than a follow,
 *  because reading it takes the author's leave. Pressing it signs a request the Curator
 *  knocks to the author; pressing "Requested" takes it back. Nothing public is written
 *  either way — who asked to read what stays between the two of them, which is why it
 *  takes the private tone. */
export function RequestButton({
  channelID,
  channelKey,
  author,
}: {
  channelID: string
  /** K, base64, from the navigation that opened the page. */
  channelKey: string
  /** The channel's author, as did:dht: who the request is for. */
  author: string
}) {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const addToast = useToastStore((s) => s.addToast)
  const request = useMyRequest(channelID, true)
  const standing = isStanding(request ?? null)

  async function handleClick() {
    if (!storedKeyHex) return
    await requestAccess(
      storedKeyHex,
      channelKeyFromBase64(channelKey),
      author,
      standing,
    )
    addToast(standing ? 'Request withdrawn' : 'Request sent')
  }

  return (
    <RelationButton
      onLabel="Requested"
      offLabel="Follow"
      turningOnLabel="Requesting…"
      turningOffLabel="Withdrawing…"
      active={standing}
      tone="private"
      onClick={handleClick}
    />
  )
}
