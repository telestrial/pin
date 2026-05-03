import { type ChangeEvent, useEffect, useState } from 'react'
import {
  type EditChannelPatch,
  editChannel,
  fetchChannel,
} from '../core/channels'
import type { ChannelCover, ChannelManifest } from '../core/types'
import { useItemBlobURL } from '../lib/useItemBytes'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { FormCard } from './FormCard'

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
  const agent = useAuthStore((s) => s.atprotoAgent)
  const session = useAuthStore((s) => s.atprotoSession)
  const updateMyChannelName = useAuthStore((s) => s.updateMyChannelName)
  const updateSubscriptionName = useAuthStore((s) => s.updateSubscriptionName)
  const refreshChannel = useFeedStore((s) => s.refreshChannel)
  const subscriptions = useAuthStore((s) => s.subscriptions)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [original, setOriginal] = useState<ChannelManifest | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [newCoverFile, setNewCoverFile] = useState<File | null>(null)
  const [newCoverPreviewURL, setNewCoverPreviewURL] = useState<string | null>(
    null,
  )
  const [removeExistingCover, setRemoveExistingCover] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!session) {
      setLoadError('Bluesky session not active.')
      setLoading(false)
      return
    }
    fetchChannel(session.did, channelID, channelKey)
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
  }, [session, channelID, channelKey])

  useEffect(() => {
    if (!newCoverFile) {
      setNewCoverPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(newCoverFile)
    setNewCoverPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [newCoverFile])

  function handleCoverChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    if (!f) {
      setNewCoverFile(null)
      return
    }
    if (!ACCEPTED_COVER_MIMES.includes(f.type)) {
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
    if (!sdk || !agent || !original) return
    const trimmedName = name.trim()
    if (!trimmedName) return
    setSubmitting(true)
    setError(null)
    try {
      const patch: EditChannelPatch = {}
      if (trimmedName !== original.name) patch.name = trimmedName
      const trimmedDesc = description.trim()
      if (trimmedDesc !== original.description) patch.description = trimmedDesc
      if (newCoverFile) {
        const buf = await newCoverFile.arrayBuffer()
        patch.coverImage = {
          bytes: new Uint8Array(buf),
          mimeType: newCoverFile.type,
        }
      } else if (removeExistingCover) {
        patch.removeCover = true
      }
      const updated = await editChannel(
        sdk,
        agent,
        { channelID, channelKey },
        patch,
      )
      if (patch.name) {
        updateMyChannelName(channelID, updated.name)
        updateSubscriptionName(channelID, updated.name)
      }
      const sub = subscriptions.find((s) => s.channelID === channelID)
      if (sub) await refreshChannel(sub)
      onSaved(updated.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save changes')
      setSubmitting(false)
    }
  }

  const card = (content: React.ReactNode) => (
    <FormCard
      sidebar={sidebar}
      rightSidebar={rightSidebar}
      onBack={onCancel}
    >
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
            Cover image <span className="text-neutral-400">(optional)</span>
          </span>
          <CoverPicker
            existingCover={original.coverArt}
            newCoverPreviewURL={newCoverPreviewURL}
            removeExistingCover={removeExistingCover}
            onCoverChange={handleCoverChange}
            onRemoveCover={handleRemoveCover}
            submitting={submitting}
          />
        </div>
      </div>

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      {submitting && (
        <p className="text-neutral-500 text-xs">
          {newCoverFile
            ? 'Uploading cover to Sia (~20 seconds), encrypting manifest, writing to ATProto.'
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

function CoverPicker({
  existingCover,
  newCoverPreviewURL,
  removeExistingCover,
  onCoverChange,
  onRemoveCover,
  submitting,
}: {
  existingCover?: ChannelCover
  newCoverPreviewURL: string | null
  removeExistingCover: boolean
  onCoverChange: (e: ChangeEvent<HTMLInputElement>) => void
  onRemoveCover: () => void
  submitting: boolean
}) {
  const showExisting =
    !!existingCover && !removeExistingCover && !newCoverPreviewURL
  const showRemoveButton = !!existingCover && !removeExistingCover

  return (
    <div className="flex items-center gap-3">
      <CoverPreview
        existingCover={showExisting ? existingCover : undefined}
        newCoverPreviewURL={newCoverPreviewURL}
      />
      <div className="flex-1 space-y-1">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={onCoverChange}
          disabled={submitting}
          className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
        />
        {showRemoveButton && (
          <button
            type="button"
            onClick={onRemoveCover}
            disabled={submitting}
            className="text-xs text-neutral-500 hover:text-red-600 transition-colors cursor-pointer"
          >
            Remove cover
          </button>
        )}
        {removeExistingCover && (
          <p className="text-xs text-neutral-500">
            Cover will be removed on save.
          </p>
        )}
      </div>
    </div>
  )
}

function CoverPreview({
  existingCover,
  newCoverPreviewURL,
}: {
  existingCover?: ChannelCover
  newCoverPreviewURL: string | null
}) {
  if (newCoverPreviewURL) {
    return (
      <img
        src={newCoverPreviewURL}
        alt="cover preview"
        className="size-16 rounded-full object-cover border border-neutral-200 shrink-0"
      />
    )
  }
  if (existingCover) {
    return <ExistingCover cover={existingCover} />
  }
  return (
    <div className="size-16 rounded-full bg-neutral-100 border border-neutral-200 shrink-0" />
  )
}

function ExistingCover({ cover }: { cover: ChannelCover }) {
  const { url } = useItemBlobURL(cover.itemURL, cover.mimeType)
  if (!url) {
    return (
      <div className="size-16 rounded-full bg-neutral-100 border border-neutral-200 shrink-0 animate-pulse" />
    )
  }
  return (
    <img
      src={url}
      alt="current cover"
      className="size-16 rounded-full object-cover border border-neutral-200 shrink-0"
    />
  )
}
