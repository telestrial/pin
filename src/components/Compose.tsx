import { useState } from 'react'
import type { ItemType } from '../core/types'
import type { OwnedChannel } from '../stores/auth'
import { ComposeAudio } from './ComposeAudio'
import { ComposeImage } from './ComposeImage'
import { ComposeText } from './ComposeText'
import { ComposeVideo } from './ComposeVideo'

const TABS: { type: ItemType; label: string }[] = [
  { type: 'text', label: 'Text' },
  { type: 'image', label: 'Image' },
  { type: 'audio', label: 'Audio' },
  { type: 'video', label: 'Video' },
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
  const [type, setType] = useState<ItemType>('text')

  const formProps = { channel, onCancel, onPublished }

  return (
    <div className="w-full max-w-md mx-auto p-6 space-y-5">
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-neutral-900">
          Publish to {channel.name}
        </h1>
        <div className="flex gap-2" role="tablist">
          {TABS.map((tab) => {
            const active = tab.type === type
            return (
              <button
                key={tab.type}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setType(tab.type)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  active
                    ? 'bg-neutral-900 text-white'
                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {type === 'text' && <ComposeText {...formProps} />}
      {type === 'image' && <ComposeImage {...formProps} />}
      {type === 'audio' && <ComposeAudio {...formProps} />}
      {type === 'video' && <ComposeVideo {...formProps} />}
    </div>
  )
}
