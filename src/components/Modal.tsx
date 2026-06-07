import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// Lightweight modal shell: a portal to <body> with a dimmed backdrop, a
// centered card, Escape-to-close, backdrop-click-to-close, and scroll lock.
// Presentational only — callers provide the content (title, body, action
// buttons). aria-modal + role=dialog; focus moves to the card on open.
export function Modal({
  onClose,
  labelledBy,
  describedBy,
  children,
}: {
  onClose: () => void
  // ids of the title / description elements the caller renders, for a11y
  labelledBy?: string
  describedBy?: string
  children: React.ReactNode
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Scroll lock while open; restore on close.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Move focus into the dialog so Escape/Tab land here, not on the
    // background.
    cardRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm cursor-default"
      />
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the dialog card is focused on open so keyboard events land inside the modal */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm bg-white rounded-xl shadow-xl border border-neutral-200 p-5 focus:outline-none"
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
