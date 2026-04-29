import { useState } from 'react'
import { createChannel } from '../core/channels'
import { useAuthStore } from '../stores/auth'

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export function CreateChannel({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (subscribeURL: string, name: string) => void
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const addMyChannel = useAuthStore((s) => s.addMyChannel)
  const addSubscription = useAuthStore((s) => s.addSubscription)

  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveHandle = handle.trim() || slugify(name)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk) return
    if (!agent || !agent.session) {
      setError('Bluesky/ATProto sign-in required to publish channels (coming soon).')
      return
    }
    const trimmedName = name.trim()
    if (!trimmedName || !effectiveHandle) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await createChannel(sdk, agent, {
        name: trimmedName,
        description: description.trim(),
        channelHandle: effectiveHandle,
      })
      addMyChannel({
        channelHandle: result.channelHandle,
        channelKey: result.channelKey,
        name: result.manifest.name,
        createdAt: result.manifest.publishedAt,
      })
      addSubscription({
        authorHandle: agent.session.handle,
        authorDID: agent.session.did,
        channelHandle: result.channelHandle,
        channelKey: result.channelKey,
        cachedName: result.manifest.name,
        addedAt: new Date().toISOString(),
        label: result.manifest.name,
      })
      onCreated(result.subscribeURL, result.manifest.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create channel')
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-md mx-auto space-y-5 p-6"
    >
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-900">
          Create a channel
        </h1>
        <p className="text-neutral-500 text-sm">
          A publishing handle. Could be a person, a topic, a project, a
          business — anything.
        </p>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            required
            placeholder="e.g. John Williams · Sia Notes · Cooking with John"
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Handle <span className="text-neutral-400">(optional — defaults to slug of name)</span>
          </span>
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            disabled={submitting}
            placeholder={slugify(name) || 'channel-handle'}
            pattern="[a-z0-9][a-z0-9-]*"
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Description <span className="text-neutral-400">(optional)</span>
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            rows={3}
            placeholder="Short description"
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
          />
        </label>
      </div>

      {error && (
        <p className="text-red-600 text-sm wrap-break-word">{error}</p>
      )}

      {submitting && (
        <p className="text-neutral-500 text-xs">
          Generating channel key, encrypting manifest, writing to ATProto.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting || !name.trim() || !effectiveHandle}
          className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {submitting ? 'Creating…' : 'Create channel'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
