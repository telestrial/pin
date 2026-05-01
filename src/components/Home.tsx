import { useState } from 'react'
import type { FeedEntry } from '../core/feed'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { BlueskyLoginScreen } from './BlueskyLoginScreen'
import { ChannelsView } from './ChannelsView'
import { ChannelView } from './ChannelView'
import { Compose } from './Compose'
import { CreateChannel } from './CreateChannel'
import { EditChannel } from './EditChannel'
import type { TypeFilter } from './FilterPills'
import { HomeFeed } from './HomeFeed'
import { ReadApp } from './ReadApp'
import { ReadAudio } from './ReadAudio'
import { ReadFile } from './ReadFile'
import { ReadImage } from './ReadImage'
import { ReadText } from './ReadText'
import { ReadVideo } from './ReadVideo'
import { PinSidebar } from './PinSidebar'
import { Sidebar } from './Sidebar'
import { SubscribeToChannel } from './SubscribeToChannel'

type View =
  | { kind: 'idle'; filter: TypeFilter }
  | { kind: 'creating' }
  | { kind: 'created'; subscribeURL: string; name: string }
  | { kind: 'subscribing' }
  | { kind: 'channels' }
  | {
      kind: 'viewing-channel'
      authorHandle: string
      channelID: string
      filter: TypeFilter
    }
  | {
      kind: 'editing-channel'
      channelID: string
      channelKey: string
      returnTo: View
    }
  | { kind: 'reading'; entry: FeedEntry; returnTo: View }
  | { kind: 'bluesky-login'; resumeTo: View; cancelTo: View }

export function Home() {
  const [view, setView] = useState<View>({ kind: 'idle', filter: 'all' })
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
      resumeTo: { kind: 'idle', filter: 'all' },
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
        onCancel={() => setView({ kind: 'idle', filter: 'all' })}
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
              onClick={() => setView({ kind: 'idle', filter: 'all' })}
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
        onCancel={() => setView({ kind: 'idle', filter: 'all' })}
        onSubscribed={() => setView({ kind: 'idle', filter: 'all' })}
      />
    )
  }

  if (view.kind === 'channels') {
    return (
      <ChannelsView
        onCancel={() => setView({ kind: 'idle', filter: 'all' })}
        onChannelClick={(authorHandle, channelID) =>
          setView({
            kind: 'viewing-channel',
            authorHandle,
            channelID,
            filter: 'all',
          })
        }
      />
    )
  }

  if (view.kind === 'viewing-channel') {
    const channelView = view
    const owned = myChannels.find((c) => c.channelID === view.channelID)
    return (
      <ChannelView
        authorHandle={view.authorHandle}
        channelID={view.channelID}
        filter={view.filter}
        onFilterChange={(filter) => setView({ ...channelView, filter })}
        onItemClick={(entry) =>
          setView({ kind: 'reading', entry, returnTo: channelView })
        }
        onChannelClick={(authorHandle, channelID) =>
          setView({
            kind: 'viewing-channel',
            authorHandle,
            channelID,
            filter: 'all',
          })
        }
        onHome={() => setView({ kind: 'idle', filter: 'all' })}
        onCreate={gotoCreating}
        onSubscribe={() => setView({ kind: 'subscribing' })}
        onSeeAll={() => setView({ kind: 'channels' })}
        onEdit={
          owned
            ? () =>
                setView({
                  kind: 'editing-channel',
                  channelID: owned.channelID,
                  channelKey: owned.channelKey,
                  returnTo: channelView,
                })
            : undefined
        }
        onBack={() => setView({ kind: 'idle', filter: 'all' })}
        rightSidebar={
          <PinSidebar
            onItemClick={(ref) =>
              setView({
                kind: 'reading',
                entry: { item: ref.item, channel: ref.channel },
                returnTo: channelView,
              })
            }
          />
        }
      />
    )
  }

  if (view.kind === 'editing-channel') {
    const returnTo = view.returnTo
    return (
      <EditChannel
        channelID={view.channelID}
        channelKey={view.channelKey}
        onCancel={() => setView(returnTo)}
        onSaved={(name) => {
          addToast(`Channel “${name}” updated`)
          setView(returnTo)
        }}
      />
    )
  }

  if (view.kind === 'reading') {
    const { item, channel } = view.entry
    const returnTo = view.returnTo
    const onBack = () => setView(returnTo)
    const sidebar = (
      <Sidebar
        onHome={() => setView({ kind: 'idle', filter: 'all' })}
        onCreate={gotoCreating}
        onSubscribe={() => setView({ kind: 'subscribing' })}
        onSeeAll={() => setView({ kind: 'channels' })}
        onChannelClick={(authorHandle, channelID) =>
          setView({
            kind: 'viewing-channel',
            authorHandle,
            channelID,
            filter: 'all',
          })
        }
        activeChannelID={channel.channelID}
      />
    )
    const readingView = view
    const rightSidebar = (
      <PinSidebar
        onItemClick={(ref) =>
          setView({
            kind: 'reading',
            entry: { item: ref.item, channel: ref.channel },
            returnTo: readingView.returnTo,
          })
        }
      />
    )
    const backLabel =
      view.returnTo.kind === 'viewing-channel'
        ? `Back to ${channel.name}`
        : 'Back to feed'
    const readerProps = {
      item,
      channelName: channel.name,
      onBack,
      backLabel,
      sidebar,
      rightSidebar,
      pinInput: {
        item,
        channel: {
          authorHandle: channel.authorHandle,
          channelID: channel.channelID,
          name: channel.name,
        },
      },
    }
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

  const idleView = view as Extract<View, { kind: 'idle' }>

  return (
    <div className="flex-1 p-6">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        <Sidebar
          onHome={() => setView({ kind: 'idle', filter: 'all' })}
          onCreate={gotoCreating}
          onSubscribe={() => setView({ kind: 'subscribing' })}
          onSeeAll={() => setView({ kind: 'channels' })}
          onChannelClick={(authorHandle, channelID) =>
            setView({
              kind: 'viewing-channel',
              authorHandle,
              channelID,
              filter: 'all',
            })
          }
          activeHome={true}
        />
        <div className="flex-1 xl:max-w-2xl space-y-6 min-w-0">
          {composerSlot}
          <HomeFeed
            filter={idleView.filter}
            onFilterChange={(filter) => setView({ ...idleView, filter })}
            onItemClick={(entry) =>
              setView({ kind: 'reading', entry, returnTo: idleView })
            }
            onChannelClick={(authorHandle, channelID) =>
              setView({
                kind: 'viewing-channel',
                authorHandle,
                channelID,
                filter: 'all',
              })
            }
          />
        </div>
        <PinSidebar
          onItemClick={(ref) =>
            setView({
              kind: 'reading',
              entry: { item: ref.item, channel: ref.channel },
              returnTo: idleView,
            })
          }
        />
      </div>
    </div>
  )
}
