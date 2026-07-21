import { useState } from 'react'
import { normalizeUsername } from '../../core/profile'
import { useAuthStore } from '../../stores/auth'
import { AuthShell } from './AuthShell'

// Genesis naming beat — the post-connect first-run gate (App renders it when
// connected + settingsLoaded + no profile username). Every new did:dht identity
// lands named. Writes the profile locally; useSettingsDocsMirror persists it to
// Sia and useIdentityDocPublish publishes it into the identity-doc, so as soon
// as `username` is set the gate closes and Home takes over.
export function NamingScreen() {
  const setProfile = useAuthStore((s) => s.setProfile)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')

  const normalized = normalizeUsername(username)
  const canContinue = normalized.length > 0

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canContinue) return
    setProfile({
      username: normalized,
      displayName: displayName.trim() || undefined,
    })
  }

  return (
    <AuthShell ready>
      <form onSubmit={handleSubmit} className="space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">
            Name yourself
          </h1>
          <p className="text-neutral-600 text-[15px] leading-relaxed">
            Pick the name people see when they find you. It doesn't have to be
            unique, and you can change it anytime.
          </p>
        </div>

        <div className="space-y-3 text-left">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
              Handle
            </span>
            <div className="flex items-center gap-1.5 px-3 py-2 bg-white border border-neutral-300 rounded-lg focus-within:border-green-600">
              <span className="text-sm text-neutral-400 select-none">@</span>
              <input
                type="text"
                value={username}
                onChange={(e) =>
                  setUsername(
                    e.target.value.replace(/^@+/, '').replace(/\s+/g, ''),
                  )
                }
                placeholder="yourname"
                // biome-ignore lint/a11y/noAutofocus: genesis screen, single primary field
                autoFocus
                className="flex-1 min-w-0 bg-transparent text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none"
              />
            </div>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
              Display name <span className="text-neutral-400">(optional)</span>
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={!canContinue}
          className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-medium rounded-lg transition-colors"
        >
          Continue
        </button>
      </form>
    </AuthShell>
  )
}
