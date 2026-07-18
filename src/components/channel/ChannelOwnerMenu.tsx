import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useToastStore } from '../../stores/toast'
import { Modal } from '../ui/Modal'

// Owner-actions menu for a channel you authored. Horizontal-dots trigger →
// dropdown. Today it holds one item: the claim toggle.
//
// Advertising a public channel in your identity-doc is the claim of authorship
// — it's what makes the channel appear under "Voices" on your profile. Unclaim
// removes that public association: the channel stays public and readable, it
// just stops being advertised as yours. Reclaim is instant; Unclaim asks first,
// because stepping back from a voice is the weightier direction. Both are a
// local flag flip now (no atproto) — the identity-doc republishes off it.
//
// Controlled: the claim state lives in the parent (ChannelView) via
// useChannelClaim, so the header "Unclaimed" badge and this menu agree and
// stay in sync across a toggle. The menu holds only the claim toggle, so the
// parent renders it only for public channels (claim doesn't apply to obscure
// ones); unpin/retract lives on the separate pin icon, not here.
export function ChannelOwnerMenu({
  channelName,
  claimed,
  onClaimedChange,
}: {
  channelName: string
  claimed: boolean
  onClaimedChange: (v: boolean) => void
}) {
  const addToast = useToastStore((s) => s.addToast)

  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close the dropdown on any outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function doReclaim() {
    onClaimedChange(true)
    addToast(`Reclaimed “${channelName}”`)
    setOpen(false)
  }

  function doUnclaim() {
    onClaimedChange(false)
    addToast(`Unclaimed “${channelName}”`)
    setConfirming(false)
    setOpen(false)
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Channel options"
        className="p-1.5 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors cursor-pointer"
      >
        <MoreHorizontal className="size-4" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 min-w-36 bg-white border border-neutral-200 rounded-lg shadow-lg py-1 z-20"
        >
          {claimed ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setConfirming(true)
              }}
              className="w-full text-left px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 cursor-pointer"
            >
              Unclaim
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={doReclaim}
              className="w-full text-left px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 cursor-pointer"
            >
              Reclaim
            </button>
          )}
        </div>
      )}

      {confirming && (
        <Modal
          onClose={() => setConfirming(false)}
          labelledBy="unclaim-title"
          describedBy="unclaim-desc"
        >
          <h2
            id="unclaim-title"
            className="text-base font-semibold text-neutral-900"
          >
            Unclaim “{channelName}”?
          </h2>
          <p id="unclaim-desc" className="text-sm text-neutral-600 pt-2">
            It stays public and readable — it just won't appear on your profile.
            You can reclaim it anytime.
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 rounded-md transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={doUnclaim}
              className="px-3 py-1.5 text-xs font-medium text-white bg-neutral-900 hover:bg-neutral-700 rounded-md transition-colors cursor-pointer"
            >
              Unclaim
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
