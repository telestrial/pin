import { Paperclip, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useRef, useState } from 'react'
import type { Facet } from '../core/types'
import { buildMentionFacets, type DraftMention } from '../lib/facets'
import { useItemBlobURL } from '../lib/hooks/useItemBytes'
import { useMentionBox } from '../lib/hooks/useMentionBox'
import { useComposeStore } from '../stores/compose'
import {
  type AttachmentKind,
  kindForMime,
  MediaPreview,
} from './AttachmentMedia'
import { MentionPicker } from './MentionPicker'

// ONE composer, for a post and for a comment alike.
//
// The two were written separately and drifted into two different answers to the same
// question — a post could be dragged onto but had no picker button, a comment had a picker
// but no drag, no paste, no armed item and no preview of what you had attached. Neither
// difference was ever decided; they are just what two implementations do. So writing a
// remark and writing a post are now the same actions in the same order, and **the only
// thing that differs is what happens when you press the button**: a post hands its bytes to
// the channel it is published on, a comment keeps carrying its own and the record points at
// them.
//
// What legitimately still differs is passed in, and it is a short list: who the avatar is
// (a channel for a post, a person for a comment — a comment has no voice to pick), what the
// limit counts (characters for a post, BYTES for a comment, because the receiver counts
// bytes), how many files may ride along, and the words on the button. Everything else is
// here once.

/** One file or item on a draft, before anything has been published.
 *
 *  Two sources, and the difference is whether the bytes exist anywhere yet. `bytes` is
 *  something picked off the disk, held in memory with a blob URL so it can be previewed
 *  before it is uploaded. `url` is something ALREADY in this identity's Sia scope — an
 *  armed library item, or an attachment already on the post being edited — which is
 *  referenced rather than re-uploaded.
 *
 *  `objectID` names the object inside the user's own scope. It is what a caller uses to
 *  decide reclamation, and the rule it exists for is that re-attaching something you
 *  already own must never make it deletable: the library still references those bytes. */
export type AttachmentDraft =
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
      objectID?: string
      /** True when this came from the thing being edited rather than from the library, so
       *  removing it is a removal of something already published and needs cleanup. */
      original?: boolean
    }

/** What a caller gets when the button is pressed. Already trimmed, and the facets already
 *  resolved against the trimmed body — so the byte offsets a reader slices by are the ones
 *  the words actually have. */
export type ComposerSubmission = {
  body: string
  facets: Facet[]
  attachments: AttachmentDraft[]
  /** Object ids that were on the thing being edited and are no longer on the draft. Only
   *  ever non-empty in an edit; a chip you added and removed in one sitting was never
   *  published, so there is nothing to clean up. */
  removedOriginalObjectIDs: string[]
}

/** What the counter counts, which is the one thing the two composers genuinely disagree
 *  about. A post is limited in characters because that is the shape of the form; a comment
 *  is limited in BYTES because a host counts bytes and would refuse the record.
 *
 *  `max: null` reads as "not yet known" — the comment limit comes back from Rust — and a
 *  composer with an unknown limit refuses to submit rather than guessing. */
export type ComposerLimit = {
  unit: 'chars' | 'bytes'
  max: number | null
}

