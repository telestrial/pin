import { useEffect } from 'react'
import { connectSiaClient } from '../../lib/connectSiaClient'
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

  useEffect(() => {
    let cancelled = false

    async function init() {
      const { storedKeyHex, indexerURL, setClient, setStep } =
        useAuthStore.getState()

      // Restore from the persisted AppKey, if there is one. Anything that goes
      // wrong here — a key the indexer no longer recognises, an unreachable
      // indexer — lands on the same place: the welcome screen, which reads
      // storedKeyHex itself to tell a returning user from a new one.
      if (storedKeyHex && indexerURL) {
        try {
          const client = await connectSiaClient(storedKeyHex, indexerURL)
          if (cancelled) return
          setClient(client)
          return
        } catch {
          if (cancelled) return
        }
      }

      setStep('welcome')
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
        {step === 'welcome' && <WelcomeScreen isReturning={!!storedKeyHex} />}
        {step === 'approve' && <ApproveScreen />}
        {step === 'recovery' && <RecoveryScreen />}
      </AuthShell>
    </>
  )
}
