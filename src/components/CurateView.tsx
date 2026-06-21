import { useEffect, useState } from 'react'
import {
  curatorStatus,
  startCurator,
  stopCurator,
  type CuratorStatus,
} from '../lib/curator'

// The Curate page (rendered inside a FormCard by Home). Reachable from the
// sidebar on both web and desktop. The Curator — Pin's optional always-on
// agent — can only run in the desktop shell, so on web this view explains what
// curation is and that it lives on the desktop; on desktop it's the on/off
// toggle and live status.
//
// "Curate" here is the museum sense, not the feed-algorithm sense: an agent
// that, on your behalf, tends your collection — preserving your bytes, keeping
// them reachable, and arranging what reaches you from the people you follow.
// First-person throughout: it's *your* curator, working to your taste, never a
// platform deciding for you.
export function CurateView() {
  const [status, setStatus] = useState<CuratorStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    curatorStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = async () => {
    if (!status || busy) return
    setBusy(true)
    try {
      const next = status.running ? await stopCurator() : await startCurator()
      setStatus(next)
    } finally {
      setBusy(false)
    }
  }

  const available = status?.available ?? false
  const running = status?.running ?? false

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-900">Curate</h1>

      <section className="border border-neutral-200 rounded-lg p-4 space-y-2">
        <p className="text-sm text-neutral-700 leading-relaxed">
          A curator tends a collection — acquiring, preserving, and arranging it
          with care. Turn this on and Pin does the same for you in the
          background: keeping your bytes alive and reachable, and gathering and
          arranging what reaches you from the channels and people you follow.
        </p>
        <p className="text-xs text-neutral-500 leading-relaxed">
          It works to your taste, from what you've chosen to follow — never an
          algorithm deciding for you.
        </p>
      </section>

      {available ? (
        <section className="border border-neutral-200 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-neutral-900">
                Curation
              </h2>
              <p className="text-xs text-neutral-500 mt-1">
                {status === null
                  ? 'Checking…'
                  : running
                    ? 'On — your curator is running.'
                    : 'Off.'}
              </p>
            </div>
            <button
              type="button"
              onClick={toggle}
              disabled={status === null || busy}
              aria-pressed={running}
              className={`shrink-0 px-3 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer disabled:opacity-60 ${
                running
                  ? 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                  : 'bg-green-600 text-white hover:bg-green-700'
              }`}
            >
              {busy
                ? running
                  ? 'Stopping…'
                  : 'Starting…'
                : running
                  ? 'Turn off'
                  : 'Enable curation'}
            </button>
          </div>
        </section>
      ) : (
        <section className="border border-neutral-200 rounded-lg p-4">
          <p className="text-xs text-neutral-500 leading-relaxed">
            Curation runs in the Pin desktop app, which can stay on and work the
            network in the background. Open Pin on your desktop to turn it on.
          </p>
        </section>
      )}
    </div>
  )
}
