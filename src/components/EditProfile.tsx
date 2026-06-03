import { useEffect, useState } from 'react'
import {
  getProfileRecord,
  type ProfilePatch,
  type ProfileRecord,
  putProfileRecord,
} from '../core/profile'
import { useAuthStore } from '../stores/auth'
import { FormCard } from './FormCard'

export function EditProfile({
  onCancel,
  onSaved,
  sidebar,
  rightSidebar,
}: {
  onCancel: () => void
  onSaved: () => void
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
}) {
  const agent = useAuthStore((s) => s.atprotoAgent)
  const did = useAuthStore((s) => s.atprotoDID)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [original, setOriginal] = useState<ProfileRecord | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!did) {
      setLoadError('Bluesky session not active.')
      setLoading(false)
      return
    }
    // First-time editors don't have a profile record yet; null is a valid
    // starting state (form just opens with empty fields).
    getProfileRecord(did)
      .then((profile) => {
        if (cancelled) return
        setOriginal(profile)
        setDisplayName(profile?.displayName ?? '')
        setBio(profile?.bio ?? '')
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : 'Failed to load profile')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [did])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!agent) return
    setSubmitting(true)
    setError(null)
    try {
      const patch: ProfilePatch = {
        displayName: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
      }
      // putProfileRecord's read-current-then-patch path interprets
      // undefined as "keep what's there." For displayName/bio that the
      // user has explicitly cleared, fall through to the existing value
      // — explicit removal of these fields isn't a v1 affordance.
      await putProfileRecord(agent, patch)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save profile')
      setSubmitting(false)
    }
  }

  const card = (content: React.ReactNode) => (
    <FormCard sidebar={sidebar} rightSidebar={rightSidebar} onBack={onCancel}>
      {content}
    </FormCard>
  )

  if (loading) {
    return card(<p className="text-neutral-500 text-sm">Loading profile…</p>)
  }

  if (loadError) {
    return card(
      <p className="text-red-600 text-sm wrap-break-word">{loadError}</p>,
    )
  }

  return card(
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-900">
          {original ? 'Edit profile' : 'Set up your profile'}
        </h1>
        <p className="text-neutral-500 text-sm">
          Identity is your atproto handle. This is what people see when
          they click your @handle anywhere in the app.
        </p>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Display name <span className="text-neutral-400">(optional)</span>
          </span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={submitting}
            placeholder="Your name"
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Bio <span className="text-neutral-400">(optional)</span>
          </span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            disabled={submitting}
            rows={4}
            placeholder="A line or two about who you are."
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
          />
        </label>
      </div>

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
      >
        {submitting ? 'Saving…' : original ? 'Save changes' : 'Create profile'}
      </button>
    </form>,
  )
}
