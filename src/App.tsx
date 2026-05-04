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
  // call (handle fetch included) so React StrictMode's double-mount doesn't
  // race two concurrent callbacks. Both StrictMode runs share one promise.
  // AuthFlow awaits the same memoized promise to decide its initial step.
  useEffect(() => {
    if (useAuthStore.getState().atprotoAgent) return
    bootOauth()
      .then((result) => {
        if (!result) return
        useAuthStore
          .getState()
          .setATProtoIdentity(result.agent, result.did, result.handle)
      })
      .catch((e) => {
        console.warn('Failed to init ATProto OAuth client:', e)
      })
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
