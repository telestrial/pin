import { AppKey, Builder, initSia } from '@siafoundation/sia-storage'
import { useEffect, useRef } from 'react'
import { bootOauth } from '../../lib/atprotoClient'
import { APP_META, DEFAULT_INDEXER_URL } from '../../lib/constants'
import { useAuthStore } from '../../stores/auth'
import { ApproveScreen } from './ApproveScreen'
import { AuthShell } from './AuthShell'
import { BlueskyOnboardingScreen } from './BlueskyOnboardingScreen'
import { RecoveryScreen } from './RecoveryScreen'
import { WelcomeScreen } from './WelcomeScreen'

export function AuthFlow() {
  const step = useAuthStore((s) => s.step)
  const error = useAuthStore((s) => s.error)
  const setError = useAuthStore((s) => s.setError)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const atprotoHandle = useAuthStore((s) => s.atprotoHandle)
  const builderRef = useRef<Builder | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      const {
        storedKeyHex,
        indexerURL,
        setSdk,
        setStep,
        setIndexerURL,
        setApprovalURL,
      } = useAuthStore.getState()
      try {
        // Run WASM init and OAuth restore in parallel. Both are memoized;
        // re-entry from elsewhere reuses the same promises.
        const [, oauthResult] = await Promise.all([initSia(), bootOauth()])
        if (cancelled) return

        // Try to restore Sia using the persisted AppKey, if any.
        if (storedKeyHex && indexerURL) {
          try {
            const appKey = new AppKey(Uint8Array.fromHex(storedKeyHex))
            const builder = new Builder(indexerURL, APP_META)
            builderRef.current = builder
            const sdk = await builder.connected(appKey)
            if (cancelled) return
            if (sdk) {
              setSdk(sdk)
              return
            }
          } catch {
            // Connect failed — fall through to deciding what to show.
          }
        }

        // Sia is not connected. Decide what step to show.
        const hasBluesky = oauthResult !== null
        if (!storedKeyHex && hasBluesky) {
          // Mid-flow: user just came back from a Bluesky OAuth round-trip
          // started from the welcome screen's "Get started" path. Continue
          // straight to Sia approval — no need to show welcome again.
          const url = indexerURL || DEFAULT_INDEXER_URL
          const b = new Builder(url, APP_META)
          builderRef.current = b
          setIndexerURL(url)
          await b.requestConnection()
          if (cancelled) return
          setApprovalURL(b.responseUrl())
          setStep('approve')
        } else {
          // Either brand new user or returning user whose Sia session needs
          // a refresh. WelcomeScreen handles both variants by reading
          // storedKeyHex + atprotoHandle from the store directly.
          setStep('welcome')
        }
      } catch (e) {
        if (cancelled) return
        console.error('Init error:', e)
        setStep('welcome')
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [])

  const isReady = step !== 'loading'

  return (
    <>
      {error && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm max-w-md text-center shadow-sm">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 text-red-600 hover:text-red-900"
          >
            Dismiss
          </button>
        </div>
      )}

      <AuthShell ready={isReady}>
        {step === 'welcome' && (
          <WelcomeScreen
            builder={builderRef}
            isReturning={!!storedKeyHex}
            knownHandle={atprotoHandle}
          />
        )}
        {step === 'bluesky-onboarding' && (
          <BlueskyOnboardingScreen
            onCancel={() => useAuthStore.getState().setStep('welcome')}
          />
        )}
        {step === 'approve' && <ApproveScreen builder={builderRef} />}
        {step === 'recovery' && <RecoveryScreen builder={builderRef} />}
      </AuthShell>
    </>
  )
}
