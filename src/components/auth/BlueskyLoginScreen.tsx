import { useState } from 'react'
import { getOauthClient } from '../../lib/atprotoClient'
import { useAuthStore } from '../../stores/auth'
import { FormCard } from '../ui/FormCard'

export function BlueskyLoginScreen({
  onCancel,
  sidebar,
  rightSidebar,
}: {
  // Note: there is no onSignedIn callback. signIn() redirects the page to
  // bsky.social; on return, App.tsx's init() effect picks up the session and
  // hydrates the store. The post-redirect view depends on the URL the user
  // lands at, which is the same page they started from.
  onCancel: () => void
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
}) {
  const setATProtoHandle = useAuthStore((s) => s.setATProtoHandle)
  const [handle, setHandle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = handle.trim().replace(/^@/, '')
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      const client = await getOauthClient()
      // Persist the user-typed handle before the OAuth redirect. Under our
      // narrow scope, getProfile 403s on the callback so doBoot can't
      // resolve a handle — without this seed, atprotoHandle would stay null
      // through the user's first session and CreateChannel would reject.
      setATProtoHandle(trimmed)
      // signIn() redirects the page to the user's PDS. Execution effectively
      // ends here for this load — the browser navigates away. After
      // authorization, the user comes back to the redirect_uri and the boot
      // effect picks up the session.
      await client.signIn(trimmed)
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't start sign-in. Check your handle.",
      )
      setSubmitting(false)
    }
  }

  return (
    <FormCard sidebar={sidebar} rightSidebar={rightSidebar} onBack={onCancel}>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-neutral-900">
            Sign in with Bluesky
          </h1>
          <p className="text-neutral-500 text-sm">
            Pin publishes channel records to your ATProto repo. Sign in through
            Bluesky — we'll redirect you to your PDS, you log in there, and you
            come back authorized. Pin never sees your password.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Your handle
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

        {error && (
          <p className="text-red-600 text-sm wrap-break-word">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting || !handle.trim()}
          className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {submitting ? 'Redirecting…' : 'Continue with Bluesky'}
        </button>
      </form>
    </FormCard>
  )
}
