import { useMemo, useState } from 'react'
import { fullReset } from '../lib/fullReset'
import { type ThemeMode, useAuthStore } from '../stores/auth'
import { CopyButton } from './ui/CopyButton'

// Settings page (rendered inside a FormCard by Home). The author public key
// and the danger-zone full reset.
export function SettingsView() {
  const sdk = useAuthStore((s) => s.sdk)
  const theme = useAuthStore((s) => s.theme)
  const setTheme = useAuthStore((s) => s.setTheme)
  const [resetting, setResetting] = useState(false)

  const publicKey = useMemo(() => {
    try {
      return sdk?.appKey().publicKey() ?? null
    } catch {
      return null
    }
  }, [sdk])

  const handleFullReset = async () => {
    const confirmation = window.prompt(
      'FULL RESET permanently deletes everything — every channel, post, file, ' +
        'subscription, profile, and setting, both on Sia and on your atproto ' +
        'repo — and signs you out. This cannot be undone.\n\nType RESET to confirm.',
    )
    if (confirmation !== 'RESET') return
    setResetting(true)
    const { sdk, atprotoAgent, atprotoDID } = useAuthStore.getState()
    // fullReset reloads the page on completion — nothing after this runs.
    await fullReset({ sdk, agent: atprotoAgent, atprotoDID })
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-900">Settings</h1>

      <section className="border border-neutral-200 rounded-lg p-4 space-y-2">
        <h2 className="text-sm font-semibold text-neutral-900">Theme</h2>
        <p className="text-xs text-neutral-500 leading-relaxed">
          The overall look. Rounded uses gentle corners throughout; Corners
          squares everything off. On the desktop app, Rounded also rounds the
          window itself.
        </p>
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemeMode)}
          className="w-full sm:w-56 border border-neutral-200 rounded-md bg-white px-3 py-2 text-sm text-neutral-900 cursor-pointer"
        >
          <option value="rounded">Rounded</option>
          <option value="corners">Corners</option>
        </select>
      </section>

      {publicKey && (
        <section className="border border-neutral-200 rounded-lg p-4 space-y-2">
          <h2 className="text-sm font-semibold text-neutral-900">
            Your public key
          </h2>
          <p className="text-xs text-neutral-500 leading-relaxed">
            The ed25519 key your channels are authored under — the technical
            author identity recorded in every channel manifest.
          </p>
          <div className="flex items-start gap-2">
            <code className="text-xs font-mono text-neutral-700 break-all flex-1">
              {publicKey}
            </code>
            <CopyButton value={publicKey} label="Public key copied" />
          </div>
        </section>
      )}

      <section className="border border-red-200 bg-red-50 rounded-lg p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-red-900">Danger zone</h2>
          <p className="text-xs text-red-700 mt-1 leading-relaxed">
            Full reset wipes every channel, post, file, subscription, profile,
            and setting — on Sia and on your atproto repo — then signs you out
            and returns you to the welcome screen. There is no undo.
          </p>
        </div>
        <button
          type="button"
          onClick={handleFullReset}
          disabled={resetting}
          className="px-3 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-md transition-colors cursor-pointer"
        >
          {resetting ? 'Resetting…' : 'Full reset'}
        </button>
      </section>
    </div>
  )
}
