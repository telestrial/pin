import { APP_NAME } from '../lib/constants'
import { PinMenu } from './PinMenu'

// Connected-only header. Three zones (grid-cols-3) so the wordmark is truly
// centered regardless of the right action's width: empty left · "Pin" center ·
// pin right.
//
// In the desktop shell the native title bar is removed (decorations:false), so
// this header IS the title bar: `data-tauri-drag-region` makes the empty areas
// and the wordmark drag the window (double-click maximizes); the PinMenu button
// is interactive, not a drag region. On the web the attribute is ignored. The
// right pin opens a window menu on desktop / soft-locks on web (see PinMenu).
export function Navbar({ onLock }: { onLock: () => void }) {
  return (
    <header className="bg-white border-b border-neutral-200/80 px-6">
      <div
        data-tauri-drag-region
        className="grid grid-cols-3 items-center py-3 select-none"
      >
        <div data-tauri-drag-region />
        <h1
          data-tauri-drag-region
          className="justify-self-center text-sm font-semibold text-neutral-900 tracking-tight"
        >
          {APP_NAME}
        </h1>
        <PinMenu onLock={onLock} />
      </div>
    </header>
  )
}
