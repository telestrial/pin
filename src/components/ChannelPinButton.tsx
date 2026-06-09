import { useState } from 'react'
import type { ChannelManifest } from '../core/types'
import { formatBytes } from '../lib/format'
import {
  channelPinByteSize,
  useChannelPinState,
} from '../lib/useChannelPinState'
import { useAuthStore } from '../stores/auth'
import { usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { Modal } from './Modal'
import { PinIcon } from './PinIcon'

// Channel-level pin for a channel you DON'T own (owned channels use the
// retract path instead). Same icon, same green as the item PinButton; the
// click forks on the channel-pin state:
//   pinnable → pin all current items (body + attachments)
//   edited   → catch up: pin the new/drifted items (same fan-out, dedup'd)
//   pinned   → unpin all (behind a confirm — the one bulk-release mis-click)
// The hover tooltip shows the channel's content size — the same number the
// sidebar storage bar moves by, since both speak in content bytes.
export function ChannelPinButton({
  manifest,
  authorHandle,
  channelID,
  channelName,
}: {
  manifest: ChannelManifest | undefined
  authorHandle: string
  channelID: string
  channelName: string
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const pinChannel = usePinStore((s) => s.pinChannel)
  const unpinChannel = usePinStore((s) => s.unpinChannel)
  const busy = usePinStore((s) => s.isPinningChannel(channelID))
  const addToast = useToastStore((s) => s.addToast)
  const state = useChannelPinState(manifest, channelID)
  const [confirming, setConfirming] = useState(false)

  if (!sdk || !manifest) return null

  const size = channelPinByteSize(manifest)
  const channel = { authorHandle, channelID, name: channelName }

  async function handleClick() {
    if (!sdk || !manifest || busy) return
    if (state === 'pinned') {
      setConfirming(true)
      return
    }
    const { total, failed } = await pinChannel(sdk, manifest.items, channel)
    if (failed === 0) {
      addToast(
        state === 'edited'
          ? 'Channel caught up to current'
          : 'Channel pinned to your storage',
      )
    } else {
      addToast(`Pinned ${total - failed} of ${total} — ${failed} failed`)
    }
  }

  async function confirmUnpin() {
    setConfirming(false)
    if (!sdk) return
    const { total, failed } = await unpinChannel(sdk, channelID)
    addToast(
      failed === 0
        ? 'Channel unpinned'
        : `Unpinned ${total - failed} of ${total} — ${failed} failed`,
    )
  }

  const title =
    state === 'pinned'
      ? `Unpin this channel from your storage (${formatBytes(size)})`
      : state === 'edited'
        ? `Catch up — pin new items (channel is ${formatBytes(size)})`
        : `Pin this channel to your storage (${formatBytes(size)})`

  // Color delegation, same as the item PinButton: PinIcon uses currentColor,
  // the button drives green-vs-grey.
  const colorClass =
    state === 'pinned'
      ? 'text-green-600 hover:text-green-700'
      : 'text-neutral-400 hover:text-green-600'

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        title={title}
        aria-pressed={state === 'pinned'}
        className={`p-1.5 transition-colors hover:bg-neutral-100 rounded-md cursor-pointer disabled:opacity-50 ${colorClass}`}
      >
        {busy ? (
          <span className="block size-6">
            <span className="block size-6 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin" />
          </span>
        ) : (
          <PinIcon state={state} aria-hidden="true" />
        )}
      </button>
      {confirming && (
        <Modal
          onClose={() => setConfirming(false)}
          labelledBy="unpin-channel-title"
          describedBy="unpin-channel-desc"
        >
          <h2
            id="unpin-channel-title"
            className="text-base font-semibold text-neutral-900"
          >
            Unpin this channel?
          </h2>
          <p id="unpin-channel-desc" className="mt-2 text-sm text-neutral-600">
            This releases all {manifest.items.length} post
            {manifest.items.length === 1 ? '' : 's'} you've pinned from “
            {channelName}” from your storage ({formatBytes(size)}). You can pin
            it again anytime.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="px-3 py-1.5 text-xs font-medium text-neutral-700 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmUnpin}
              className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors cursor-pointer"
            >
              Unpin all
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
