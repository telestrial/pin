import { useState } from 'react'
import type { OwnedChannel } from '../stores/auth'
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

export function Compose({ channels }: { channels: OwnedChannel[] }) {
  const [tab, setTab] = useState<Tab>('note')
  const [selectedID, setSelectedID] = useState<string>(
    channels[0]?.channelID ?? '',
  )
  const [resetCounter, setResetCounter] = useState(0)

  const selected =
    channels.find((c) => c.channelID === selectedID) ?? channels[0]
  if (!selected) return null

  const formProps = {
    channel: selected,
    onQueued: () => setResetCounter((n) => n + 1),
  }

  return (
    <div className="border border-neutral-200 rounded-lg bg-white p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-500">Posting to</span>
        {channels.length > 1 ? (
          <select
            value={selected.channelID}
            onChange={(e) => setSelectedID(e.target.value)}
            aria-label="Channel to post to"
            className="font-medium text-neutral-900 bg-neutral-100 hover:bg-neutral-200 border-0 rounded px-2 py-1 cursor-pointer focus:outline-none focus:ring-2 focus:ring-green-600 focus:ring-offset-1"
          >
            {channels.map((c) => (
              <option key={c.channelID} value={c.channelID}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-medium text-neutral-900">{selected.name}</span>
        )}
      </div>

      <div className="flex gap-1.5 flex-wrap" role="tablist">
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

      <div
        key={`${tab}-${selected.channelID}-${resetCounter}`}
        className="pt-1"
      >
        {tab === 'note' && <ComposeNote {...formProps} />}
        {tab === 'post' && <ComposePost {...formProps} />}
        {tab === 'image' && <ComposeImage {...formProps} />}
        {tab === 'audio' && <ComposeAudio {...formProps} />}
        {tab === 'video' && <ComposeVideo {...formProps} />}
        {tab === 'file' && <ComposeFile {...formProps} />}
        {tab === 'app' && <ComposeApp {...formProps} />}
      </div>
    </div>
  )
}
