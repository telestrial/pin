import { type ChangeEvent, useEffect, useState } from 'react'
import { downloadItemBytes, editItem } from '../core/channels'
import { APP_SANDBOX } from '../lib/constants'
import type { ItemRef } from '../core/types'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { useToastStore } from '../stores/toast'

export function EditApp({
  item,
  channel,
  onCancel,
  onSaved,
}: {
  item: ItemRef
  channel: OwnedChannel
  onCancel: () => void
  onSaved: () => void
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const refreshChannel = useFeedStore((s) => s.refreshChannel)
  const addToast = useToastStore((s) => s.addToast)

  const [title, setTitle] = useState(item.title)
  const [currentHTML, setCurrentHTML] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [bodyLoading, setBodyLoading] = useState(true)
  const [newFile, setNewFile] = useState<File | null>(null)
  const [newPreviewHTML, setNewPreviewHTML] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sdk) return
    let cancelled = false
    setBodyLoading(true)
    downloadItemBytes(sdk, item.itemURL)
      .then((bytes) => {
        if (cancelled) return
        setCurrentHTML(new TextDecoder().decode(bytes))
        setBodyLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : 'Failed to load app')
        setBodyLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sdk, item.itemURL])

  useEffect(() => {
    if (!newFile) {
      setNewPreviewHTML(null)
      return
    }
    let cancelled = false
    newFile.text().then((text) => {
      if (!cancelled) setNewPreviewHTML(text)
    })
    return () => {
      cancelled = true
    }
  }, [newFile])

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    if (!f) {
      setNewFile(null)
      return
    }
    const name = f.name.toLowerCase()
    const isHTML =
      f.type === 'text/html' || name.endsWith('.html') || name.endsWith('.htm')
    if (!isHTML) {
      setError(
        `Unsupported file type: ${f.type || 'unknown'}. Use a .html file.`,
      )
      setNewFile(null)
      return
    }
    setError(null)
    setNewFile(f)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !agent || submitting || bodyLoading) return
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    if (!newFile && trimmedTitle === item.title) {
      setError('Nothing to save — pick a new file or change the title.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const bytes = newFile
        ? new Uint8Array(await newFile.arrayBuffer())
        : new TextEncoder().encode(currentHTML ?? '')
      await editItem(sdk, agent, channel, item.id, {
        type: 'app',
        title: trimmedTitle,
        mimeType: 'text/html',
        bytes,
      })
      const sub = subscriptions.find((s) => s.channelID === channel.channelID)
      if (sub) await refreshChannel(sub)
      addToast(`Updated “${trimmedTitle}”`)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
      setSubmitting(false)
    }
  }

  if (loadError) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-4">
          <p className="text-red-600 text-sm wrap-break-word">{loadError}</p>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors cursor-pointer"
          >
            Back
          </button>
        </div>
      </div>
    )
  }

  const previewHTML = newPreviewHTML ?? currentHTML

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-2xl mx-auto space-y-4 p-6"
    >
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-900">Edit app</h1>
        <p className="text-neutral-500 text-sm">
          Replace the HTML, change the title, or both. New bytes upload first;
          the manifest only swaps if upload succeeds. Subscribers who pinned
          the previous version keep their snapshot.
        </p>
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={submitting || bodyLoading}
        required
        placeholder="Title"
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
      />

      <div className="space-y-1">
        <label className="block text-xs font-medium text-neutral-700 uppercase tracking-wider">
          New HTML file{' '}
          <span className="text-neutral-400">(leave empty to keep current)</span>
        </label>
        <input
          type="file"
          accept="text/html,.html,.htm"
          onChange={handleFileChange}
          disabled={submitting || bodyLoading}
          className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
        />
      </div>

      {previewHTML !== null && (
        <iframe
          title="App preview"
          srcDoc={previewHTML}
          sandbox={APP_SANDBOX}
          allow="fullscreen"
          className="w-full aspect-4/3 rounded-lg border border-neutral-200 bg-white"
        />
      )}

      {bodyLoading && (
        <p className="text-neutral-500 text-xs">Loading current version…</p>
      )}

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      {submitting && (
        <p className="text-neutral-500 text-xs">
          Uploading new bytes to Sia, then writing the manifest. The old
          version stays live until both succeed.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting || bodyLoading || !title.trim()}
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