export function newTempID(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function measure(body: string, unit: 'chars' | 'bytes'): number {
  return unit === 'chars' ? body.length : new TextEncoder().encode(body).length
}

export function Composer({
  avatar,
  placeholder,
  submitLabel,
  busyLabel,
  busy = false,
  limit,
  attachmentCap = null,
  attachmentCapMessage,
  error,
  onSubmit,
  onCancel,
  initialBody = '',
  initialAttachments,
  initialMentions,
  startExpanded = false,
  bodyTextClass = 'text-lg',
}: {
  /** The identity slot. A channel avatar plus its voice picker for a post; the person for
   *  a comment. Passed in rather than branched on, because two components meant to look
   *  identical drift — the same reason the row itself is one component. */
  avatar: ReactNode
  placeholder: string
  submitLabel: string
  busyLabel?: string
  busy?: boolean
  limit: ComposerLimit
  /** How many files may ride along, or null for no ceiling. A comment has one because a
   *  knock must never make a receiver allocate bytes proportional to what the sender chose. */
  attachmentCap?: number | null
  /** What to say when a file is refused for want of room. The caller words it because the
   *  caller knows what this is — a comment says so in a comment's terms. */
  attachmentCapMessage?: string
  /** A failure the caller wants shown. The composer has its own for a refused file. */
  error?: string | null
  /** Throwing means the draft is KEPT — nothing was published, so nothing should be lost. */
  onSubmit: (submission: ComposerSubmission) => void | Promise<void>
  onCancel?: () => void
  initialBody?: string
  initialAttachments?: () => AttachmentDraft[]
  initialMentions?: () => DraftMention[]
  startExpanded?: boolean
  bodyTextClass?: string
}) {
  const armedItem = useComposeStore((s) => s.armedItem)
  const disarm = useComposeStore((s) => s.disarm)

  const [body, setBody] = useState(initialBody)
  const [attachments, setAttachments] = useState<AttachmentDraft[]>(
    () => initialAttachments?.() ?? [],
  )
  const [removedOriginalObjectIDs, setRemovedOriginalObjectIDs] = useState<
    string[]
  >([])
  const [isDragging, setIsDragging] = useState(false)
  const [expanded, setExpanded] = useState(startExpanded)
  const [capError, setCapError] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)

  // What an `@` does lives in `useMentionBox`, shared by both callers — a mention is only a
  // mention by virtue of the DID underneath it, and two implementations of the anchoring is
  // two chances for one of them to resolve to nobody.
  const mentionBox = useMentionBox({
    value: body,
    setValue: setBody,
    textarea: textareaRef,
    initial: initialMentions,
  })

  const trimmed = body.trim()
  const used = measure(body, limit.unit)
  const overLimit = limit.max !== null && used > limit.max
  // Near enough that the number is worth showing — a tenth of the way from the end. A
  // running count on an empty box is chrome; the same number as you approach a limit you
  // can actually hit is information.
  const nearLimit = limit.max !== null && used > limit.max * 0.9
  const full = attachmentCap !== null && attachments.length >= attachmentCap
  const capMessage = attachmentCapMessage ?? `At most ${attachmentCap} files`
  const canSubmit =
    !busy &&
    limit.max !== null &&
    !overLimit &&
    (!!trimmed || attachments.length > 0)

  function attachArmedItem() {
    if (!armedItem) return
    setAttachments((prev) => {
      if (attachmentCap !== null && prev.length >= attachmentCap) {
        setCapError(capMessage)
        return prev
      }
      return [
        ...prev,
        {
          tempID: newTempID(),
          source: 'url' as const,
          filename: armedItem.item.filename ?? armedItem.item.title ?? 'item',
          mimeType: armedItem.item.mimeType,
          kind: kindForMime(armedItem.item.mimeType),
          url: armedItem.item.itemURL,
          byteSize: armedItem.item.byteSize,
          contentHash: armedItem.item.contentHash,
          // armedItem.objectID is the user's pin (PinnedItemRef.objectID), which is the
          // right scope-local object ID. armedItem.item.id may be the original publisher's
          // id for items pinned from other channels, so prefer the PinnedItemRef field.
          objectID: armedItem.objectID,
        },
      ]
    })
    disarm()
    setExpanded(true)
  }

  async function attachFiles(files: File[]) {
    if (files.length === 0) return
    setCapError(null)
    // A cap of zero means the answer has not come back yet rather than "none allowed", so
    // there is nothing to tell anyone — the button is disabled and this resolves in
    // milliseconds.
    if (attachmentCap === 0) return
    const room =
      attachmentCap === null ? files.length : attachmentCap - attachments.length
    if (room <= 0) {
      setCapError(capMessage)
      return
    }
    const taken = files.slice(0, room)
    if (taken.length < files.length) {
      // Said rather than silently dropped: a picker that quietly took three of five would
      // publish something missing files the person believed they had attached.
      setCapError(capMessage)
    }
    const read = await Promise.all(
      taken.map(async (file) => {
        const mimeType = file.type || 'application/octet-stream'
        return {
          tempID: newTempID(),
          source: 'bytes' as const,
          filename: file.name || 'file',
          mimeType,
          kind: kindForMime(mimeType),
          bytes: new Uint8Array(await file.arrayBuffer()),
          blobURL: URL.createObjectURL(file),
        }
      }),
    )
    setAttachments((prev) => [...prev, ...read])
    setExpanded(true)
  }

  function removeAttachment(tempID: string) {
    setCapError(null)
    setAttachments((prev) => {
      const target = prev.find((a) => a.tempID === tempID)
      if (target?.source === 'bytes') URL.revokeObjectURL(target.blobURL)
      // Only something that was ALREADY published needs giving back. A chip added and
      // removed in one sitting never landed anywhere, and an armed library item is still
      // referenced by the library, so neither is reclaimable.
      if (target?.source === 'url' && target.original && target.objectID) {
        const oid = target.objectID
        setRemovedOriginalObjectIDs((r) => (r.includes(oid) ? r : [...r, oid]))
      }
      return prev.filter((a) => a.tempID !== tempID)
    })
  }

  function releaseBlobURLs() {
    for (const a of attachments) {
      if (a.source === 'bytes') URL.revokeObjectURL(a.blobURL)
    }
  }

  function isAttachZoneInteractive(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return true
    return !!target.closest(
      'button, a, select, [role="menuitem"], input, [data-attach-chip]',
    )
  }

  function handleAttachZoneClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!armedItem) {
      setExpanded(true)
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
    if (!trimmed && attachments.length === 0 && !armedItem && !startExpanded) {
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
    void attachFiles(Array.from(e.dataTransfer.files))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setCapError(null)
    try {
      await onSubmit({
        body: trimmed,
        // Resolved against the FINAL body, which is what gets stored and signed — so the
        // offsets align. A mention whose surface the author edited away is dropped rather
        // than left pointing at nothing.
        facets: buildMentionFacets(trimmed, mentionBox.mentions),
        attachments,
        removedOriginalObjectIDs,
      })
    } catch {
      // Kept, not cleared. Nothing was published, so nothing should be lost — the caller
      // shows why through `error`.
      return
    }
    releaseBlobURLs()
    setBody('')
    setAttachments([])
    setRemovedOriginalObjectIDs([])
    mentionBox.clear()
    setExpanded(startExpanded)
  }

  function handleCancel() {
    releaseBlobURLs()
    onCancel?.()
  }

  const shown = error ?? capError

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
          <p className="text-sm font-medium text-green-700">Drop to attach</p>
        </div>
      )}
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">{avatar}</div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: textarea inside handles keyboard */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: textarea inside handles keyboard */}
        <div className="flex-1 min-w-0" onClick={handleAttachZoneClick}>
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              mentionBox.onTextChanged(
                e.target.value,
                e.target.selectionStart ?? e.target.value.length,
              )
            }}
            onSelect={(e) =>
              mentionBox.onTextChanged(
                e.currentTarget.value,
                e.currentTarget.selectionStart ?? 0,
              )
            }
            onKeyDown={mentionBox.onKeyDown}
            onPaste={handleTextareaPaste}
            onFocus={() => setExpanded(true)}
            disabled={busy}
            rows={1}
            placeholder={placeholder}
            className={`block w-full mt-1.5 bg-transparent ${bodyTextClass} text-black placeholder-neutral-400 focus:outline-none resize-none border-0 p-0 field-sizing-content transition-[max-height] duration-300 ease-out ${
              expanded ? 'max-h-80 overflow-y-auto' : 'max-h-7 overflow-hidden'
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

      {mentionBox.picker && (
        <MentionPicker
          candidates={mentionBox.picker.candidates}
          loading={mentionBox.picker.loading}
          activeIndex={mentionBox.picker.activeIndex}
          onPick={mentionBox.picker.pick}
        />
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
          <div className="flex items-center justify-end gap-2">
            {(shown || nearLimit) && (
              <p
                className={`mr-auto text-xs wrap-break-word ${
                  shown
                    ? 'text-red-600'
                    : overLimit
                      ? 'text-red-600 font-medium'
                      : 'text-neutral-500'
                }`}
              >
                {shown ??
                  (limit.unit === 'chars'
                    ? `${(limit.max ?? 0) - used}`
                    : overLimit
                      ? `${used - (limit.max ?? 0)} bytes too long`
                      : `${(limit.max ?? 0) - used} bytes left`)}
              </p>
            )}
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void attachFiles(Array.from(e.target.files ?? []))
                // Cleared so picking the same file twice in a row still fires a change.
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => filePicker.current?.click()}
              disabled={busy || full}
              tabIndex={expanded ? 0 : -1}
              aria-label="Attach a file"
              title={full ? capMessage : 'Attach a file'}
              className="p-1.5 text-neutral-500 hover:text-neutral-900 cursor-pointer disabled:text-neutral-300 disabled:cursor-default"
            >
              <Paperclip className="size-4" aria-hidden />
            </button>
            {onCancel && (
              <button
                type="button"
                onClick={handleCancel}
                tabIndex={expanded ? 0 : -1}
                className="px-4 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-sm font-medium rounded-md transition-colors cursor-pointer"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={!canSubmit}
              tabIndex={expanded ? 0 : -1}
              className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-md transition-colors"
            >
              {busy ? (busyLabel ?? submitLabel) : submitLabel}
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
  const { url } = useItemBlobURL(
    attachment.url,
    attachment.mimeType,
    attachment.contentHash,
  )
  return (
    <MediaPreview
      previewURL={url}
      kind={attachment.kind}
      filename={attachment.filename}
      byteSize={attachment.byteSize}
    />
  )
}
