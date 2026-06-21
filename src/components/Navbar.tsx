import { APP_NAME } from '../lib/constants'
import { PinIcon } from './pin/PinIcon'

// Connected-only header. Three zones (grid-cols-3) so the wordmark is truly
// centered regardless of the right action's width: empty left · "Pin" center ·
// lock pin right. The right pin behaves like any owned pin (filled green,
// dim-at-rest, wake-on-hover); clicking it soft-locks the session — releasing
// custody of the surface, the same gesture as unpinning.
export function Navbar({ onLock }: { onLock: () => void }) {
  return (
    <header className="bg-white border-b border-neutral-200/80 px-6">
      <div className="grid grid-cols-3 items-center py-3">
        <div />
        <h1 className="justify-self-center text-sm font-semibold text-neutral-900 tracking-tight">
          {APP_NAME}
        </h1>
        <button
          type="button"
          onClick={onLock}
          title="Lock"
          aria-label="Lock"
          className="justify-self-end text-green-700 opacity-50 hover:opacity-100 hover:text-green-600 transition-all duration-300 cursor-pointer"
        >
          <PinIcon state="pinned" />
        </button>
      </div>
    </header>
  )
}
