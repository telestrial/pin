import { useEffect, useRef, useState } from 'react'
import {
  type CuratorStatus,
  curatorDocTicket,
  curatorStatus,
  startCurator,
  stopCurator,
} from '../lib/curator'
import { useReachablePeople } from '../lib/hooks/useReachablePeople'
import { useAuthStore } from '../stores/auth'
import { CopyButton } from './ui/CopyButton'

// The Curate page (rendered inside a FormCard by Home). Reachable from the
// sidebar on both web and desktop. The Curator — Pin's optional always-on
// agent — can only run in the desktop shell, so on web this view explains what
// curation is and that it lives on the desktop; on desktop it's the on/off
// toggle, live status, and (for now, dev-facing) iroh network diagnostics.
//
// "Curate" here is the museum sense, not the feed-algorithm sense: an agent
// that, on your behalf, tends your collection — preserving your bytes, keeping
// them reachable, and arranging what reaches you from the people you follow.
// First-person throughout: it's *your* curator, working to your taste, never a
// platform deciding for you.
export function CurateView() {
  const [status, setStatus] = useState<CuratorStatus | null>(null)
  const [ticket, setTicket] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      // Don't clobber the optimistic state mid start/stop.
      if (busyRef.current) return
      const s = await curatorStatus()
      if (!cancelled) setStatus(s)
      // The doc ticket lives on a separate command (not in the status snapshot);
      // fetch it alongside so it's copyable for the browser<->Curator sync test.
      const t = await curatorDocTicket()
      if (!cancelled) setTicket(t)
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const toggle = async () => {
    if (!status || busy) return
    setBusy(true)
    busyRef.current = true
    try {
      let next: CuratorStatus
      if (status.running) {
        next = await stopCurator()
      } else {
        // Hand the Curator the already-unlocked Sia identity so it can mirror the
        // repo under the user's own scope.
        const { storedKeyHex, indexerURL } = useAuthStore.getState()
        next = await startCurator(storedKeyHex, indexerURL)
      }
      setStatus(next)
    } finally {
      setBusy(false)
      busyRef.current = false
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

      <NetworkReach />

      {available ? (
        <>
          <section className="border border-neutral-200 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">
                  Curation
                </h2>
                <p className="text-xs text-neutral-500 mt-1 flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${
                      running
                        ? status?.online
                          ? 'bg-green-500'
                          : 'bg-amber-500'
                        : 'bg-neutral-300'
                    }`}
                  />
                  {status === null
                    ? 'Checking…'
                    : running
                      ? `On — ${status.phase}`
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

          {running && status && <Diagnostics status={status} ticket={ticket} />}
        </>
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

// How many distinct identities you can reach through your network — the people
// you directly hold plus the people they follow, one hop out. Client-side (a
// bounded walk of public follow records), so it renders on web and desktop
// alike, Curator or not. Today it's just the raw number; a search over these
// people is the eventual follow-on. ("People" is loose — the true unit is
// distinct identities/DIDs; personas mean it can't collapse to humans — but
// it's the warm word, and easily relabeled.)
function NetworkReach() {
  const { reach, loading, error } = useReachablePeople()
  return (
    <section className="border border-neutral-200 rounded-lg p-4 space-y-1">
      <h2 className="text-sm font-semibold text-neutral-900">Your network</h2>
      {error ? (
        <p className="text-xs text-neutral-400">
          Couldn't reach the network right now.
        </p>
      ) : loading && !reach ? (
        <p className="text-sm text-neutral-500">Counting…</p>
      ) : reach && reach.total > 0 ? (
        <>
          <div className="text-3xl font-bold text-neutral-900">
            {reach.total}
          </div>
          <p className="text-xs text-neutral-500">
            people you know
            {reach.extended > 0 && (
              <>
                {' '}
                · {reach.direct} directly, {reach.extended} through them
              </>
            )}
          </p>
        </>
      ) : (
        <p className="text-sm text-neutral-500">
          Follow some channels to start building your network.
        </p>
      )}
    </section>
  )
}

// Dev-facing network diagnostics for the running iroh endpoint. Verbose on
// purpose — we want to read the node's reachability in detail while building
// the Curator out.
function Diagnostics({
  status,
  ticket,
}: {
  status: CuratorStatus
  ticket: string | null
}) {
  return (
    <section className="border border-neutral-200 rounded-lg p-4 space-y-4">
      <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-500">
        Network diagnostics
      </h2>

      <Field label="Phase" value={status.phase} />
      <Field
        label="Status"
        value={status.online ? 'online — reachable' : 'connecting…'}
      />
      <Field
        label="Uptime"
        value={status.uptimeSecs == null ? '—' : `${status.uptimeSecs}s`}
      />

      <div className="space-y-1">
        <div className="text-xs font-medium text-neutral-500">Node ID</div>
        {status.nodeId ? (
          <div className="flex items-start gap-2">
            <code className="text-xs font-mono text-neutral-700 break-all flex-1">
              {status.nodeId}
            </code>
            <CopyButton value={status.nodeId} label="Node ID copied" />
          </div>
        ) : (
          <div className="text-xs text-neutral-400">—</div>
        )}
      </div>

      <AddrList
        label="Direct addresses · preferred path"
        addrs={status.directAddrs}
      />
      <AddrList label="Relay · fallback only" addrs={status.relays} />
      {status.otherAddrs.length > 0 && (
        <AddrList label="Other addresses" addrs={status.otherAddrs} />
      )}

      <p className="text-xs text-neutral-400 leading-relaxed">
        iroh connects directly (holepunched, peer-to-peer) whenever it can and
        falls back to the relay only when a direct path can't be established —
        the relay is never the default data path. The actual per-connection path
        (direct vs relayed) will appear here once peers connect.
      </p>

      <div className="space-y-1 pt-1 border-t border-neutral-100">
        <div className="text-xs font-medium text-neutral-500 pt-3">
          Identity
        </div>
        {status.didDht ? (
          <div className="flex items-start gap-2">
            <code className="text-xs font-mono text-neutral-700 break-all flex-1">
              {status.didDht}
            </code>
            <CopyButton value={status.didDht} label="did:dht copied" />
          </div>
        ) : (
          <div className="text-xs text-neutral-400">—</div>
        )}
        {status.didDhtPublished && (
          <div className="text-xs text-neutral-400 break-all">
            DHT:{' '}
            <span
              className={
                status.didDhtPublished.startsWith('ok')
                  ? 'text-green-600'
                  : 'text-red-600'
              }
            >
              {status.didDhtPublished}
            </span>
          </div>
        )}
        <p className="text-xs text-neutral-400 leading-relaxed">
          Your resolvable did:dht identity, derived from your recovery phrase —
          no registry, no company. Its document points at your iroh node and the
          repo namespace peers sync from.
        </p>
      </div>

      <div className="space-y-1 pt-1 border-t border-neutral-100">
        <div className="text-xs font-medium text-neutral-500 pt-3 flex items-center justify-between gap-2">
          <span>Local repo</span>
          {status.docsNamespace && (
            <span className="font-normal text-neutral-400">
              {status.docsReopened ? 'reopened from disk' : 'created fresh'}
            </span>
          )}
        </div>
        {status.docsNamespace ? (
          <div className="flex items-start gap-2">
            <code className="text-xs font-mono text-neutral-700 break-all flex-1">
              {status.docsNamespace}
            </code>
            <CopyButton value={status.docsNamespace} label="Namespace copied" />
          </div>
        ) : (
          <div className="text-xs text-neutral-400">—</div>
        )}
      </div>

      <div className="space-y-1 pt-1 border-t border-neutral-100">
        <div className="text-xs font-medium text-neutral-500 pt-3">
          Doc ticket
        </div>
        {ticket ? (
          <div className="flex items-start gap-2">
            <code className="text-xs font-mono text-neutral-700 break-all flex-1">
              {ticket}
            </code>
            <CopyButton value={ticket} label="Doc ticket copied" />
          </div>
        ) : (
          <div className="text-xs text-neutral-400">—</div>
        )}
        <p className="text-xs text-neutral-400 leading-relaxed">
          A capability to live-sync this Curator's repo. A browser tab signed in
          to the same account imports it (dev: __pinSync.sync) to reconcile with
          the Curator — one import syncs both ways.
        </p>
      </div>

      <div className="space-y-1 pt-1">
        <div className="text-xs font-medium text-neutral-500">
          RPC <span className="font-normal text-neutral-400">pin-keeper/0</span>
        </div>
        <Field label="Serving" value={status.rpcServing ? 'yes' : 'no'} />
        <Field
          label="Inbox"
          value={
            status.heyQueued === 1 ? '1 knock' : `${status.heyQueued} knocks`
          }
        />
        {status.rpcSelftest && (
          <div className="text-xs text-neutral-400 break-all">
            self-test:{' '}
            <span
              className={
                status.rpcSelftest.startsWith('ok')
                  ? 'text-green-600'
                  : 'text-red-600'
              }
            >
              {status.rpcSelftest}
            </span>
          </div>
        )}
      </div>

      <div className="space-y-1 pt-1 border-t border-neutral-100">
        <div className="text-xs font-medium text-neutral-500 pt-3">
          Sia mirror
        </div>
        <Field label="State" value={status.mirrorState} />
        {status.mirrorError ? (
          <code className="text-xs font-mono text-red-700 break-all block">
            {status.mirrorError}
          </code>
        ) : (
          <>
            {status.mirrorRoot && (
              <div className="text-xs text-neutral-400 break-all">
                root{' '}
                <span className="font-mono text-neutral-500">
                  {status.mirrorRoot}
                </span>
              </div>
            )}
            {status.mirrorUrl && (
              <div className="flex items-start gap-2">
                <code className="text-xs font-mono text-neutral-700 break-all flex-1">
                  {status.mirrorUrl}
                </code>
                <CopyButton
                  value={status.mirrorUrl}
                  label="Mirror URL copied"
                />
              </div>
            )}
          </>
        )}
      </div>

      {status.lastError && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-red-600">Last error</div>
          <code className="text-xs font-mono text-red-700 break-all block">
            {status.lastError}
          </code>
        </div>
      )}
    </section>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      <span className="text-xs text-neutral-700">{value}</span>
    </div>
  )
}

function AddrList({ label, addrs }: { label: string; addrs: string[] }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-neutral-500">
        {label} ({addrs.length})
      </div>
      {addrs.length === 0 ? (
        <div className="text-xs text-neutral-400">—</div>
      ) : (
        <ul className="space-y-0.5">
          {addrs.map((a) => (
            <li
              key={a}
              className="text-xs font-mono text-neutral-700 break-all"
            >
              {a}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
