import { useState } from 'react'
import type { OwnedChannel } from '../stores/auth'
import { ComposeAudio } from './ComposeAudio'
import { ComposeFile } from './ComposeFile'
import { ComposeImage } from './ComposeImage'
import { ComposeNote } from './ComposeNote'
import { ComposePost } from './ComposePost'
import { ComposeVideo } from './ComposeVideo'
import { ComposeWebapp } from './ComposeWebapp'

type Tab = 'note' | 'post' | 'image' | 'audio' | 'video' | 'file' | 'webapp'

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'note', label: 'Note' },
  { tab: 'post', label: 'Post' },
  { tab: 'image', label: 'Image' },
  { tab: 'audio', label: 'Audio' },
  { tab: 'video', label: 'Video' },
  { tab: 'file', label: 'File' },
  { tab: 'webapp', label: 'Webapp' },
]

export function Compose({
  channel,
  onCancel,
  onPublished,
}: {
  channel: OwnedChannel
  onCancel: () => void
  onPublished: (itemURL: string, title: string) => void
}) {
  const [tab, setTab] = useState<Tab>('note')

  const formProps = { channel, onCancel, onPublished }

  return (
    <div className="w-full max-w-md mx-auto p-6 space-y-5">
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-neutral-900">
          Publish to {channel.name}
        </h1>
        <div className="flex gap-2" role="tablist">
          {TABS.map((t) => {
            const active = t.tab === tab
            return (
              <button
                key={t.tab}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.tab)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
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

      {tab === 'note' && <ComposeNote {...formProps} />}
      {tab === 'post' && <ComposePost {...formProps} />}
      {tab === 'image' && <ComposeImage {...formProps} />}
      {tab === 'audio' && <ComposeAudio {...formProps} />}
      {tab === 'video' && <ComposeVideo {...formProps} />}
      {tab === 'file' && <ComposeFile {...formProps} />}
      {tab === 'webapp' && <ComposeWebapp {...formProps} />}
    </div>
  )
}
