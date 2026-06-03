import { type ChangeEvent, useEffect, useState } from 'react'
import { createChannel } from '../core/channels'
import type { ChannelVisibility } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { FormCard } from './FormCard'

const ACCEPTED_COVER_MIMES = ['image/jpeg', 'image/png', 'image/webp']

export function CreateChannel({
  onCancel,
  onCreated,
  sidebar,
  rightSidebar,
}: {
  onCancel: () => void
  onCreated: (subscribeURL: string, name: string) => void
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const atprotoDID = useAuthStore((s) => s.atprotoDID)
  const atprotoHandle = useAuthStore((s) => s.atprotoHandle)
  const addMyChannel = useAuthStore((s) => s.addMyChannel)
  const addSubscription = useAuthStore((s) => s.addSubscription)
  const setManifest = useFeedStore((s) => s.setManifest)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<ChannelVisibility>('public')
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverPreviewURL, setCoverPreviewURL] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!coverFile) {
      setCoverPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(coverFile)
    setCoverPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [coverFile])

  function handleCoverChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    if (!f) {
      setCoverFile(null)
      return
    }
    if (!ACCEPTED_COVER_MIMES.includes(f.type)) {
      setError(
        `Unsupported cover type: ${f.type || 'unknown'}. Use JPEG, PNG, or WebP.`,
      )
      setCoverFile(null)
      return
    }
    setError(null)
    setCoverFile(f)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk) return
    if (!agent || !atprotoDID || !atprotoHandle) {
      setError('Bluesky session not active. Cancel and try again to sign in.')
      return
    }
    const trimmedName = name.trim()
    if (!trimmedName) return
    setSubmitting(true)
    setError(null)
    try {
      let coverImage: { bytes: Uint8Array; mimeType: string } | undefined
      if (coverFile) {
        const buf = await coverFile.arrayBuffer()
        coverImage = {
          bytes: new Uint8Array(buf),
          mimeType: coverFile.type,
        }
      }
      const result = await createChannel(sdk, agent, atprotoHandle, {
        name: trimmedName,
        description: description.trim(),
        visibility,
        coverImage,
      })
      addMyChannel({
        channelID: result.channelID,
        channelKey: result.channelKey,
        name: result.manifest.name,
        createdAt: result.manifest.publishedAt,
      })
      addSubscription({
        authorHandle: atprotoHandle,
        authorDID: atprotoDID,
        channelID: result.channelID,
        channelKey: result.channelKey,
        cachedName: result.manifest.name,
        addedAt: new Date().toISOString(),
        label: result.manifest.name,
      })
      setManifest(result.channelID, result.manifest)
      onCreated(result.subscribeURL, result.manifest.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create channel')
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
          Create a channel
        </h1>
        <p className="text-neutral-500 text-sm">
          A publishing handle. Could be a person, a topic, a project, a business
          — anything.
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

        <label className="block space-y-2">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Cover image <span className="text-neutral-400">(optional)</span>
          </span>
          <div className="flex items-center gap-3">
            {coverPreviewURL ? (
              <img
                src={coverPreviewURL}
                alt="cover preview"
                className="size-16 rounded-full object-cover border border-neutral-200 shrink-0"
              />
            ) : (
              <div className="size-16 rounded-full bg-neutral-100 border border-neutral-200 shrink-0" />
            )}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleCoverChange}
              disabled={submitting}
              className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
            />
          </div>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Visibility
          </legend>
          <VisibilityChoice
            value="public"
            label="Public"
            description="Anyone who knows the handle can find and follow this channel. The encryption key is published in the channel record."
            current={visibility}
            disabled={submitting}
            onChange={setVisibility}
          />
          <VisibilityChoice
            value="obscure"
            label="Obscure"
            description="Only people you send the subscribe URL to can read it. The channel record exists publicly as ciphertext but nothing links it to your other channels."
            current={visibility}
            disabled={submitting}
            onChange={setVisibility}
          />
          <p className="text-xs text-neutral-400 pt-1">
            Set at creation — can't be changed later. (Going public would
            require giving readers a key; going obscure would orphan
            existing followers.)
          </p>
        </fieldset>
      </div>

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      {submitting && (
        <p className="text-neutral-500 text-xs">
          {coverFile
            ? 'Uploading cover to Sia (~20 seconds), encrypting manifest, writing to ATProto.'
            : 'Generating channel key, encrypting manifest, writing to ATProto.'}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !name.trim()}
        className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {submitting ? 'Creating…' : 'Create channel'}
      </button>
      </form>
    </FormCard>
  )
}

function VisibilityChoice({
  value,
  label,
  description,
  current,
  disabled,
  onChange,
}: {
  value: ChannelVisibility
  label: string
  description: string
  current: ChannelVisibility
  disabled: boolean
  onChange: (v: ChannelVisibility) => void
}) {
  const selected = current === value
  return (
    <label
      className={`flex gap-3 items-start p-3 border rounded-lg cursor-pointer transition-colors ${
        selected
          ? 'border-green-600 bg-green-50/40'
          : 'border-neutral-200 hover:border-neutral-300'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <input
        type="radio"
        name="visibility"
        value={value}
        checked={selected}
        onChange={() => onChange(value)}
        disabled={disabled}
        className="mt-0.5 accent-green-600"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-sm font-medium text-neutral-900">{label}</div>
        <div className="text-xs text-neutral-600">{description}</div>
      </div>
    </label>
  )
}
