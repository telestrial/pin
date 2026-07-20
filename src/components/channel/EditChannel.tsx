import { type ChangeEvent, useEffect, useState } from 'react'
import type { EditChannelPatch } from '../../core/channels'
import type { ChannelImage, ChannelManifest } from '../../core/types'
import { makeLocatorReader } from '../../lib/channelLocator'
import { saveChannelEdits } from '../../lib/channelWrites'
import { useItemBlobURL } from '../../lib/hooks/useItemBytes'
import { useActionStore } from '../../stores/actionQueue'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { FormCard } from '../ui/FormCard'

const ACCEPTED_COVER_MIMES = ['image/jpeg', 'image/png', 'image/webp']

export function EditChannel({
  channelID,
  channelKey,
  onCancel,
  onSaved,
  sidebar,
  rightSidebar,
}: {
  channelID: string
  channelKey: string
  onCancel: () => void
  onSaved: (name: string) => void
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const atprotoDID = useAuthStore((s) => s.atprotoDID)
  const updateMyChannelName = useAuthStore((s) => s.updateMyChannelName)
  const updateSubscriptionName = useAuthStore((s) => s.updateSubscriptionName)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [original, setOriginal] = useState<ChannelManifest | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [newAvatarFile, setNewAvatarFile] = useState<File | null>(null)
  const [avatarPreviewURL, setAvatarPreviewURL] = useState<string | null>(null)
  const [removeAvatar, setRemoveAvatar] = useState(false)
  const [newCoverFile, setNewCoverFile] = useState<File | null>(null)
  const [coverPreviewURL, setCoverPreviewURL] = useState<string | null>(null)
  const [removeCover, setRemoveCover] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!sdk) {
      setLoadError('Not connected to Sia.')
      setLoading(false)
      return
    }
    // Prefer the local cache; else read the channel via its locator.
    const cached = useFeedStore.getState().manifests[channelID]
    const load = cached
      ? Promise.resolve(cached)
      : makeLocatorReader(sdk)(atprotoDID ?? '', channelID, channelKey)
    load
      .then((manifest) => {
        if (cancelled) return
        setOriginal(manifest)
        setName(manifest.name)
        setDescription(manifest.description)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : 'Failed to load channel')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sdk, atprotoDID, channelID, channelKey])

  useEffect(() => {
    if (!newAvatarFile) {
      setAvatarPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(newAvatarFile)
    setAvatarPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [newAvatarFile])

  useEffect(() => {
    if (!newCoverFile) {
      setCoverPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(newCoverFile)
    setCoverPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [newCoverFile])

  function pickImage(
    e: ChangeEvent<HTMLInputElement>,
    setFile: (f: File | null) => void,
    clearRemove: () => void,
    kind: string,
  ) {
    const f = e.target.files?.[0] ?? null
    if (!f) {
      setFile(null)
      return
    }
    if (!ACCEPTED_COVER_MIMES.includes(f.type)) {
      setError(
        `Unsupported ${kind} type: ${f.type || 'unknown'}. Use JPEG, PNG, or WebP.`,
      )
      setFile(null)
      return
    }
    setError(null)
    clearRemove()
    setFile(f)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !original) return
    const trimmedName = name.trim()
    if (!trimmedName) return
    setSubmitting(true)
    setError(null)
    try {
      const toImage = async (f: File) => ({
        bytes: new Uint8Array(await f.arrayBuffer()),
        mimeType: f.type,
      })
      const patch: EditChannelPatch = {}
      if (trimmedName !== original.name) patch.name = trimmedName
      const trimmedDesc = description.trim()
      if (trimmedDesc !== original.description) patch.description = trimmedDesc
      if (newAvatarFile) patch.avatarImage = await toImage(newAvatarFile)
      else if (removeAvatar) patch.removeAvatar = true
      if (newCoverFile) patch.coverImage = await toImage(newCoverFile)
      else if (removeCover) patch.removeCover = true

      const { manifest: updated, reclaimURLs } = await saveChannelEdits(
        sdk,
        { channelID, channelKey },
        patch,
      )
      // Reclaim the old avatar/cover bytes via the journal (durable, retried).
      useActionStore.getState().enqueueDeleteObjects({
        urls: reclaimURLs,
        label: 'Reclaiming old channel image',
      })
      if (patch.name) {
        updateMyChannelName(channelID, updated.name)
        updateSubscriptionName(channelID, updated.name)
      }
      onSaved(updated.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save changes')
      setSubmitting(false)
    }
  }

  const card = (content: React.ReactNode) => (
    <FormCard sidebar={sidebar} rightSidebar={rightSidebar} onBack={onCancel}>
      {content}
    </FormCard>
  )

  if (loading) {
    return card(<p className="text-neutral-500 text-sm">Loading channel…</p>)
  }

  if (loadError || !original) {
    return card(
      <p className="text-red-600 text-sm wrap-break-word">
        {loadError || 'Channel not found'}
      </p>,
    )
  }

  return card(
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-900">Edit channel</h1>
        <p className="text-neutral-500 text-sm">
          Subscribers see updates within a second of saving.
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
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
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
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
          />
        </label>

        <div className="space-y-2">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Avatar <span className="text-neutral-400">(optional)</span>
          </span>
          <ImagePicker
            shape="round"
            existing={original.avatar}
            newPreviewURL={avatarPreviewURL}
            removed={removeAvatar}
            onPick={(e) =>
              pickImage(
                e,
                setNewAvatarFile,
                () => setRemoveAvatar(false),
                'avatar',
              )
            }
            onRemove={() => {
              setNewAvatarFile(null)
              setRemoveAvatar(true)
            }}
            submitting={submitting}
          />
        </div>

        <div className="space-y-2">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Cover banner <span className="text-neutral-400">(optional)</span>
          </span>
          <ImagePicker
            shape="banner"
            existing={original.cover}
            newPreviewURL={coverPreviewURL}
            removed={removeCover}
            onPick={(e) =>
              pickImage(
                e,
                setNewCoverFile,
                () => setRemoveCover(false),
                'cover',
              )
            }
            onRemove={() => {
              setNewCoverFile(null)
              setRemoveCover(true)
            }}
            submitting={submitting}
          />
        </div>
      </div>

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      {submitting && (
        <p className="text-neutral-500 text-xs">
          {newAvatarFile || newCoverFile
            ? 'Uploading image(s) to Sia (~20 seconds each), encrypting manifest, writing to ATProto.'
            : 'Encrypting manifest, writing to ATProto.'}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !name.trim()}
        className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
      >
        {submitting ? 'Saving…' : 'Save changes'}
      </button>
    </form>,
  )
}

function ImagePicker({
  shape,
  existing,
  newPreviewURL,
  removed,
  onPick,
  onRemove,
  submitting,
}: {
  shape: 'round' | 'banner'
  existing?: ChannelImage
  newPreviewURL: string | null
  removed: boolean
  onPick: (e: ChangeEvent<HTMLInputElement>) => void
  onRemove: () => void
  submitting: boolean
}) {
  const showExisting = !!existing && !removed && !newPreviewURL
  const showRemoveButton = !!existing && !removed
  const noun = shape === 'banner' ? 'cover' : 'avatar'

  const preview = (
    <ImagePreview
      shape={shape}
      existing={showExisting ? existing : undefined}
      newPreviewURL={newPreviewURL}
    />
  )
  const controls = (
    <div className="flex-1 space-y-1">
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={onPick}
        disabled={submitting}
        className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
      />
      {showRemoveButton && (
        <button
          type="button"
          onClick={onRemove}
          disabled={submitting}
          className="text-xs text-neutral-500 hover:text-red-600 transition-colors cursor-pointer"
        >
          Remove {noun}
        </button>
      )}
      {removed && (
        <p className="text-xs text-neutral-500">
          {shape === 'banner' ? 'Cover' : 'Avatar'} will be removed on save.
        </p>
      )}
    </div>
  )

  if (shape === 'banner') {
    return (
      <div className="space-y-2">
        {preview}
        {controls}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3">
      {preview}
      {controls}
    </div>
  )
}

function ImagePreview({
  shape,
  existing,
  newPreviewURL,
}: {
  shape: 'round' | 'banner'
  existing?: ChannelImage
  newPreviewURL: string | null
}) {
  const imgCls =
    shape === 'banner'
      ? 'w-full h-24 rounded-lg object-cover border border-neutral-200'
      : 'size-16 rounded-full object-cover border border-neutral-200 shrink-0'
  const emptyCls =
    shape === 'banner'
      ? 'w-full h-24 rounded-lg bg-neutral-100 border border-neutral-200'
      : 'size-16 rounded-full bg-neutral-100 border border-neutral-200 shrink-0'

  if (newPreviewURL) {
    return <img src={newPreviewURL} alt="preview" className={imgCls} />
  }
  if (existing) {
    return (
      <ExistingImage image={existing} imgCls={imgCls} emptyCls={emptyCls} />
    )
  }
  return <div className={emptyCls} />
}

function ExistingImage({
  image,
  imgCls,
  emptyCls,
}: {
  image: ChannelImage
  imgCls: string
  emptyCls: string
}) {
  const { url } = useItemBlobURL(
    image.itemURL,
    image.mimeType,
    image.contentHash,
  )
  if (!url) {
    return <div className={`${emptyCls} animate-pulse`} />
  }
  return <img src={url} alt="current" className={imgCls} />
}
