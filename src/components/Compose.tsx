import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NOTE_CHAR_LIMIT } from '../lib/constants'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useComposeStore } from '../stores/compose'
import { useFeedStore } from '../stores/feed'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'
import { ChannelAvatar } from './ChannelAvatar'

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
  const canSubmit = !!trimmed && !overLimit
  const handleForAvatar = atprotoHandle ?? ''

  function insertArmedPinLink(ta: HTMLTextAreaElement) {
    if (!armedItem) return
    const pos = ta.selectionStart ?? body.length
    const link = armedItem.item.itemURL
    const next = body.slice(0, pos) + link + body.slice(ta.selectionEnd ?? pos)
    setBody(next)
    disarm()
    requestAnimationFrame(() => {
      ta.focus()
      const caret = pos + link.length
      ta.setSelectionRange(caret, caret)
    })
  }

  function handleClick(e: React.MouseEvent<HTMLTextAreaElement>) {
    if (!expanded) setExpanded(true)
    if (armedItem) insertArmedPinLink(e.currentTarget)
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!armedItem) return
    e.preventDefault()
    if (!expanded) setExpanded(true)
    insertArmedPinLink(e.currentTarget)
  }

  function handleFormBlur(e: React.FocusEvent<HTMLFormElement>) {
    // Don't collapse when focus moves inside the form (Publish button, voice popover).
    if (e.currentTarget.contains(e.relatedTarget)) return
    if (!body.trim() && !armedItem) setExpanded(false)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !canSubmit) return
    if (!agent || !agent.did) {
      setError('Bluesky session not active. Cancel and try again to sign in.')
      return
    }
    setError(null)
    enqueue({
      payload: {
        type: 'text',
        title: '',
        summary: trimmed,
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode(trimmed),
      },
      channelIDs: [channel.channelID],
    })
    addToast('Queued for publish')
    setBody('')
    setExpanded(false)
  }

  return (
    <form
      onSubmit={handleSubmit}
      onBlur={handleFormBlur}
      data-compose-area="true"
      className="bg-white border border-neutral-200 rounded-lg p-3"
    >
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

        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onClick={handleClick}
          onPaste={handlePaste}
          onFocus={() => setExpanded(true)}
          rows={3}
          placeholder="What are you thinking about?"
          className={`flex-1 min-w-0 mt-1.5 bg-transparent text-lg text-black placeholder-neutral-400 focus:outline-none resize-none border-0 p-0 transition-[max-height] duration-300 ease-out ${
            expanded
              ? 'max-h-80 overflow-y-auto'
              : 'max-h-7 overflow-hidden'
          }`}
        />
      </div>

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
