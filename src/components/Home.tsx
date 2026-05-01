import { useState } from 'react'
import { unpinChannel } from '../core/channels'
import type { FeedEntry } from '../core/feed'
import { fetchAccountSnapshot } from '../core/pin'
import type { ItemRef } from '../core/types'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { BlueskyLoginScreen } from './BlueskyLoginScreen'
import { ChannelsView } from './ChannelsView'
import { ChannelView } from './ChannelView'
import { Compose } from './Compose'
import { CreateChannel } from './CreateChannel'
import { EditApp } from './EditApp'
import { EditChannel } from './EditChannel'
import { EditPost } from './EditPost'
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
  | {
      kind: 'editing-post'
      item: ItemRef
      channel: OwnedChannel
      returnTo: View
    }
  | {
      kind: 'editing-app'
      item: ItemRef
      channel: OwnedChannel
      returnTo: View
    }
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
    const channelComposerSlot = owned
      ? atprotoAgent
        ? <Compose channels={[owned]} hideChannel />
        : (
            <button
              type="button"
              onClick={gotoBlueskyLogin}
              className="w-full text-left px-4 py-3 border border-neutral-200 rounded-lg bg-white text-sm text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 transition-colors cursor-pointer"
            >
              Sign in to Bluesky to publish →
            </button>
          )
      : undefined
    const handleUnpinChannel = async () => {
      const sdk = useAuthStore.getState().sdk
      const agent = useAuthStore.getState().atprotoAgent
      if (!sdk || !agent || !owned) return
      const confirmation = window.prompt(
        'This drops every item in this channel from your storage and deletes the channel record. Subscribers who pinned individual items keep their copies; their share URLs keep working.\n\nType DELETE to confirm.',
      )
      if (confirmation !== 'DELETE') return
      try {
        await unpinChannel(sdk, agent, owned)
        useAuthStore.getState().removeMyChannel(owned.channelID)
        useAuthStore.getState().removeSubscription(owned.channelID)
        useFeedStore.getState().removeChannel(owned.channelID)
        fetchAccountSnapshot(sdk)
          .then((account) => usePinStore.setState({ account }))
          .catch(() => {})
        addToast(`Unpinned “${owned.name}”`)
        setView({ kind: 'idle', filter: 'all' })
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Failed to unpin channel')
      }
    }
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
        onUnpin={owned ? handleUnpinChannel : undefined}
        onBack={() => setView({ kind: 'idle', filter: 'all' })}
        composerSlot={channelComposerSlot}
        rightSidebar={
          <PinSidebar
            onItemClick={(ref) =>
              setView({
                kind: 'reading',
                entry: { item: ref.item, channel: ref.channel },
                returnTo: channelView,
              })
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

  if (view.kind === 'editing-post') {
    const returnTo = view.returnTo
    const handleSaved = (newItem: ItemRef) => {
      if (returnTo.kind === 'reading') {
        setView({
          kind: 'reading',
          entry: { item: newItem, channel: returnTo.entry.channel },
          returnTo: returnTo.returnTo,
        })
      } else {
        setView(returnTo)
      }
    }
    return (
      <EditPost
        item={view.item}
        channel={view.channel}
        onCancel={() => setView(returnTo)}
        onSaved={handleSaved}
      />
    )
  }

  if (view.kind === 'editing-app') {
    const returnTo = view.returnTo
    const handleSaved = (newItem: ItemRef) => {
      if (returnTo.kind === 'reading') {
        setView({
          kind: 'reading',
          entry: { item: newItem, channel: returnTo.entry.channel },
          returnTo: returnTo.returnTo,
        })
      } else {
        setView(returnTo)
      }
    }
    return (
      <EditApp
        item={view.item}
        channel={view.channel}
        onCancel={() => setView(returnTo)}
        onSaved={handleSaved}
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
    const ownedChannel = myChannels.find(
      (c) => c.channelID === channel.channelID,
    )
    if (item.type === 'image') return <ReadImage {...readerProps} />
    if (item.type === 'audio') return <ReadAudio {...readerProps} />
    if (item.type === 'video') return <ReadVideo {...readerProps} />
    if (item.type === 'file') return <ReadFile {...readerProps} />
    if (item.type === 'app') {
      const onEditApp = ownedChannel
        ? () =>
            setView({
              kind: 'editing-app',
              item,
              channel: ownedChannel,
              returnTo: readingView,
            })
        : undefined
      return <ReadApp {...readerProps} onEdit={onEditApp} />
    }
    const ownedForPost = item.title !== '' ? ownedChannel : undefined
    const onEditPost = ownedForPost
      ? () =>
          setView({
            kind: 'editing-post',
            item,
            channel: ownedForPost,
            returnTo: readingView,
          })
      : undefined
    return <ReadText {...readerProps} onEdit={onEditPost} />
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
    return <Compose channels={myChannels} />
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
    </div>
  )
}
