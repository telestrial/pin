import { useState } from 'react'
import { signIn } from '../core/atproto'
import { persistAtprotoSession } from '../lib/atprotoSession'
import { useAuthStore } from '../stores/auth'
import { FormCard } from './FormCard'

export function BlueskyLoginScreen({
  onCancel,
  onSignedIn,
  sidebar,
  rightSidebar,
}: {
  onCancel: () => void
  onSignedIn: () => void
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
}) {
  const setATProtoSession = useAuthStore((s) => s.setATProtoSession)

  const [handle, setHandle] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmedHandle = handle.trim().replace(/^@/, '')
    const trimmedPassword = password.trim()
    if (!trimmedHandle || !trimmedPassword) return
    setSubmitting(true)
    setError(null)
    try {
      const { session, agent } = await signIn(
        trimmedHandle,
        trimmedPassword,
        persistAtprotoSession,
      )
      setATProtoSession(session, agent)
      onSignedIn()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Sign-in failed. Check your handle and app password.',
      )
      setSubmitting(false)
    }
  }

  return (
    <FormCard
      sidebar={sidebar}
      rightSidebar={rightSidebar}
      onBack={onCancel}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-900">
          Sign in to Bluesky
        </h1>
        <p className="text-neutral-500 text-sm">
          Pin publishes channel records to your ATProto repo via Bluesky.
          Use an{' '}
          <a
            href="https://bsky.app/settings/app-passwords"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-neutral-900"
          >
            app password
          </a>{' '}
          — not your account password. Generate one in Bluesky Settings →
          Privacy and Security → App Passwords.
        </p>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Handle
          </span>
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            disabled={submitting}
            required
            autoComplete="username"
            placeholder="yourname.bsky.social"
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            App password
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            required
            autoComplete="current-password"
            placeholder="xxxx-xxxx-xxxx-xxxx"
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500 font-mono"
          />
        </label>
      </div>

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      <button
        type="submit"
        disabled={submitting || !handle.trim() || !password.trim()}
        className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
      </form>
    </FormCard>
  )
}
