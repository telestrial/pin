import { useCallback, useEffect, useState } from 'react'
import { AuthFlow } from './components/auth/AuthFlow'
import { NamingScreen } from './components/auth/NamingScreen'
import { Home } from './components/Home'
import { LockScreen } from './components/LockScreen'
import { Navbar } from './components/Navbar'
import { Toasts } from './components/ui/Toast'
import { bootOauth } from './lib/atprotoClient'
import { inTauri } from './lib/openExternal'
import { deriveDidDht } from './lib/pkarr'
import './lib/debug'
import {
  useActionQueueHydration,
  useActionRunner,
} from './lib/hooks/useActionRunner'
import { useChannelDocsMirror } from './lib/hooks/useChannelDocsMirror'
import { useChannelLocatorPublish } from './lib/hooks/useChannelLocatorPublish'
import { useChannelReader } from './lib/hooks/useChannelReader'
import { useHandleFollowReconciliation } from './lib/hooks/useHandleFollowReconciliation'
import { useIdentityDocPublish } from './lib/hooks/useIdentityDocPublish'
import { useRepackRunner } from './lib/hooks/useRepackRunner'
import { useSettingsDocsMirror } from './lib/hooks/useSettingsDocsMirror'
import { useSettingsSync } from './lib/hooks/useSettingsSync'
import { useAuthStore } from './stores/auth'
import { useComposeStore } from './stores/compose'
import { usePinStore } from './stores/pin'

// Surface fade duration on lock/unlock — matches the overlay's CSS transition.
const FADE_MS = 300

export default function App() {
  const step = useAuthStore((s) => s.step)
  const sdk = useAuthStore((s) => s.sdk)
  const locked = useAuthStore((s) => s.locked)
  const settingsLoaded = useAuthStore((s) => s.settingsLoaded)
  const hasUsername = useAuthStore((s) => !!s.profile?.username)
  const theme = useAuthStore((s) => s.theme)
  const armedItem = useComposeStore((s) => s.armedItem)
  const [fading, setFading] = useState(false)

  // Lock/unlock both fade the whole surface to white, swap underneath, then
  // fade back in — so Home↔LockScreen reads as one transition rather than a
  // hard cut. The session stays live across a lock (see auth.locked), so the
  // swap is the only work; no teardown, no reconnect.
  const lock = useCallback(() => {
    setFading(true)
    setTimeout(() => {
      useAuthStore.getState().setLocked(true)
      setFading(false)
    }, FADE_MS)
  }, [])

  const unlock = useCallback(() => {
    setFading(true)
    setTimeout(() => {
      useAuthStore.getState().setLocked(false)
      setFading(false)
    }, FADE_MS)
  }, [])

  // Theme is a named style bundle applied globally via a data attribute on
  // <html>; CSS keys off [data-theme]. data-shell tags the runtime (desktop
  // vs web) so desktop-only styling — like the rounded window on the 'rounded'
  // theme — can gate on it. inTauri() is a static check, so shell is set once.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset.shell = inTauri() ? 'desktop' : 'web'
  }, [])

  useActionQueueHydration()
  useActionRunner()
  useRepackRunner()
  useSettingsSync()
  useSettingsDocsMirror()
  useChannelDocsMirror()
  useChannelReader()
  useChannelLocatorPublish()
  useIdentityDocPublish()
  useHandleFollowReconciliation()

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

  // Derive this identity's own did:dht from the AppKey once connected — the
  // self-sovereign "who am I" used for isSelf + profile navigation. Deterministic
  // (HKDF over the AppKey), so re-deriving on every connect keeps it correct
  // even if the persisted value is from an older key.
  useEffect(() => {
    const storedKeyHex = useAuthStore.getState().storedKeyHex
    if (!sdk || !storedKeyHex) return
    let cancelled = false
    deriveDidDht(Uint8Array.fromHex(storedKeyHex))
      .then(({ did }) => {
        if (!cancelled) useAuthStore.getState().setMyDidDht(did)
      })
      .catch((e) => console.warn('Failed to derive did:dht identity:', e))
    return () => {
      cancelled = true
    }
  }, [sdk])

  const connected = step === 'connected'
  // Genesis naming gate: a connected identity with no chosen @name yet lands on
  // the naming beat before Home. settingsLoaded first so we don't flash it while
  // the profile is still hydrating from the Sia snapshot.
  const needsNaming = connected && settingsLoaded && !hasUsername

  return (
    <div
      id="app-shell"
      className="min-h-screen lg:h-screen flex flex-col lg:overflow-hidden"
    >
      {connected && !locked && !needsNaming && <Navbar onLock={lock} />}
      {/* Desktop (lg+): the app is locked to the viewport — the navbar is a
          fixed-height flex child and this region fills the rest without
          scrolling itself (lg:overflow-hidden). Each column inside then
          scrolls internally, so there's no page-level scrollbar. Mobile
          (<lg): the columns stack and the document scrolls normally. */}
      <div className="flex-1 flex flex-col lg:min-h-0 lg:overflow-hidden">
        {connected ? (
          locked ? (
            <LockScreen onContinue={unlock} />
          ) : needsNaming ? (
            <NamingScreen />
          ) : (
            <Home />
          )
        ) : (
          <AuthFlow />
        )}
      </div>
      <Toasts />
      {/* Fade-to-white overlay for the lock/unlock transition. Inert except
          during the brief fade, when it also blocks stray clicks. */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-100 bg-white transition-opacity duration-300"
        style={{
          opacity: fading ? 1 : 0,
          pointerEvents: fading ? 'auto' : 'none',
        }}
      />
    </div>
  )
}
