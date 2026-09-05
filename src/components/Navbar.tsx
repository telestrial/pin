import { APP_NAME } from '../lib/constants'
import type { View } from './Home'
import { NetworkSearch } from './NetworkSearch'
import { PinMenu } from './PinMenu'

// Connected-only header. The pin and the wordmark sit together at the far left as one
// lockup, and search takes the rest of the bar — the wordmark used to be centred in a
// three-column grid, and giving search real width was worth more than the centring.
//
// In the desktop shell the native title bar is removed (decorations:false), so this header
// IS the title bar: `data-tauri-drag-region` makes the empty areas drag the window
// (double-click maximizes). The PinMenu button and the search box are interactive, not
// drag regions — an input inside a drag region cannot be clicked into. On the web the
// attribute is ignored.
export function Navbar({
  onLock,
  onNavigate,
}: {
  onLock: () => void
  onNavigate: (view: View) => void
}) {
  return (
    <header className="bg-white border-b border-neutral-200/80 px-6">
      <div
        data-tauri-drag-region
        className="flex items-center gap-3 py-3 select-none"
      >
        <PinMenu onLock={onLock} />
        <h1 className="text-sm font-semibold text-neutral-900 tracking-tight">
          {APP_NAME}
        </h1>
        <NetworkSearch
          onPerson={(handle) =>
            onNavigate({ kind: 'handle-directory', handle })
          }
          onChannel={(authorHandle, channelID) =>
            onNavigate({ kind: 'viewing-channel', authorHandle, channelID })
          }
        />
        {/* Takes the slack so the search box keeps its width rather than stretching to
            the far edge, and gives the window something to be dragged by. */}
        <div data-tauri-drag-region className="flex-1" />
      </div>
    </header>
  )
}
