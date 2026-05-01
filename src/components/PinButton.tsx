import { Pin } from 'lucide-react'
import { useState } from 'react'
import { deletePublishedItem } from '../core/channels'
import { fetchAccountSnapshot } from '../core/pin'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { type PinInput, usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'

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

  const [deleting, setDeleting] = useState(false)

  const ownedChannel = myChannels.find(
    (c) => c.channelID === input.channel.channelID,
  )
  const isOwned = !!ownedChannel
  const isActive = isOwned || isPinned
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
        fetchAccountSnapshot(sdk)
          .then((account) => usePinStore.setState({ account }))
          .catch(() => {})
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

  const title = isOwned
    ? 'Retract from your channel and storage'
    : isPinned
      ? 'Unpin from your storage'
      : 'Pin to your storage'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || !sdk}
      title={title}
      aria-pressed={isActive}
      className={`p-1 transition-colors disabled:opacity-50 ${
        isActive
          ? 'text-green-600 hover:text-green-700'
          : 'text-neutral-400 hover:text-neutral-700'
      }`}
    >
      {busy ? (
        <span className="block w-3.5 h-3.5">
          <span className="block size-3.5 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin" />
        </span>
      ) : (
        <Pin
          className="w-3.5 h-3.5"
          fill={isActive ? 'currentColor' : 'none'}
          aria-hidden="true"
        />
      )}
    </button>
  )
}
