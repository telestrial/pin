import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AttachmentSource } from '../core/channels'
import {
  type ItemRef,
  isValidAttachment,
  type OwnedChannel,
} from '../core/types'
import { NOTE_CHAR_LIMIT } from '../lib/constants'
import { byteToChar, type DraftMention } from '../lib/facets'
import { useActionStore } from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { useToastStore } from '../stores/toast'
import { kindForMime } from './AttachmentMedia'
import {
  type AttachmentDraft,
  Composer,
  type ComposerSubmission,
  newTempID,
} from './Composer'
import { ChannelAvatar } from './channel/ChannelAvatar'

// Writing a post. Everything about the form itself — the box, the mentions, attaching and
// previewing files, dragging onto it, the limit, the buttons — is `Composer`, shared with
// the comment composer. What is here is only what is true of a POST: which voice you are
// publishing as, editing one that already exists, and handing the bytes to a channel.

export type ComposeEditMode = {
  item: ItemRef
  channelID: string
  onCancel: () => void
}

export function Compose({
  channels,
  editing,
}: {
  channels: OwnedChannel[]
  editing?: ComposeEditMode
}) {
  const client = useAuthStore((s) => s.client)
  const enqueue = useActionStore((s) => s.enqueuePublish)
  const addToast = useToastStore((s) => s.addToast)
  const manifests = useFeedStore((s) => s.manifests)

  const [selectedID, setSelectedID] = useState(
    editing?.channelID ?? channels[0]?.channelID ?? '',
  )
  const [voiceOpen, setVoiceOpen] = useState(false)
  const voiceWrapperRef = useRef<HTMLDivElement | null>(null)

  const channel =
    channels.find((c) => c.channelID === selectedID) ?? channels[0]
  // Voice is locked when editing — the post is bound to its channel.
  const multiVoice = !editing && channels.length > 1

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

  // The composer avatar is the selected channel's; authorHandle is just a mark-seed
  // fallback, empty now that there's no atproto handle.
  const handleForAvatar = ''

  function handleSubmit(submission: ComposerSubmission) {
    // Thrown rather than returned, so the composer keeps the draft. Returning quietly would
    // clear a post that was never queued.
    if (!client) throw new Error('Not connected to Sia yet')
    if (!channel) throw new Error('No channel to publish to')
    const attachmentSources: AttachmentSource[] = submission.attachments.map(
      (a) =>
        a.source === 'url'
          ? {
              kind: 'url',
              url: a.url,
              mimeType: a.mimeType,
              filename: a.filename,
              byteSize: a.byteSize,
              contentHash: a.contentHash,
              objectID: a.objectID,
            }
          : {
              kind: 'bytes',
              bytes: a.bytes,
              mimeType: a.mimeType,
              filename: a.filename,
            },
    )
    // sdk.upload rejects 0-byte uploads (verified day-0). For attachment-only posts, encode
    // a single space so the body object is valid; the renderer reads summary (which stays
    // as the empty trimmed string).
    const bodyBytes = submission.body
      ? new TextEncoder().encode(submission.body)
      : new Uint8Array([0x20])
    enqueue({
      payload: {
        type: 'text',
        title: '',
        summary: submission.body,
        mimeType: 'text/markdown',
        bytes: bodyBytes,
        attachmentSources:
          attachmentSources.length > 0 ? attachmentSources : undefined,
        facets: submission.facets.length > 0 ? submission.facets : undefined,
      },
      channelIDs: [channel.channelID],
      editingItemID: editing?.item.id,
      removedAttachmentObjectIDs: editing
        ? submission.removedOriginalObjectIDs
        : undefined,
    })
    addToast(editing ? 'Queued for save' : 'Queued for publish')
    editing?.onCancel()
  }

  return (
    <Composer
      avatar={
        <div ref={voiceWrapperRef} className="contents">
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
                avatar={manifests[channel.channelID]?.avatar}
                size="md"
              />
            </button>
          ) : (
            <ChannelAvatar
              channelID={channel.channelID}
              channelName={channel.name}
              authorHandle={handleForAvatar}
              avatar={manifests[channel.channelID]?.avatar}
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
                      avatar={manifests[c.channelID]?.avatar}
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
      }
      placeholder="What are you thinking about?"
      submitLabel={editing ? 'Save' : 'Publish'}
      limit={{ unit: 'chars', max: NOTE_CHAR_LIMIT }}
      onSubmit={handleSubmit}
      onCancel={editing?.onCancel}
      startExpanded={!!editing}
      initialBody={editing?.item.summary ?? ''}
      initialAttachments={() => {
        if (!editing?.item.attachments) return []
        return editing.item.attachments
          .filter(isValidAttachment)
          .map((a): AttachmentDraft => {
            return {
              tempID: newTempID(),
              source: 'url',
              filename: a.filename ?? 'attachment',
              mimeType: a.mimeType,
              kind: kindForMime(a.mimeType),
              url: a.url,
              byteSize: a.byteSize,
              contentHash: a.contentHash,
              objectID: a.objectID,
              // Already published, so removing it is a removal that needs cleanup —
              // unlike an armed library item, whose bytes the library still references.
              // Legacy attachments lacking objectID can't be tracked; the orphan sweep
              // is the safety net.
              original: true,
            }
          })
      }}
      initialMentions={() => {
        const facets = editing?.item.facets
        const summary = editing?.item.summary ?? ''
        if (!facets) return []
        const out: DraftMention[] = []
        for (const f of facets) {
          const mf = f.features.find((x) => x.$type === 'pin.mention')
          if (!mf) continue
          const cs = byteToChar(summary, f.index.byteStart)
          const ce = byteToChar(summary, f.index.byteEnd)
          out.push({
            did: mf.did,
            handle: mf.handle ?? '',
            surface: summary.slice(cs, ce),
          })
        }
        return out
      }}
    />
  )
}
