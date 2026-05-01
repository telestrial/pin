import { useState } from 'react'
import type { OwnedChannel } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { ComposeApp } from './ComposeApp'
import { ComposeAudio } from './ComposeAudio'
import { ComposeFile } from './ComposeFile'
import { ComposeImage } from './ComposeImage'
import { ComposeNote } from './ComposeNote'
import { ComposePost } from './ComposePost'
import { ComposeVideo } from './ComposeVideo'

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

export function Compose({ channels }: { channels: OwnedChannel[] }) {
  const [tab, setTab] = useState<Tab>('note')
  const [selectedID, setSelectedID] = useState<string>(
    channels[0]?.channelID ?? '',
  )
  const [resetCounter, setResetCounter] = useState(0)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

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

  function handleDragEnter(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(e: React.DragEvent) {
    if (e.currentTarget === e.target) setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
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
      {isDragging && (
        <div className="absolute inset-0 z-10 rounded-lg bg-green-50/90 flex items-center justify-center pointer-events-none">
          <p className="text-sm font-medium text-green-700">
            Drop to attach a single file
          </p>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {channels.length > 1 ? (
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
        )}
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
