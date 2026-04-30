import { useState } from 'react'
import type { FeedEntry } from '../core/feed'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { BlueskyLoginScreen } from './BlueskyLoginScreen'
import { ChannelsView } from './ChannelsView'
import { Compose } from './Compose'
import { CreateChannel } from './CreateChannel'
import { HomeFeed } from './HomeFeed'
import { ReadApp } from './ReadApp'
import { ReadAudio } from './ReadAudio'
import { ReadFile } from './ReadFile'
import { ReadImage } from './ReadImage'
import { ReadText } from './ReadText'
import { ReadVideo } from './ReadVideo'
import { Sidebar } from './Sidebar'
import { SubscribeToChannel } from './SubscribeToChannel'

type View =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; subscribeURL: string; name: string }
  | { kind: 'subscribing' }
  | { kind: 'channels' }
  | { kind: 'reading'; entry: FeedEntry }
  | { kind: 'bluesky-login'; resumeTo: View; cancelTo: View }

export function Home() {
  const [view, setView] = useState<View>({ kind: 'idle' })
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const myChannels = useAuthStore((s) => s.myChannels)
  const atprotoAgent = useAuthStore((s) => s.atprotoAgent)
  const addToast = useToastStore((s) => s.addToast)

  function copyURL(url: string, label: string) {
    navigator.clipboard.writeText(url)
    addToast(label)
  }

  function gotoCreating() {
    if (useAuthStore.getState().atprotoAgent) {
      setView({ kind: 'creating' })
    } else {
      setView({
        kind: 'bluesky-login',
        resumeTo: { kind: 'creating' },
        cancelTo: view,
      })
    }
  }

  function gotoBlueskyLogin() {
    setView({
      kind: 'bluesky-login',
      resumeTo: { kind: 'idle' },
      cancelTo: view,
    })
  }

  function handlePublished(itemURL: string, title: string) {
    copyURL(itemURL, `Published “${title}” — share URL copied`)
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
    return <ChannelsView onCancel={() => setView({ kind: 'idle' })} />
  }

  if (view.kind === 'reading') {
    const { item, channel } = view.entry
    const onBack = () => setView({ kind: 'idle' })
    const readerProps = { item, channelName: channel.name, onBack }
    if (item.type === 'image') return <ReadImage {...readerProps} />
    if (item.type === 'audio') return <ReadAudio {...readerProps} />
    if (item.type === 'video') return <ReadVideo {...readerProps} />
    if (item.type === 'file') return <ReadFile {...readerProps} />
    if (item.type === 'app') return <ReadApp {...readerProps} />
    return <ReadText {...readerProps} />
  }

  const composerSlot = (() => {
    if (myChannels.length === 0) {
      return (
        <button
          type="button"
          onClick={gotoCreating}
          className="w-full text-left px-4 py-3 border border-neutral-200 rounded-lg bg-white text-sm text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 transition-colors cursor-pointer"
        >
          Create a channel to start publishing →
        </button>
      )
    }
    if (!atprotoAgent) {
      return (
        <button
          type="button"
          onClick={gotoBlueskyLogin}
          className="w-full text-left px-4 py-3 border border-neutral-200 rounded-lg bg-white text-sm text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 transition-colors cursor-pointer"
        >
          Sign in to Bluesky to publish →
        </button>
      )
    }
    return <Compose channels={myChannels} onPublished={handlePublished} />
  })()

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
              onClick={gotoCreating}
              className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors"
            >
              Create a channel
            </button>
          </div>
          {myChannels.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setView({ kind: 'channels' })}
                className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors underline underline-offset-2"
              >
                Your channels ({myChannels.length})
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-6">
      <div className="max-w-5xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        <Sidebar
          onCreate={gotoCreating}
          onSubscribe={() => setView({ kind: 'subscribing' })}
          onSeeAll={() => setView({ kind: 'channels' })}
        />
        <div className="flex-1 lg:max-w-2xl space-y-6 min-w-0">
          {composerSlot}
          <HomeFeed
            onItemClick={(entry) => setView({ kind: 'reading', entry })}
          />
        </div>
      </div>
    </div>
  )
}
