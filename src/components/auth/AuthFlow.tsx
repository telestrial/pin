import { AppKey, Builder, initSia } from '@siafoundation/sia-storage'
import { useEffect, useRef } from 'react'
import { APP_META } from '../../lib/constants'
import { useAuthStore } from '../../stores/auth'
import { ApproveScreen } from './ApproveScreen'
import { AuthShell } from './AuthShell'
import { RecoveryScreen } from './RecoveryScreen'
import { WelcomeScreen } from './WelcomeScreen'

export function AuthFlow() {
  const step = useAuthStore((s) => s.step)
  const error = useAuthStore((s) => s.error)
  const setError = useAuthStore((s) => s.setError)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const builderRef = useRef<Builder | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      const { storedKeyHex, indexerURL, setSdk, setStep } =
        useAuthStore.getState()
      try {
        await initSia()
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
            // Connect failed — fall through to welcome.
          }
        }

        // Sia is not connected: brand-new user, or a returning user whose
        // session needs a refresh. WelcomeScreen handles both by reading
        // storedKeyHex from the store directly.
        setStep('welcome')
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
          <WelcomeScreen builder={builderRef} isReturning={!!storedKeyHex} />
        )}
        {step === 'approve' && <ApproveScreen builder={builderRef} />}
        {step === 'recovery' && <RecoveryScreen builder={builderRef} />}
      </AuthShell>
    </>
  )
}
