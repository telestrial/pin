import { Pin } from 'lucide-react'
import { useMemo, useState } from 'react'
import { flushPendingSettingsSave } from '../lib/useSettingsSync'
import { APP_NAME } from '../lib/constants'
import { useAuthStore } from '../stores/auth'
import { CopyButton } from './CopyButton'

export function Navbar() {
  const step = useAuthStore((s) => s.step)
  const sdk = useAuthStore((s) => s.sdk)
  const reset = useAuthStore((s) => s.reset)
  const isConnected = step === 'connected'
  const [signingOut, setSigningOut] = useState(false)

  const publicKey = useMemo(() => {
    try {
      return sdk?.appKey().publicKey() ?? null
    } catch {
      return null
    }
  }, [sdk])

  async function handleSignOut() {
    setSigningOut(true)
    try {
      // Wait for any pending settings save so K's reach Sia before logout.
      await flushPendingSettingsSave()
    } catch (e) {
      console.warn('Pre-signout flush failed:', e)
    }
    reset()
    window.location.reload()
  }

  return (
    <header className="bg-white border-b border-neutral-200/80">
      <div className="flex items-center justify-between px-6 py-3 max-w-5xl mx-auto">
        <h1 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-900 tracking-tight">
          <Pin className="size-4 text-green-600" fill="currentColor" />
          {APP_NAME}
        </h1>
        {isConnected && publicKey && (
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-600" />
            </span>
            <span
              className="text-[11px] font-mono text-neutral-500"
              title={publicKey}
            >
              {publicKey.slice(0, 8)}...{publicKey.slice(-6)}
            </span>
            <CopyButton value={publicKey} label="Public key copied" />
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors ml-1 disabled:opacity-50 disabled:cursor-wait"
            >
              {signingOut ? 'Saving…' : 'Sign Out'}
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
