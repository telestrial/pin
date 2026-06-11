import { useState } from 'react'
import { deletePublishedItem } from '../core/channels'
import { formatBytes } from '../lib/format'
import { itemPinByteSize } from '../lib/useChannelPinState'
import { usePinState } from '../lib/usePinState'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { type PinInput, usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { PinIcon } from './PinIcon'

export function PinButton({ input }: { input: PinInput }) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const myChannels = useAuthStore((s) => s.myChannels)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const isPinned = usePinStore((s) => s.isPinned(input.item.itemURL))
  const isPinning = usePinStore((s) => s.isPinning(input.item.itemURL))
  const pin = usePinStore((s) => s.pin)
  const unpin = usePinStore((s) => s.unpin)
  const addToast = useToastStore((s) => s.addToast)
  const refreshChannel = useFeedStore((s) => s.refreshChannel)
  const pinState = usePinState(input.item, input.channel.channelID)

  const [deleting, setDeleting] = useState(false)

  const ownedChannel = myChannels.find(
    (c) => c.channelID === input.channel.channelID,
  )
  const isOwned = !!ownedChannel
  const busy = isPinning || deleting

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!sdk || busy) return

    if (isOwned && ownedChannel && agent) {
      const confirmation = window.prompt(
        'This removes the item from your channel and your storage. Subscribers who pinned it will keep their copies.\n\nType DELETE to confirm.',
      )
      if (confirmation !== 'DELETE') return
      setDeleting(true)
      try {
        await deletePublishedItem(sdk, agent, ownedChannel, input.item.id)
        const sub = subscriptions.find(
          (s) => s.channelID === ownedChannel.channelID,
        )
        if (sub) await refreshChannel(sub)
        usePinStore.getState().refreshAccount(sdk)
        addToast('Item retracted')
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Delete failed')
      } finally {
        setDeleting(false)
      }
      return
    }

    try {
      if (isPinned) {
        await unpin(sdk, input.item.itemURL)
        addToast('Unpinned')
      } else {
        await pin(sdk, input)
        addToast('Pinned to your storage')
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Pin failed')
    }
  }

  // Content-byte size of what this pin mirrors (body + attachments) —
  // the same number the sidebar storage bar moves by, surfaced on hover.
  const size = formatBytes(itemPinByteSize(input.item))
  const title = isOwned
    ? 'Retract from your channel and storage'
    : pinState === 'edited'
      ? `Update your pinned copy to the current version (${size})`
      : pinState === 'pinned'
        ? `Unpin from your storage (${size})`
        : `Pin to your storage (${size})`

  // Color delegation: state-aware PinIcon uses currentColor for stroke
  // and fill, so the parent button controls color (and hover).
  //  pinned   → text-green-600 (committed)
  //  pinnable → text-neutral-400 hover:text-green-600 (hint at upgrade)
  //  edited   → text-neutral-400 hover:text-green-600 (re-pin hint —
  //             green dot stays as the persistent drift badge regardless)
  const colorClass =
    pinState === 'pinned'
      ? 'text-green-600 hover:text-green-700'
      : 'text-neutral-400 hover:text-green-600'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || !sdk}
      title={title}
      aria-pressed={pinState === 'pinned'}
      className={`p-1 transition-colors disabled:opacity-50 ${colorClass}`}
    >
      {busy ? (
        <span className="block size-6">
          <span className="block size-6 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin" />
        </span>
      ) : (
        <PinIcon state={pinState} aria-hidden="true" />
      )}
    </button>
  )
}
