import { type ChangeEvent, useEffect, useState } from 'react'
import { editItem, editItemMetadata } from '../core/channels'
import type { ItemRef } from '../core/types'
import { useItemBlobURL } from '../lib/useItemBytes'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { useToastStore } from '../stores/toast'

const ACCEPTED_MIMES = ['image/jpeg', 'image/png', 'image/webp']

export function EditImage({
  item,
  channel,
  onCancel,
  onSaved,
}: {
  item: ItemRef
  channel: OwnedChannel
  onCancel: () => void
  onSaved: (newItem: ItemRef) => void
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const refreshChannel = useFeedStore((s) => s.refreshChannel)
  const addToast = useToastStore((s) => s.addToast)

  const { url: currentURL } = useItemBlobURL(item.itemURL, item.mimeType)

  const [title, setTitle] = useState(item.title)
  const [newFile, setNewFile] = useState<File | null>(null)
  const [newPreviewURL, setNewPreviewURL] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!newFile) {
      setNewPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(newFile)
    setNewPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [newFile])

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    if (!f) {
      setNewFile(null)
      return
    }
    if (!ACCEPTED_MIMES.includes(f.type)) {
      setError(
        `Unsupported file type: ${f.type || 'unknown'}. Use JPEG, PNG, or WebP.`,
      )
      setNewFile(null)
      return
    }
    setError(null)
    setNewFile(f)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !agent || submitting) return
    const trimmedTitle = title.trim()
    const titleChanged = trimmedTitle !== item.title
    if (!newFile && !titleChanged) {
      setError('Nothing to save — pick a new image or change the title.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      let result: { item: ItemRef }
      if (newFile) {
        // Bytes change → full upload-then-swap.
        const buf = await newFile.arrayBuffer()
        result = await editItem(sdk, agent, channel, item.id, {
          type: 'image',
          title: trimmedTitle,
          mimeType: newFile.type,
          bytes: new Uint8Array(buf),
        })
      } else {
        // Title-only → manifest-only update; no Sia upload, same bytes.
        result = await editItemMetadata(agent, channel, item.id, {
          title: trimmedTitle,
        })
      }
      const sub = subscriptions.find((s) => s.channelID === channel.channelID)
      if (sub) await refreshChannel(sub)
      addToast(trimmedTitle ? `Updated “${trimmedTitle}”` : 'Updated image')
      onSaved(result.item)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
      setSubmitting(false)
    }
  }

  const previewURL = newPreviewURL ?? currentURL

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-2xl mx-auto space-y-4 p-6"
    >
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-900">Edit image</h1>
        <p className="text-neutral-500 text-sm">
          Change the title, the image, or both. Title-only updates skip the
          Sia round-trip and just rewrite the manifest. Subscribers who pinned
          the previous version keep their snapshot.
        </p>
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={submitting}
        placeholder="Title (optional)"
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
      />

      <div className="space-y-1">
        <label className="block text-xs font-medium text-neutral-700 uppercase tracking-wider">
          Replace image{' '}
          <span className="text-neutral-400">(leave empty to keep current)</span>
        </label>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileChange}
          disabled={submitting || !!newFile}
          className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
        />
      </div>

      {previewURL && (
        // biome-ignore lint/a11y/useAltText: alt is intentionally empty for decorative preview
        <img
          src={previewURL}
          alt=""
          className="max-w-full max-h-64 rounded-lg border border-neutral-200 object-contain bg-neutral-50"
        />
      )}

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      {submitting && (
        <p className="text-neutral-500 text-xs">
          {newFile
            ? 'Uploading new bytes to Sia, then writing the manifest. The old version stays live until both succeed.'
            : 'Updating the manifest.'}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
