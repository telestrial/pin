import { useState } from 'react'
import { downloadItemBytes } from '../core/channels'
import type { PinnedItemRef } from '../stores/pin'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { ComposeApp } from './ComposeApp'
import { ComposeAudio } from './ComposeAudio'
import { ComposeFile } from './ComposeFile'
import { ComposeImage } from './ComposeImage'
import { ComposeNote } from './ComposeNote'
import { ComposePost } from './ComposePost'
import { ComposeVideo } from './ComposeVideo'
import { PIN_ITEM_DRAG_TYPE } from './PinSidebar'

type Tab = 'note' | 'post' | 'image' | 'audio' | 'video' | 'file' | 'app'

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'note', label: 'Note' },
  { tab: 'post', label: 'Post' },
  { tab: 'image', label: 'Image' },
  { tab: 'audio', label: 'Audio' },
  { tab: 'video', label: 'Video' },
  { tab: 'file', label: 'File' },
  { tab: 'app', label: 'App' },
]

function tabForFile(file: File): Tab {
  const t = file.type
  const name = file.name.toLowerCase()
  if (t === 'image/jpeg' || t === 'image/png' || t === 'image/webp')
    return 'image'
  if (t === 'audio/mpeg' || t === 'audio/mp4' || t === 'audio/x-m4a')
    return 'audio'
  if (t === 'video/mp4') return 'video'
  if (t === 'text/html' || name.endsWith('.html') || name.endsWith('.htm'))
    return 'app'
  return 'file'
}

function tabForPinItemType(type: PinnedItemRef['item']['type']): Tab {
  switch (type) {
    case 'image':
      return 'image'
    case 'audio':
      return 'audio'
    case 'video':
      return 'video'
    case 'app':
      return 'app'
    default:
      return 'file'
  }
}

function filenameForPinItem(ref: PinnedItemRef): string {
  if (ref.item.filename) return ref.item.filename
  const safeTitle = (ref.item.title || ref.item.type).replace(/[^\w.-]+/g, '_')
  const ext = (() => {
    if (ref.item.mimeType === 'image/jpeg') return 'jpg'
    if (ref.item.mimeType === 'image/png') return 'png'
    if (ref.item.mimeType === 'image/webp') return 'webp'
    if (ref.item.mimeType === 'audio/mpeg') return 'mp3'
    if (ref.item.mimeType === 'audio/mp4') return 'm4a'
    if (ref.item.mimeType === 'audio/x-m4a') return 'm4a'
    if (ref.item.mimeType === 'video/mp4') return 'mp4'
    if (ref.item.mimeType === 'text/html') return 'html'
    return 'bin'
  })()
  return `${safeTitle}.${ext}`
}

export function Compose({
  channels,
  hideChannel = false,
}: {
  channels: OwnedChannel[]
  hideChannel?: boolean
}) {
  const [tab, setTab] = useState<Tab>('note')
  const [selectedID, setSelectedID] = useState<string>(
    channels[0]?.channelID ?? '',
  )
  const [resetCounter, setResetCounter] = useState(0)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [downloadingPin, setDownloadingPin] = useState(false)
  const addToast = useToastStore((s) => s.addToast)
  const sdk = useAuthStore((s) => s.sdk)

  const selected =
    channels.find((c) => c.channelID === selectedID) ?? channels[0]
  if (!selected) return null

  const formProps = {
    channel: selected,
    onQueued: () => {
      setPendingFile(null)
      setResetCounter((n) => n + 1)
    },
  }

  function isAcceptedDrag(e: React.DragEvent): boolean {
    return (
      e.dataTransfer.types.includes('Files') ||
      e.dataTransfer.types.includes(PIN_ITEM_DRAG_TYPE)
    )
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

  async function handlePinItemDrop(payload: string) {
    if (!sdk) {
      addToast('Sign in first')
      return
    }
    let ref: PinnedItemRef
    try {
      ref = JSON.parse(payload) as PinnedItemRef
    } catch {
      addToast('Invalid pinned-item payload')
      return
    }
    setDownloadingPin(true)
    try {
      const bytes = await downloadItemBytes(sdk, ref.item.itemURL)
      const file = new File(
        [bytes as BlobPart],
        filenameForPinItem(ref),
        { type: ref.item.mimeType },
      )
      setPendingFile(file)
      setTab(tabForPinItemType(ref.item.type))
      setResetCounter((n) => n + 1)
      addToast('Pinned item attached')
    } catch (e) {
      addToast(
        e instanceof Error
          ? `Couldn't fetch pinned item: ${e.message}`
          : "Couldn't fetch pinned item",
      )
    } finally {
      setDownloadingPin(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)

    const pinPayload = e.dataTransfer.getData(PIN_ITEM_DRAG_TYPE)
    if (pinPayload) {
      handlePinItemDrop(pinPayload)
      return
    }

    const files = e.dataTransfer.files
    if (files.length === 0) return
    if (files.length > 1) addToast('Only the first file was used')
    const file = files[0]
    setPendingFile(file)
    setTab(tabForFile(file))
    setResetCounter((n) => n + 1)
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative border rounded-lg bg-white p-3 space-y-2 transition-colors ${
        isDragging
          ? 'border-green-600 ring-2 ring-green-600/30'
          : 'border-neutral-200'
      }`}
    >
      {(isDragging || downloadingPin) && (
        <div className="absolute inset-0 z-10 rounded-lg bg-green-50/90 flex items-center justify-center pointer-events-none">
          <p className="text-sm font-medium text-green-700">
            {downloadingPin
              ? 'Fetching pinned item…'
              : 'Drop to attach — file or pinned item'}
          </p>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {!hideChannel &&
          (channels.length > 1 ? (
            <select
              value={selected.channelID}
              onChange={(e) => setSelectedID(e.target.value)}
              aria-label="Channel to post to"
              className="text-xs font-medium text-neutral-900 bg-neutral-100 hover:bg-neutral-200 border-0 rounded px-2 py-1 cursor-pointer focus:outline-none focus:ring-2 focus:ring-green-600 focus:ring-offset-1"
            >
              {channels.map((c) => (
                <option key={c.channelID} value={c.channelID}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs font-medium text-neutral-900 px-2 py-1 bg-neutral-50 rounded">
              {selected.name}
            </span>
          ))}
        <div className="flex gap-1 flex-wrap" role="tablist">
          {TABS.map((t) => {
            const active = t.tab === tab
            return (
              <button
                key={t.tab}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.tab)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                  active
                    ? 'bg-neutral-900 text-white'
                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                }`}
              >
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      <div key={`${tab}-${selected.channelID}-${resetCounter}`}>
        {tab === 'note' && <ComposeNote {...formProps} />}
        {tab === 'post' && <ComposePost {...formProps} />}
        {tab === 'image' && (
          <ComposeImage {...formProps} initialFile={pendingFile} />
        )}
        {tab === 'audio' && (
          <ComposeAudio {...formProps} initialFile={pendingFile} />
        )}
        {tab === 'video' && (
          <ComposeVideo {...formProps} initialFile={pendingFile} />
        )}
        {tab === 'file' && (
          <ComposeFile {...formProps} initialFile={pendingFile} />
        )}
        {tab === 'app' && (
          <ComposeApp {...formProps} initialFile={pendingFile} />
        )}
      </div>
    </div>
  )
}
