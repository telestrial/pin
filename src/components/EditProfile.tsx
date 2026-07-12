import { type ChangeEvent, useEffect, useState } from 'react'
import {
  getProfileRecord,
  normalizeUsername,
  type ProfilePatch,
  type ProfileRecord,
  putProfileRecord,
} from '../core/profile'
import { uploadItem } from '../core/sia'
import { useItemBlobURL } from '../lib/hooks/useItemBytes'
import { useActionStore } from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import { FormCard } from './ui/FormCard'

const ACCEPTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp']

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
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const did = useAuthStore((s) => s.atprotoDID)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [original, setOriginal] = useState<ProfileRecord | null>(null)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [newAvatarFile, setNewAvatarFile] = useState<File | null>(null)
  const [newAvatarPreviewURL, setNewAvatarPreviewURL] = useState<string | null>(
    null,
  )
  const [removeExistingAvatar, setRemoveExistingAvatar] = useState(false)

  const [newCoverFile, setNewCoverFile] = useState<File | null>(null)
  const [newCoverPreviewURL, setNewCoverPreviewURL] = useState<string | null>(
    null,
  )
  const [removeExistingCover, setRemoveExistingCover] = useState(false)

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
        setUsername(profile?.username ?? '')
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

  // Local preview blob URLs for newly-picked files; cleaned up on
  // unmount or when the file is cleared.
  useEffect(() => {
    if (!newAvatarFile) {
      setNewAvatarPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(newAvatarFile)
    setNewAvatarPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [newAvatarFile])

  useEffect(() => {
    if (!newCoverFile) {
      setNewCoverPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(newCoverFile)
    setNewCoverPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [newCoverFile])

  function handleAvatarChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    if (!f) {
      setNewAvatarFile(null)
      return
    }
    if (!ACCEPTED_IMAGE_MIMES.includes(f.type)) {
      setError(
        `Unsupported avatar type: ${f.type || 'unknown'}. Use JPEG, PNG, or WebP.`,
      )
      setNewAvatarFile(null)
      return
    }
    setError(null)
    setRemoveExistingAvatar(false)
    setNewAvatarFile(f)
  }

  function handleRemoveAvatar() {
    setNewAvatarFile(null)
    setRemoveExistingAvatar(true)
  }

  function handleCoverChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    if (!f) {
      setNewCoverFile(null)
      return
    }
    if (!ACCEPTED_IMAGE_MIMES.includes(f.type)) {
      setError(
        `Unsupported cover type: ${f.type || 'unknown'}. Use JPEG, PNG, or WebP.`,
      )
      setNewCoverFile(null)
      return
    }
    setError(null)
    setRemoveExistingCover(false)
    setNewCoverFile(f)
  }

  function handleRemoveCover() {
    setNewCoverFile(null)
    setRemoveExistingCover(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!agent) {
      setError('Bluesky session not active. Cancel and try again to sign in.')
      return
    }
    if (!sdk) {
      setError('Sia session not active. Reload and reconnect.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const patch: ProfilePatch = {
        username: normalizeUsername(username) || undefined,
        displayName: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
      }

      // Upload new image bytes (if any) before writing the record so the
      // URL we record is real. Each upload is its own Sia object —
      // sub-slab cost today; future repack scope expansion can consolidate.
      if (newAvatarFile) {
        const buf = await newAvatarFile.arrayBuffer()
        const uploaded = await uploadItem(sdk, new Uint8Array(buf))
        patch.avatarURL = uploaded.itemURL
      } else if (removeExistingAvatar) {
        patch.removeAvatar = true
      }

      if (newCoverFile) {
        const buf = await newCoverFile.arrayBuffer()
        const uploaded = await uploadItem(sdk, new Uint8Array(buf))
        patch.coverURL = uploaded.itemURL
      } else if (removeExistingCover) {
        patch.removeCover = true
      }

      // putProfileRecord's read-current-then-patch path interprets
      // undefined as "keep what's there." Explicit clearing for
      // displayName/bio isn't a v1 affordance (vs. avatar/cover, which
      // are explicit via removeAvatar / removeCover flags).
      await putProfileRecord(agent, patch)

      // Reclaim old avatar/cover bytes a replace/remove orphaned — durable,
      // retried byte-cleanup via the journal. Per-object Sia encryption makes
      // each image's objectID unique, so this is reference-safe. (Closes the
      // image-swap leak; previously these bytes just accumulated.)
      const reclaimURLs: string[] = []
      if ((newAvatarFile || removeExistingAvatar) && original?.avatarURL)
        reclaimURLs.push(original.avatarURL)
      if ((newCoverFile || removeExistingCover) && original?.coverURL)
        reclaimURLs.push(original.coverURL)
      useActionStore.getState().enqueueDeleteObjects({
        urls: reclaimURLs,
        label: 'Reclaiming old profile image',
      })

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
          Pick the name that represents you. This is what people see when they
          click your @handle anywhere in the app. Your atproto handle stays your
          permanent address underneath.
        </p>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Handle <span className="text-neutral-400">(optional)</span>
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
              disabled={submitting}
              placeholder="yourname"
              className="flex-1 min-w-0 bg-transparent text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none disabled:text-neutral-500"
            />
          </div>
          <p className="text-xs text-neutral-400">
            Your @name — pick anything. It doesn't have to be unique, and you
            can change it whenever.
          </p>
        </label>

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

        <div className="space-y-2">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Avatar <span className="text-neutral-400">(optional)</span>
          </span>
          <AvatarPicker
            existingURL={removeExistingAvatar ? undefined : original?.avatarURL}
            newPreviewURL={newAvatarPreviewURL}
            hasExisting={!!original?.avatarURL && !removeExistingAvatar}
            removed={removeExistingAvatar}
            onChange={handleAvatarChange}
            onRemove={handleRemoveAvatar}
            submitting={submitting}
          />
        </div>

        <div className="space-y-2">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Cover banner <span className="text-neutral-400">(optional)</span>
          </span>
          <CoverPicker
            existingURL={removeExistingCover ? undefined : original?.coverURL}
            newPreviewURL={newCoverPreviewURL}
            hasExisting={!!original?.coverURL && !removeExistingCover}
            removed={removeExistingCover}
            onChange={handleCoverChange}
            onRemove={handleRemoveCover}
            submitting={submitting}
          />
        </div>
      </div>

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      {submitting && (newAvatarFile || newCoverFile) && (
        <p className="text-neutral-500 text-xs">
          Uploading image bytes to Sia (~20 seconds per file), then writing your
          profile record to ATProto.
        </p>
      )}

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

function AvatarPicker({
  existingURL,
  newPreviewURL,
  hasExisting,
  removed,
  onChange,
  onRemove,
  submitting,
}: {
  existingURL: string | undefined
  newPreviewURL: string | null
  hasExisting: boolean
  removed: boolean
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  onRemove: () => void
  submitting: boolean
}) {
  return (
    <div className="flex items-center gap-3">
      <RoundPreview newPreviewURL={newPreviewURL} existingURL={existingURL} />
      <div className="flex-1 space-y-1">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={onChange}
          disabled={submitting}
          className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
        />
        {hasExisting && (
          <button
            type="button"
            onClick={onRemove}
            disabled={submitting}
            className="text-xs text-neutral-500 hover:text-red-600 transition-colors cursor-pointer"
          >
            Remove avatar
          </button>
        )}
        {removed && (
          <p className="text-xs text-neutral-500">
            Avatar will be removed on save.
          </p>
        )}
      </div>
    </div>
  )
}

function CoverPicker({
  existingURL,
  newPreviewURL,
  hasExisting,
  removed,
  onChange,
  onRemove,
  submitting,
}: {
  existingURL: string | undefined
  newPreviewURL: string | null
  hasExisting: boolean
  removed: boolean
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  onRemove: () => void
  submitting: boolean
}) {
  return (
    <div className="space-y-2">
      <BannerPreview newPreviewURL={newPreviewURL} existingURL={existingURL} />
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={onChange}
          disabled={submitting}
          className="block flex-1 min-w-0 text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
        />
        {hasExisting && (
          <button
            type="button"
            onClick={onRemove}
            disabled={submitting}
            className="text-xs text-neutral-500 hover:text-red-600 transition-colors cursor-pointer"
          >
            Remove cover
          </button>
        )}
      </div>
      {removed && (
        <p className="text-xs text-neutral-500">
          Cover will be removed on save.
        </p>
      )}
    </div>
  )
}

function RoundPreview({
  newPreviewURL,
  existingURL,
}: {
  newPreviewURL: string | null
  existingURL: string | undefined
}) {
  if (newPreviewURL) {
    return (
      <img
        src={newPreviewURL}
        alt="avatar preview"
        className="size-16 rounded-full object-cover border border-neutral-200 shrink-0"
      />
    )
  }
  if (existingURL) return <ExistingRound url={existingURL} />
  return (
    <div className="size-16 rounded-full bg-neutral-100 border border-neutral-200 shrink-0" />
  )
}

function ExistingRound({ url }: { url: string }) {
  const { url: blob } = useItemBlobURL(url, 'image/jpeg', undefined)
  if (!blob) {
    return (
      <div className="size-16 rounded-full bg-neutral-100 border border-neutral-200 shrink-0 animate-pulse" />
    )
  }
  return (
    <img
      src={blob}
      alt="current avatar"
      className="size-16 rounded-full object-cover border border-neutral-200 shrink-0"
    />
  )
}

function BannerPreview({
  newPreviewURL,
  existingURL,
}: {
  newPreviewURL: string | null
  existingURL: string | undefined
}) {
  if (newPreviewURL) {
    return (
      <img
        src={newPreviewURL}
        alt="cover preview"
        className="w-full h-24 object-cover rounded-md border border-neutral-200 bg-neutral-100"
      />
    )
  }
  if (existingURL) return <ExistingBanner url={existingURL} />
  return (
    <div className="w-full h-24 rounded-md bg-neutral-100 border border-neutral-200" />
  )
}

function ExistingBanner({ url }: { url: string }) {
  const { url: blob } = useItemBlobURL(url, 'image/jpeg', undefined)
  if (!blob) {
    return (
      <div className="w-full h-24 rounded-md bg-neutral-100 border border-neutral-200 animate-pulse" />
    )
  }
  return (
    <img
      src={blob}
      alt="current cover"
      className="w-full h-24 object-cover rounded-md border border-neutral-200 bg-neutral-100"
    />
  )
}
