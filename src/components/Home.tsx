import { useState } from 'react'
import type { FeedEntry } from '../core/feed'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { BlueskyLoginScreen } from './BlueskyLoginScreen'
import { ChannelsView } from './ChannelsView'
import { Compose } from './Compose'
import { CreateChannel } from './CreateChannel'
import { HomeFeed } from './HomeFeed'
import { ReadAudio } from './ReadAudio'
import { ReadFile } from './ReadFile'
import { ReadImage } from './ReadImage'
import { ReadText } from './ReadText'
import { ReadVideo } from './ReadVideo'
import { ReadWebapp } from './ReadWebapp'
import { SubscribeToChannel } from './SubscribeToChannel'

type GatedView =
  | { kind: 'creating' }
  | { kind: 'composing'; channel: OwnedChannel }

type View =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; subscribeURL: string; name: string }
  | { kind: 'subscribing' }
  | { kind: 'channels' }
  | { kind: 'composing'; channel: OwnedChannel }
  | { kind: 'published'; itemURL: string; title: string }
  | { kind: 'reading'; entry: FeedEntry }
  | { kind: 'bluesky-login'; resumeTo: GatedView; cancelTo: View }

export function Home() {
  const [view, setView] = useState<View>({ kind: 'idle' })
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const myChannels = useAuthStore((s) => s.myChannels)
  const addToast = useToastStore((s) => s.addToast)

  function copyURL(url: string, label: string) {
    navigator.clipboard.writeText(url)
    addToast(label)
  }

  function gotoGated(target: GatedView) {
    if (useAuthStore.getState().atprotoAgent) {
      setView(target)
    } else {
      setView({ kind: 'bluesky-login', resumeTo: target, cancelTo: view })
    }
  }

  if (view.kind === 'bluesky-login') {
    return (
      <BlueskyLoginScreen
        onCancel={() => setView(view.cancelTo)}
        onSignedIn={() => setView(view.resumeTo)}
      />
    )
  }

  if (view.kind === 'creating') {
    return (
      <CreateChannel
        onCancel={() => setView({ kind: 'idle' })}
        onCreated={(subscribeURL, name) =>
          setView({ kind: 'created', subscribeURL, name })
        }
      />
    )
  }

  if (view.kind === 'created') {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-5">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-neutral-900">
              Channel created
            </h1>
            <p className="text-neutral-500 text-sm">
              Share this URL so others can subscribe to{' '}
              <span className="text-neutral-900">{view.name}</span>.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 sm:justify-center">
            <button
              type="button"
              onClick={() => copyURL(view.subscribeURL, 'Subscribe URL copied')}
              className="px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Copy subscribe URL
            </button>
            <button
              type="button"
              onClick={() => setView({ kind: 'idle' })}
              className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (view.kind === 'subscribing') {
    return (
      <SubscribeToChannel
        onCancel={() => setView({ kind: 'idle' })}
        onSubscribed={() => setView({ kind: 'idle' })}
      />
    )
  }

  if (view.kind === 'channels') {
    return (
      <ChannelsView
        onCancel={() => setView({ kind: 'idle' })}
        onCompose={(channel) => gotoGated({ kind: 'composing', channel })}
      />
    )
  }

  if (view.kind === 'composing') {
    return (
      <Compose
        channel={view.channel}
        onCancel={() => setView({ kind: 'channels' })}
        onPublished={(itemURL, title) =>
          setView({ kind: 'published', itemURL, title })
        }
      />
    )
  }

  if (view.kind === 'reading') {
    const { item, channel } = view.entry
    const onBack = () => setView({ kind: 'idle' })
    const readerProps = { item, channelName: channel.name, onBack }
    if (item.type === 'image') return <ReadImage {...readerProps} />
    if (item.type === 'audio') return <ReadAudio {...readerProps} />
    if (item.type === 'video') return <ReadVideo {...readerProps} />
    if (item.type === 'file') return <ReadFile {...readerProps} />
    if (item.type === 'webapp') return <ReadWebapp {...readerProps} />
    return <ReadText {...readerProps} />
  }

  if (view.kind === 'published') {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-5">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-neutral-900">
              Item published
            </h1>
            <p className="text-neutral-500 text-sm">
              Direct link to{' '}
              <span className="text-neutral-900">{view.title}</span>.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 sm:justify-center">
            <button
              type="button"
              onClick={() => copyURL(view.itemURL, 'Item URL copied')}
              className="px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Copy share URL
            </button>
            <button
              type="button"
              onClick={() => setView({ kind: 'idle' })}
              className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  const ctas = (
    <div className="flex flex-col sm:flex-row gap-2 sm:justify-center">
      <button
        type="button"
        onClick={() => setView({ kind: 'subscribing' })}
        className="px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
      >
        Subscribe to a channel
      </button>
      <button
        type="button"
        onClick={() => gotoGated({ kind: 'creating' })}
        className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors"
      >
        Create a channel
      </button>
    </div>
  )

  const yourChannelsAffordance = myChannels.length > 0 && (
    <button
      type="button"
      onClick={() => setView({ kind: 'channels' })}
      className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors underline underline-offset-2"
    >
      Your channels ({myChannels.length})
    </button>
  )

  if (subscriptions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-neutral-900">
              Your feed is empty
            </h1>
            <p className="text-neutral-600 text-sm">
              Subscribe to a channel, or create one of your own.
            </p>
          </div>
          {ctas}
          {yourChannelsAffordance && <div>{yourChannelsAffordance}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            Following {subscriptions.length} channel
            {subscriptions.length === 1 ? '' : 's'}
          </h2>
          {yourChannelsAffordance}
        </div>

        <HomeFeed
          onItemClick={(entry) => setView({ kind: 'reading', entry })}
        />

        {ctas}
      </div>
    </div>
  )
}
