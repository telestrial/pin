import { Check, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AttachmentSource } from '../core/channels'
import { NOTE_CHAR_LIMIT } from '../lib/constants'
import { useItemBlobURL } from '../lib/useItemBytes'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useComposeStore } from '../stores/compose'
import { useFeedStore } from '../stores/feed'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'
import {
  type AttachmentKind,
  kindForMime,
  MediaPreview,
} from './AttachmentMedia'
import { ChannelAvatar } from './ChannelAvatar'

type AttachmentDraft =
  | {
      tempID: string
      source: 'bytes'
      filename: string
      mimeType: string
      kind: AttachmentKind
      bytes: Uint8Array
      blobURL: string
    }
  | {
      tempID: string
      source: 'url'
      filename: string
      mimeType: string
      kind: AttachmentKind
      url: string
      byteSize: number
      contentHash?: string
    }

function newTempID(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function Compose({ channels }: { channels: OwnedChannel[] }) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const atprotoHandle = useAuthStore((s) => s.atprotoHandle)
  const enqueue = useUploadQueueStore((s) => s.enqueue)
  const addToast = useToastStore((s) => s.addToast)
  const armedItem = useComposeStore((s) => s.armedItem)
  const disarm = useComposeStore((s) => s.disarm)
  const manifests = useFeedStore((s) => s.manifests)

  const [selectedID, setSelectedID] = useState(channels[0]?.channelID ?? '')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const voiceWrapperRef = useRef<HTMLDivElement | null>(null)

  const channel =
    channels.find((c) => c.channelID === selectedID) ?? channels[0]
  const multiVoice = channels.length > 1

  useEffect(() => {
    if (!voiceOpen) return
    function onMouseDown(e: MouseEvent) {
      if (!voiceWrapperRef.current?.contains(e.target as Node)) {
        setVoiceOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setVoiceOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [voiceOpen])

  if (!channel) return null

  const trimmed = body.trim()
  const remaining = NOTE_CHAR_LIMIT - body.length
  const overLimit = remaining < 0
  const canSubmit = !overLimit && (!!trimmed || attachments.length > 0)
  const handleForAvatar = atprotoHandle ?? ''

  function attachArmedItem() {
    if (!armedItem) return
    setAttachments((prev) => [
      ...prev,
      {
        tempID: newTempID(),
        source: 'url',
        filename: armedItem.item.filename ?? armedItem.item.title ?? 'item',
        mimeType: armedItem.item.mimeType,
        kind: kindForMime(armedItem.item.mimeType),
        url: armedItem.item.itemURL,
        byteSize: armedItem.item.byteSize,
        contentHash: armedItem.item.contentHash,
      },
    ])
    disarm()
    if (!expanded) setExpanded(true)
  }

  async function attachFile(file: File) {
    const filename = file.name || 'file'
    const mimeType = file.type || 'application/octet-stream'
    const kind = kindForMime(mimeType)
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const blobURL = URL.createObjectURL(file)
    setAttachments((prev) => [
      ...prev,
      {
        tempID: newTempID(),
        source: 'bytes',
        filename,
        mimeType,
        kind,
        bytes,
        blobURL,
      },
    ])
    if (!expanded) setExpanded(true)
  }

  function removeAttachment(tempID: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.tempID === tempID)
      if (target?.source === 'bytes') URL.revokeObjectURL(target.blobURL)
      return prev.filter((a) => a.tempID !== tempID)
    })
  }

  function isAttachZoneInteractive(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return true
    return !!target.closest(
      'button, a, select, [role="menuitem"], input, [data-attach-chip]',
    )
  }

  function handleAttachZoneClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!armedItem) {
      if (!expanded) setExpanded(true)
      return
    }
    if (isAttachZoneInteractive(e.target)) return
    attachArmedItem()
  }

  function handleTextareaPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!armedItem) return
    e.preventDefault()
    attachArmedItem()
  }

  function handleFormBlur(e: React.FocusEvent<HTMLFormElement>) {
    if (e.currentTarget.contains(e.relatedTarget)) return
    if (!body.trim() && attachments.length === 0 && !armedItem) {
      setExpanded(false)
    }
  }

  function isAcceptedDrag(e: React.DragEvent): boolean {
    return e.dataTransfer.types.includes('Files')
  }

  function handleDragEnter(e: React.DragEvent) {
    if (!isAcceptedDrag(e)) return
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragOver(e: React.DragEvent) {
    if (!isAcceptedDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(e: React.DragEvent) {
    if (e.currentTarget === e.target) setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    for (const file of files) attachFile(file)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !canSubmit) return
    if (!agent || !agent.did) {
      setError('Bluesky session not active. Cancel and try again to sign in.')
      return
    }
    setError(null)
    const attachmentSources: AttachmentSource[] = attachments.map((a) =>
      a.source === 'url'
        ? {
            kind: 'url',
            url: a.url,
            mimeType: a.mimeType,
            filename: a.filename,
            byteSize: a.byteSize,
            contentHash: a.contentHash,
          }
        : {
            kind: 'bytes',
            bytes: a.bytes,
            mimeType: a.mimeType,
            filename: a.filename,
          },
    )
    // sdk.upload rejects 0-byte uploads (verified day-0). For attachment-only
    // posts, encode a single space so the body object is valid; the renderer
    // reads summary (which stays as the empty trimmed string).
    const bodyBytes = trimmed
      ? new TextEncoder().encode(trimmed)
      : new Uint8Array([0x20])
    enqueue({
      payload: {
        type: 'text',
        title: '',
        summary: trimmed,
        mimeType: 'text/markdown',
        bytes: bodyBytes,
        attachmentSources:
          attachmentSources.length > 0 ? attachmentSources : undefined,
      },
      channelIDs: [channel.channelID],
    })
    addToast('Queued for publish')
    for (const a of attachments) {
      if (a.source === 'bytes') URL.revokeObjectURL(a.blobURL)
    }
    setBody('')
    setAttachments([])
    setExpanded(false)
  }

  return (
    <form
      onSubmit={handleSubmit}
      onBlur={handleFormBlur}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-compose-area="true"
      className={`relative bg-white border rounded-lg p-3 transition-colors ${
        isDragging
          ? 'border-green-600 ring-2 ring-green-600/30'
          : 'border-neutral-200'
      }`}
    >
      {isDragging && (
        <div className="absolute inset-0 z-10 rounded-lg bg-green-50/90 flex items-center justify-center pointer-events-none">
          <p className="text-sm font-medium text-green-700">
            Drop to attach
          </p>
        </div>
      )}

      <div className="flex items-start gap-3">
        <div ref={voiceWrapperRef} className="relative shrink-0">
          {multiVoice ? (
            <button
              type="button"
              onClick={() => setVoiceOpen((v) => !v)}
              aria-label={`Voice: ${channel.name}. Change.`}
              aria-haspopup="menu"
              aria-expanded={voiceOpen}
              className="rounded-full focus:outline-none focus:ring-2 focus:ring-green-600 focus:ring-offset-1 cursor-pointer"
            >
              <ChannelAvatar
                channelID={channel.channelID}
                channelName={channel.name}
                authorHandle={handleForAvatar}
                coverArt={manifests[channel.channelID]?.coverArt}
                size="md"
              />
            </button>
          ) : (
            <ChannelAvatar
              channelID={channel.channelID}
              channelName={channel.name}
              authorHandle={handleForAvatar}
              coverArt={manifests[channel.channelID]?.coverArt}
              size="md"
            />
          )}

          {multiVoice && voiceOpen && (
            <div
              role="menu"
              aria-label="Choose voice"
              className="absolute top-full left-0 mt-1 z-20 min-w-50 bg-white border border-neutral-200 rounded-lg shadow-lg py-1"
            >
              {channels.map((c) => {
                const active = c.channelID === channel.channelID
                return (
                  <button
                    key={c.channelID}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSelectedID(c.channelID)
                      setVoiceOpen(false)
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-neutral-50 cursor-pointer"
                  >
                    <ChannelAvatar
                      channelID={c.channelID}
                      channelName={c.name}
                      authorHandle={handleForAvatar}
                      coverArt={manifests[c.channelID]?.coverArt}
                      size="sm"
                    />
                    <span className="flex-1 text-left text-neutral-900 truncate">
                      {c.name}
                    </span>
                    {active && (
                      <Check className="size-4 text-green-600" aria-hidden />
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* biome-ignore lint/a11y/useKeyWithClickEvents: textarea inside handles keyboard */}
        <div
          className="flex-1 min-w-0"
          onClick={handleAttachZoneClick}
        >
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onPaste={handleTextareaPaste}
            onFocus={() => setExpanded(true)}
            rows={1}
            placeholder="What are you thinking about?"
            className={`block w-full mt-1.5 bg-transparent text-lg text-black placeholder-neutral-400 focus:outline-none resize-none border-0 p-0 field-sizing-content transition-[max-height] duration-300 ease-out ${
              expanded
                ? 'max-h-80 overflow-y-auto'
                : 'max-h-7 overflow-hidden'
            }`}
          />
        </div>
      </div>

      {attachments.length > 0 && (
        <div
          className={`mt-3 grid gap-2 ${
            attachments.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
          }`}
        >
          {attachments.map((a) => (
            <AttachmentChip
              key={a.tempID}
              attachment={a}
              onRemove={() => removeAttachment(a.tempID)}
            />
          ))}
        </div>
      )}

      <div
        aria-hidden={!expanded}
        className={`grid transition-[grid-template-rows,opacity,margin-top] duration-300 ease-out ${
          expanded
            ? 'grid-rows-[1fr] opacity-100 mt-2'
            : 'grid-rows-[0fr] opacity-0 mt-0'
        }`}
      >
        <div className="overflow-hidden">
          {error && (
            <p className="text-red-600 text-sm wrap-break-word mb-2">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <span
              className={`text-xs tabular-nums ${
                overLimit
                  ? 'text-red-600 font-medium'
                  : remaining <= 20
                    ? 'text-amber-600'
                    : 'text-neutral-500'
              }`}
            >
              {remaining}
            </span>
            <button
              type="submit"
              disabled={!canSubmit}
              tabIndex={expanded ? 0 : -1}
              className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-md transition-colors"
            >
              Publish
            </button>
          </div>
        </div>
      </div>
    </form>
  )
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: AttachmentDraft
  onRemove: () => void
}) {
  return (
    <div
      data-attach-chip="true"
      className="relative group bg-neutral-50 border border-neutral-200 rounded-lg overflow-hidden"
    >
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.filename}`}
        className="absolute top-1 right-1 z-10 size-6 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 cursor-pointer"
      >
        <X className="size-3.5" aria-hidden />
      </button>

      {attachment.source === 'bytes' ? (
        <BytesChipBody attachment={attachment} />
      ) : (
        <UrlChipBody attachment={attachment} />
      )}
    </div>
  )
}

function BytesChipBody({
  attachment,
}: {
  attachment: Extract<AttachmentDraft, { source: 'bytes' }>
}) {
  return (
    <MediaPreview
      previewURL={attachment.blobURL}
      kind={attachment.kind}
      filename={attachment.filename}
      byteSize={attachment.bytes.length}
    />
  )
}

function UrlChipBody({
  attachment,
}: {
  attachment: Extract<AttachmentDraft, { source: 'url' }>
}) {
  const { url } = useItemBlobURL(attachment.url, attachment.mimeType)
  return (
    <MediaPreview
      previewURL={url}
      kind={attachment.kind}
      filename={attachment.filename}
      byteSize={attachment.byteSize}
    />
  )
}
