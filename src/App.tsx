import { useEffect } from 'react'
import { AuthFlow } from './components/auth/AuthFlow'
import { Home } from './components/Home'
import { Navbar } from './components/Navbar'
import { Toasts } from './components/Toast'
import { bootOauth } from './lib/atprotoClient'
import './lib/debug'
import { useJetstream } from './lib/useJetstream'
import { useSettingsSync } from './lib/useSettingsSync'
import { useUploadRunner } from './lib/useUploadRunner'
import { useAuthStore } from './stores/auth'
import { usePinStore } from './stores/pin'

export default function App() {
  const step = useAuthStore((s) => s.step)
  const sdk = useAuthStore((s) => s.sdk)

  useJetstream()
  useUploadRunner()
  useSettingsSync()

  // OAuth bootstrap — runs once on mount. bootOauth() memoizes the init()
  // call so React StrictMode's double-mount doesn't race two concurrent
  // callbacks against the same URL params (the second would lose, since
  // the first consumed them). Both StrictMode runs share one promise.
  // If a session is restored or freshly minted, we hydrate the store and
  // fetch the handle for display + subscribe URLs.
  useEffect(() => {
    if (useAuthStore.getState().atprotoAgent) return
    let cancelled = false
    ;(async () => {
      try {
        const result = await bootOauth()
        if (!result) return
        const { agent, session } = result
        let handle: string | null = useAuthStore.getState().atprotoHandle
        try {
          const profile = await agent.getProfile({ actor: session.did })
          handle = profile.data.handle
        } catch {
          // Profile fetch failed — keep whatever handle was cached.
        }
        if (cancelled) return
        useAuthStore
          .getState()
          .setATProtoIdentity(agent, session.did, handle)
      } catch (e) {
        console.warn('Failed to init ATProto OAuth client:', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!sdk) return
    usePinStore.getState().refreshAccount(sdk)
  }, [sdk])

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="flex-1 flex flex-col">
        {step === 'connected' ? <Home /> : <AuthFlow />}
      </div>
      <Toasts />
    </div>
  )
}
