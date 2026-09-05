import { APP_NAME } from '../lib/constants'
import type { View } from './Home'
import { NetworkSearch } from './NetworkSearch'
import { PinMenu } from './PinMenu'

// Connected-only header. Three zones (grid-cols-3) so the search box is truly centred
// regardless of what the wordmark and the pin measure: wordmark left · search centre ·
// pin right.
//
// In the desktop shell the native title bar is removed (decorations:false), so this header
// IS the title bar: `data-tauri-drag-region` makes the wordmark and the empty areas drag
// the window (double-click maximizes). The PinMenu button and the search box are
// interactive, not drag regions — an input inside one cannot be clicked into. On the web
// the attribute is ignored.
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
        className="grid grid-cols-3 items-center gap-3 py-3 select-none"
      >
        <h1
          data-tauri-drag-region
          className="text-sm font-semibold text-neutral-900 tracking-tight"
        >
          {APP_NAME}
        </h1>
        {/* The bar decides how wide search is, not the component: the same box sits in a
            dropdown of its own elsewhere and should not carry a header's measurements. */}
        <div className="justify-self-center w-full max-w-md">
          <NetworkSearch
            onPerson={(handle) =>
              onNavigate({ kind: 'handle-directory', handle })
            }
            onChannel={(authorHandle, channelID) =>
              onNavigate({ kind: 'viewing-channel', authorHandle, channelID })
            }
          />
        </div>
        <PinMenu onLock={onLock} />
      </div>
    </header>
  )
}
