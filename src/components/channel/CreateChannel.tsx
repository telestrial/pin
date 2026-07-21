import { type ChangeEvent, useEffect, useState } from 'react'
import { buildSubscribeURL } from '../../core/channels'
import type { ChannelVisibility } from '../../core/types'
import { createAndPublishChannel } from '../../lib/channelWrites'
import { flushSettingsBestEffort } from '../../lib/hooks/useSettingsSync'
import { deriveDidDht } from '../../lib/pkarr'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { FormCard } from '../ui/FormCard'

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
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const addMyChannel = useAuthStore((s) => s.addMyChannel)
  const addSubscription = useAuthStore((s) => s.addSubscription)
  const setManifest = useFeedStore((s) => s.setManifest)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<ChannelVisibility>('public')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreviewURL, setAvatarPreviewURL] = useState<string | null>(null)
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverPreviewURL, setCoverPreviewURL] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(avatarFile)
    setAvatarPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [avatarFile])

  useEffect(() => {
    if (!coverFile) {
      setCoverPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(coverFile)
    setCoverPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [coverFile])

  function pickImage(
    e: ChangeEvent<HTMLInputElement>,
    set: (f: File | null) => void,
    kind: string,
  ) {
    const f = e.target.files?.[0] ?? null
    if (!f) {
      set(null)
      return
    }
    if (!ACCEPTED_COVER_MIMES.includes(f.type)) {
      setError(
        `Unsupported ${kind} type: ${f.type || 'unknown'}. Use JPEG, PNG, or WebP.`,
      )
      set(null)
      return
    }
    setError(null)
    set(f)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !storedKeyHex) return
    const trimmedName = name.trim()
    if (!trimmedName) return
    setSubmitting(true)
    setError(null)
    try {
      const toImage = async (f: File | null) =>
        f
          ? {
              bytes: new Uint8Array(await f.arrayBuffer()),
              mimeType: f.type,
            }
          : undefined
      // Derive our did:dht (from the AppKey — same identity the keeper /
      // identity-doc use) up front: it's stamped into the manifest as the
      // iroh-world author identity AND carried in the shareable capability link.
      const { did } = await deriveDidDht(Uint8Array.fromHex(storedKeyHex))
      const result = await createAndPublishChannel(sdk, {
        name: trimmedName,
        description: description.trim(),
        visibility,
        avatarImage: await toImage(avatarFile),
        coverImage: await toImage(coverFile),
        authorDidDht: did,
      })
      const subscribeURL = buildSubscribeURL(did, result.channelKey)
      addMyChannel({
        channelID: result.channelID,
        channelKey: result.channelKey,
        name: result.manifest.name,
        createdAt: result.manifest.publishedAt,
      })
      addSubscription({
        // did:dht is the identity now; the legacy atproto handle/DID fields
        // stay on the type but are empty for did:dht-native subscriptions.
        authorHandle: '',
        authorDID: '',
        didDht: did,
        channelID: result.channelID,
        channelKey: result.channelKey,
        cachedName: result.manifest.name,
        addedAt: new Date().toISOString(),
        label: result.manifest.name,
      })
      setManifest(result.channelID, result.manifest)
      // Persist the new channel + auto-subscription to Sia settings before
      // we hand off to the confirmation screen — otherwise a quick reload
      // before the background debounce loses it from the local list (the
      // atproto record survives, but the channel falls off "Your channels").
      await flushSettingsBestEffort()
      onCreated(subscribeURL, result.manifest.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create channel')
      setSubmitting(false)
    }
  }

  return (
    <FormCard sidebar={sidebar} rightSidebar={rightSidebar} onBack={onCancel}>
      <form onSubmit={handleSubmit} className="space-y-5">
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
              Avatar <span className="text-neutral-400">(optional)</span>
            </span>
            <div className="flex items-center gap-3">
              {avatarPreviewURL ? (
                <img
                  src={avatarPreviewURL}
                  alt="avatar preview"
                  className="size-16 rounded-full object-cover border border-neutral-200 shrink-0"
                />
              ) : (
                <div className="size-16 rounded-full bg-neutral-100 border border-neutral-200 shrink-0" />
              )}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => pickImage(e, setAvatarFile, 'avatar')}
                disabled={submitting}
                className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
              />
            </div>
          </label>

          <label className="block space-y-2">
            <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
              Cover banner <span className="text-neutral-400">(optional)</span>
            </span>
            {coverPreviewURL ? (
              <img
                src={coverPreviewURL}
                alt="cover banner preview"
                className="w-full h-24 rounded-lg object-cover border border-neutral-200"
              />
            ) : (
              <div className="w-full h-24 rounded-lg bg-neutral-100 border border-neutral-200" />
            )}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => pickImage(e, setCoverFile, 'cover')}
              disabled={submitting}
              className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
            />
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
              require giving readers a key; going obscure would orphan existing
              followers.)
            </p>
          </fieldset>
        </div>

        {error && (
          <p className="text-red-600 text-sm wrap-break-word">{error}</p>
        )}

        {submitting && (
          <p className="text-neutral-500 text-xs">
            {avatarFile || coverFile
              ? 'Uploading image(s) to Sia (~20 seconds each), encrypting manifest, writing to ATProto.'
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
