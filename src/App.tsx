import { useEffect } from 'react'
import { AuthFlow } from './components/auth/AuthFlow'
import { Home } from './components/Home'
import { Navbar } from './components/Navbar'
import { Toasts } from './components/Toast'
import { bootOauth } from './lib/atprotoClient'
import './lib/debug'
import { useGhostReconciliation } from './lib/useGhostReconciliation'
import { useJetstream } from './lib/useJetstream'
import { useOrphanSweep } from './lib/useOrphanSweep'
import { useRepackRunner } from './lib/useRepackRunner'
import { useSettingsSync } from './lib/useSettingsSync'
import {
  useUploadQueueHydration,
  useUploadRunner,
} from './lib/useUploadRunner'
import { useAuthStore } from './stores/auth'
import { useComposeStore } from './stores/compose'
import { usePinStore } from './stores/pin'

export default function App() {
  const step = useAuthStore((s) => s.step)
  const sdk = useAuthStore((s) => s.sdk)
  const armedItem = useComposeStore((s) => s.armedItem)

  useJetstream()
  useUploadQueueHydration()
  useUploadRunner()
  useRepackRunner()
  useOrphanSweep()
  useSettingsSync()
  useGhostReconciliation()

  // While a pinned item is armed, mark the body so a global CSS rule
  // (in index.css) swaps the cursor to a Pin-green arrow everywhere on
  // the page — visible signal that the user is "carrying" something.
  useEffect(() => {
    if (armedItem) {
      document.body.setAttribute('data-armed-link', 'true')
    } else {
      document.body.removeAttribute('data-armed-link')
    }
  }, [armedItem])

  // Click outside the composer or a pinned-item row → disarm. Lets the
  // user "throw away" the loaded cursor by clicking anywhere uninvolved.
  // The pin itself stays in their library; only the carrying-state clears.
  // Composer = `[data-compose-area]` (Compose.tsx wrapper); pinned-item row
  // = `[data-pin-item-row]` (PinSidebar's per-row button). Anywhere else
  // is outside, and the click drops the arm.
  useEffect(() => {
    if (!armedItem) return
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-compose-area]')) return
      if (target.closest('[data-pin-item-row]')) return
      useComposeStore.getState().disarm()
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [armedItem])

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
