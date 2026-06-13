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
  // The in-flight batch job (if any) — drives the in-place progress pin.
  // It lives in the store, so it survives this button unmounting (navigate
  // away mid-pin and the sidebar keeps the progress).
  const job = usePinStore((s) => s.channelPins[channelID])
  const busy = !!job
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

  const title = job
    ? `${job.mode === 'unpin' ? 'Unpinning' : 'Pinning'} ${job.done}/${job.total}…`
    : state === 'pinned'
      ? `Unpin this channel from your storage (${formatBytes(size)})`
      : state === 'edited'
        ? `Catch up — pin new items (channel is ${formatBytes(size)})`
        : `Pin this channel to your storage (${formatBytes(size)})`

  // Fill direction: pinning fills the pin bottom-up (done/total), unpinning
  // drains it back down (remaining/total).
  const pct =
    job && job.total > 0
      ? job.mode === 'unpin'
        ? ((job.total - job.done) / job.total) * 100
        : (job.done / job.total) * 100
      : 0

  // Color axis matches the item PinButton: green = "you own it", light green
  // = "click to own it". (PinIcon uses currentColor; the button drives color +
  // opacity.)
  //  pinnable / edited → light green, never dimmed (the offer to own the channel)
  //  pinned            → owned green, dimmed at rest; hover lifts the dim and
  //                      brightens within the owned-green family, fading back out
  const colorClass =
    state === 'pinned'
      ? 'text-green-700 opacity-50 hover:opacity-100 hover:text-green-600'
      : 'text-green-400 hover:text-green-500'

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        title={title}
        aria-pressed={state === 'pinned'}
        className={`p-1 cursor-pointer transition-all duration-300 disabled:cursor-default disabled:opacity-50 ${colorClass}`}
      >
        {busy ? (
          <ProgressPin pct={pct} />
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

// The pin glyph as a determinate progress indicator: a neutral outline with
// a green fill rising from the bottom as `pct` climbs (0→100). The fill is a
// bottom-anchored, height-clipped copy of the solid pin layered over the
// outline, so the pin shape itself "fills with green" in place. Pinning
// fills up; unpinning drains down (caller flips pct accordingly).
function ProgressPin({ pct }: { pct: number }) {
  const h = Math.max(0, Math.min(100, pct))
  return (
    <span className="relative inline-flex size-6 text-neutral-400">
      <PinIcon state="pinnable" aria-hidden="true" />
      <span
        className="absolute inset-x-0 bottom-0 overflow-hidden text-green-600 transition-[height] duration-200"
        style={{ height: `${h}%` }}
      >
        <span className="absolute bottom-0 left-0 inline-flex size-6">
          <PinIcon state="pinned" aria-hidden="true" />
        </span>
      </span>
    </span>
  )
}
