import { useState } from 'react'
import { DEFAULT_INDEXER_URL, type RelayPreset } from '../../lib/constants'
import { relaysForPreset } from '../../lib/relays'
import { requestSiaConnection } from '../../lib/siaAuth'
import { useAuthStore } from '../../stores/auth'

// What each preset means on the line above the picker. Short because the choice is
// between two places rather than between two lists of URLs.
const PRESET_LABEL: Record<RelayPreset, string> = {
  local: 'this machine',
  public: 'public relays',
  custom: 'a relay you named',
}

/** Several relays go in one field, comma-separated. Blank entries are dropped so a
 *  trailing comma mid-edit doesn't read as an empty URL. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

export function WelcomeScreen({ isReturning }: { isReturning: boolean }) {
  const indexerURL = useAuthStore((s) => s.indexerURL)
  const setIndexerURL = useAuthStore((s) => s.setIndexerURL)
  const relayPreset = useAuthStore((s) => s.relayPreset)
  const customPkarrRelays = useAuthStore((s) => s.customPkarrRelays)
  const customIrohRelays = useAuthStore((s) => s.customIrohRelays)
  const setRelays = useAuthStore((s) => s.setRelays)
  const setStep = useAuthStore((s) => s.setStep)
  const setError = useAuthStore((s) => s.setError)
  const setApprovalURL = useAuthStore((s) => s.setApprovalURL)

  const [url, setUrl] = useState(indexerURL || DEFAULT_INDEXER_URL)
  const [loading, setLoading] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showRelays, setShowRelays] = useState(false)

  async function startSiaConnect() {
    setLoading(true)
    setError(null)
    try {
      setIndexerURL(url)
      setApprovalURL(await requestSiaConnection(url))
      setStep('approve')
    } catch (e) {
      setError(
        e instanceof Error
          ? `Couldn't reach the indexer: ${e.message}`
          : "Couldn't reach the indexer.",
      )
      setLoading(false)
    }
  }

  return (
    <div className="text-center space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">
          {isReturning ? 'Welcome back' : 'Welcome to Pin'}
        </h1>
        <p className="text-neutral-600 text-[15px] leading-relaxed">
          {isReturning
            ? 'Your storage session needs a quick refresh. Approve again at sia.storage to pick up where you left off.'
            : 'Publish to your friends, not to an algorithm. Your identity and your bytes live on Sia and the peer network — no company in between — and the link you share is the only way in.'}
        </p>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={startSiaConnect}
          disabled={loading || !url}
          className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-medium rounded-lg transition-colors"
        >
          {loading ? 'Connecting…' : isReturning ? 'Continue' : 'Get started'}
        </button>
      </div>

      <div className="text-center text-xs text-neutral-500 space-y-2">
        <p>
          Storage via{' '}
          <code className="text-neutral-700 font-mono">
            {(() => {
              try {
                return new URL(url).host
              } catch {
                return url
              }
            })()}
          </code>
          {' · '}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="underline underline-offset-2 hover:text-neutral-900"
          >
            {showAdvanced ? 'Hide' : 'Change'}
          </button>
        </p>
        {showAdvanced && (
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://sia.storage"
            className="w-full px-4 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
          />
        )}
        <p>
          Network via{' '}
          <code className="text-neutral-700 font-mono">
            {PRESET_LABEL[relayPreset]}
          </code>
          {' · '}
          <button
            type="button"
            onClick={() => setShowRelays((v) => !v)}
            className="underline underline-offset-2 hover:text-neutral-900"
          >
            {showRelays ? 'Hide' : 'Change'}
          </button>
        </p>
        {showRelays && (
          <div className="space-y-2">
            <div className="flex gap-2">
              {(['local', 'public', 'custom'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    const set = relaysForPreset(p)
                    setRelays(
                      p,
                      p === 'custom' ? customPkarrRelays : set.pkarr,
                      p === 'custom' ? customIrohRelays : set.iroh,
                    )
                  }}
                  className={`flex-1 py-2 rounded-lg border text-sm transition-colors ${
                    relayPreset === p
                      ? 'border-green-600 text-green-700 bg-green-50'
                      : 'border-neutral-300 text-neutral-600 hover:border-neutral-400'
                  }`}
                >
                  {PRESET_LABEL[p]}
                </button>
              ))}
            </div>
            {relayPreset === 'custom' && (
              <>
                <input
                  type="url"
                  value={customPkarrRelays.join(', ')}
                  onChange={(e) =>
                    setRelays(
                      'custom',
                      splitList(e.target.value),
                      customIrohRelays,
                    )
                  }
                  placeholder="pkarr relay, e.g. http://127.0.0.1:6881"
                  className="w-full px-4 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
                />
                <input
                  type="url"
                  value={customIrohRelays.join(', ')}
                  onChange={(e) =>
                    setRelays(
                      'custom',
                      customPkarrRelays,
                      splitList(e.target.value),
                    )
                  }
                  placeholder="iroh relay, e.g. http://127.0.0.1:3340"
                  className="w-full px-4 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
                />
              </>
            )}
            <p className="text-neutral-400">
              Pin reaches the network through these and nothing else. Local
              wants <code className="font-mono">bun run dev:relays</code>{' '}
              running. A change takes effect on reload.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
