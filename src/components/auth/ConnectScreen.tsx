import { Pin } from 'lucide-react'
import { useState } from 'react'
import { Builder } from '@siafoundation/sia-storage'
import { APP_META, DEFAULT_INDEXER_URL } from '../../lib/constants'
import { useAuthStore } from '../../stores/auth'

export function ConnectScreen({
  builder,
}: {
  builder: React.RefObject<Builder | null>
}) {
  const { indexerURL, setIndexerURL, setStep, setError, setApprovalURL } =
    useAuthStore()
  const [url, setUrl] = useState(indexerURL || DEFAULT_INDEXER_URL)
  const [loading, setLoading] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  async function handleConnect() {
    setLoading(true)
    setError(null)
    try {
      const b = new Builder(url, APP_META)
      builder.current = b
      setIndexerURL(url)

      try {
        await b.requestConnection()
        const approvalURL = b.responseUrl()
        setApprovalURL(approvalURL)
        setStep('approve')
      } catch (e) {
        setError(
          e instanceof Error
            ? `Couldn't reach the indexer: ${e.message}`
            : "Couldn't reach the indexer.",
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12 bg-[radial-gradient(circle_at_top,var(--tw-gradient-stops))] from-green-50/40 via-white to-neutral-100">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm p-8 sm:p-10 space-y-8">
          <div className="text-center space-y-5">
            <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-green-50 border border-green-100">
              <Pin
                className="size-7 text-green-600"
                fill="currentColor"
              />
            </div>
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold text-neutral-900 tracking-tight">
                Welcome to Pin
              </h1>
              <p className="text-neutral-600 text-[15px] leading-relaxed">
                Publish to your friends, not to an algorithm. Your bytes
                live on Sia, your channels live in your ATProto repo, and
                the link you share is the only way in.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={handleConnect}
              disabled={loading || !url}
              className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-medium rounded-lg transition-colors"
            >
              {loading ? 'Connecting…' : 'Get started'}
            </button>
            <p className="text-center text-xs text-neutral-500">
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

        <p className="mt-6 text-center text-[11px] text-neutral-400">
          Built on{' '}
          <a
            href="https://sia.tech"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neutral-700 underline-offset-2 hover:underline"
          >
            Sia
          </a>{' '}
          and{' '}
          <a
            href="https://atproto.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neutral-700 underline-offset-2 hover:underline"
          >
            ATProto
          </a>
          . No Pin server in the middle.
        </p>
      </div>
    </div>
  )
}
