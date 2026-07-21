import { Builder } from '@siafoundation/sia-storage'
import { useState } from 'react'
import { APP_META, DEFAULT_INDEXER_URL } from '../../lib/constants'
import { useAuthStore } from '../../stores/auth'

export function WelcomeScreen({
  builder,
  isReturning,
}: {
  builder: React.RefObject<Builder | null>
  isReturning: boolean
}) {
  const indexerURL = useAuthStore((s) => s.indexerURL)
  const setIndexerURL = useAuthStore((s) => s.setIndexerURL)
  const setStep = useAuthStore((s) => s.setStep)
  const setError = useAuthStore((s) => s.setError)
  const setApprovalURL = useAuthStore((s) => s.setApprovalURL)

  const [url, setUrl] = useState(indexerURL || DEFAULT_INDEXER_URL)
  const [loading, setLoading] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  async function startSiaConnect() {
    setLoading(true)
    setError(null)
    try {
      const b = new Builder(url, APP_META)
      builder.current = b
      setIndexerURL(url)
      await b.requestConnection()
      setApprovalURL(b.responseUrl())
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
      </div>
    </div>
  )
}
