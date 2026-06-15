import { useState } from 'react'
import { deletePublishedItem } from '../core/channels'
import { formatBytes } from '../lib/format'
import { objectIDsInManifests } from '../lib/scopeRefs'
import { itemPinByteSize } from '../lib/hooks/useChannelPinState'
import { usePinState } from '../lib/hooks/usePinState'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { objectIDsReferencedBy, type PinInput, usePinStore } from '../stores/pin'
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
        // Reference-safe eager cleanup: protect bytes still held by your other
        // channels' manifests or any pin (e.g. an attachment kept as a library
        // pin) so the retract doesn't yank them.
        const protectedIDs = new Set([
          ...objectIDsInManifests(
            useFeedStore.getState().manifests,
            ownedChannel.channelID,
          ),
          ...objectIDsReferencedBy(usePinStore.getState().pinned),
        ])
        await deletePublishedItem(
          sdk,
          agent,
          ownedChannel,
          input.item.id,
          protectedIDs,
        )
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

  // Color axis is ownership: green = "you own it", light green = "click to own
  // it". (State-aware PinIcon uses currentColor, so the parent button drives
  // color + opacity.)
  //  pinnable / edited → light green, never dimmed; brightens slightly on hover
  //                      (the offer to own). edited keeps its drift dot.
  //  pinned            → owned green, dimmed at rest; hovering lifts the dim and
  //                      brightens within the owned-green family ("wakes up as
  //                      you reach for it"), fading back out as you move away.
  const colorClass =
    pinState === 'pinned'
      ? 'text-green-700 opacity-50 hover:opacity-100 hover:text-green-600'
      : 'text-green-400 hover:text-green-500'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || !sdk}
      title={title}
      aria-pressed={pinState === 'pinned'}
      className={`p-1 cursor-pointer transition-all duration-300 disabled:cursor-default disabled:opacity-50 ${colorClass}`}
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
