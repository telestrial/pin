import { useState } from 'react'
import { getOauthClient } from '../../lib/atprotoClient'
import { useAuthStore } from '../../stores/auth'

// AuthFlow variant of the Bluesky sign-in form. Same shape as
// BlueskyLoginScreen (the post-Sia lazy gate) but rendered inside AuthShell
// rather than FormCard, since at this point the app shell isn't connected
// yet. After signIn(), the page redirects out; on return, AuthFlow's init
// detects the new session and continues to Sia approval.
export function BlueskyOnboardingScreen({
  onCancel,
}: {
  onCancel: () => void
}) {
  const setError = useAuthStore((s) => s.setError)
  const setATProtoHandle = useAuthStore((s) => s.setATProtoHandle)
  const [handle, setHandle] = useState('')
  const [submitting, setSubmitting] = useState(false)

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
      // signIn() redirects the page out. Execution effectively ends here.
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
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">
          Sign in with Bluesky
        </h1>
        <p className="text-neutral-600 text-sm leading-relaxed">
          Pin publishes channel records to your ATProto repo. Sign in
          through Bluesky — we'll redirect you to your PDS, you log in
          there, and you come back authorized. Pin never sees your
          password.
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

      <div className="space-y-2">
        <button
          type="submit"
          disabled={submitting || !handle.trim()}
          className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-medium rounded-lg transition-colors"
        >
          {submitting ? 'Redirecting…' : 'Continue with Bluesky'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="w-full py-2 text-neutral-500 hover:text-neutral-900 text-sm transition-colors"
        >
          Back
        </button>
      </div>
    </form>
  )
}
