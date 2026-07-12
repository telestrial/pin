import { useEffect, useRef, useState } from 'react'
import {
  closeWindow,
  isFullscreen,
  minimizeWindow,
  toggleFullscreen,
} from '../lib/desktop'
import { inTauri } from '../lib/openExternal'
import { PinIcon } from './pin/PinIcon'

// The navbar's right-slot pin. Forks by environment:
//  - Web: there's no OS window to control, so the pin is a direct soft-lock
//    (today's behavior).
//  - Desktop (Tauri, frameless window): the pin opens a window menu —
//    Minimize · Full screen · Lock · Close — since the native title bar is gone.
//
// Lock is the existing SOFT lock (visual gate, session stays live, no
// credential). Close quits today; once the keeper runs it should mean
// hide-window-keep-backend (tray) — see CLAUDE.md.
export function PinMenu({ onLock }: { onLock: () => void }) {
  const desktop = inTauri()
  const [open, setOpen] = useState(false)
  const [fs, setFs] = useState(false)
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

  // Sync the Full screen / Exit full screen label when the menu opens.
  useEffect(() => {
    if (open && desktop) isFullscreen().then(setFs)
  }, [open, desktop])

  const pinClasses =
    'text-green-700 opacity-50 hover:opacity-100 hover:text-green-600 transition-all duration-300 cursor-pointer'

  // Web: direct soft-lock, no menu.
  if (!desktop) {
    return (
      <button
        type="button"
        onClick={onLock}
        title="Lock"
        aria-label="Lock"
        className={`justify-self-end ${pinClasses}`}
      >
        <PinIcon state="pinned" />
      </button>
    )
  }

  // Desktop: window menu.
  return (
    <div ref={wrapRef} className="relative justify-self-end">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Window"
        aria-label="Window menu"
        className={pinClasses}
      >
        <PinIcon state="pinned" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 min-w-40 bg-white border border-neutral-200 rounded-lg shadow-lg py-1 z-30"
        >
          <MenuItem
            onClick={() => {
              setOpen(false)
              void minimizeWindow()
            }}
          >
            Minimize
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false)
              void toggleFullscreen()
            }}
          >
            {fs ? 'Exit full screen' : 'Full screen'}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false)
              onLock()
            }}
          >
            Lock
          </MenuItem>
          <div className="my-1 border-t border-neutral-100" />
          <MenuItem
            danger
            onClick={() => {
              setOpen(false)
              void closeWindow()
            }}
          >
            Close
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs font-medium cursor-pointer ${
        danger
          ? 'text-red-600 hover:bg-red-50'
          : 'text-neutral-700 hover:bg-neutral-50'
      }`}
    >
      {children}
    </button>
  )
}
