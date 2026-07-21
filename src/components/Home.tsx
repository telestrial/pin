import { useState } from 'react'
import type { FeedEntry } from '../core/feed'
import type { ItemRef } from '../core/types'
import { retractChannel } from '../lib/channelWrites'
import { flushSettingsBestEffort } from '../lib/hooks/useSettingsSync'
import { objectIDsInManifests } from '../lib/scopeRefs'
import { useActionStore } from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { objectIDsReferencedBy, usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { BlueskyLoginScreen } from './auth/BlueskyLoginScreen'
import { Compose } from './Compose'
import { CurateView } from './CurateView'
import { ChannelsView } from './channel/ChannelsView'
import { ChannelView } from './channel/ChannelView'
import { CreateChannel } from './channel/CreateChannel'
import { EditChannel } from './channel/EditChannel'
import { EditProfile } from './EditProfile'
import { HandleDirectory } from './HandleDirectory'
import { HomeFeed } from './HomeFeed'
import { MyStorage } from './MyStorage'
import { PinSidebar } from './pin/PinSidebar'
import { ReadApp } from './read/ReadApp'
import { ReadAudio } from './read/ReadAudio'
import { ReadFile } from './read/ReadFile'
import { ReadImage } from './read/ReadImage'
import { ReadText } from './read/ReadText'
import { ReadVideo } from './read/ReadVideo'
import { SettingsView } from './SettingsView'
import { Sidebar } from './Sidebar'
import { SubscribeToChannel } from './SubscribeToChannel'
import { FormCard } from './ui/FormCard'

type View =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; subscribeURL: string; name: string }
  | { kind: 'subscribing' }
  | { kind: 'channels' }
  | {
      kind: 'viewing-channel'
      authorHandle: string
      channelID: string
    }
  | {
      kind: 'editing-channel'
      channelID: string
      channelKey: string
      returnTo: View
    }
  | {
      kind: 'editing-post'
      item: ItemRef
      channelID: string
      returnTo: View
    }
  | { kind: 'settings' }
  | { kind: 'curate' }
  | { kind: 'reading'; entry: FeedEntry; returnTo: View }
  | { kind: 'bluesky-login'; resumeTo: View; cancelTo: View }
  | { kind: 'storage'; returnTo: View }
  // returnTo is OPTIONAL — sidebar's My Profile sets it undefined (primary
  // nav, no Back), @handle clicks set it to the calling view (contextual
  // nav, Back returns to that view).
  | { kind: 'handle-directory'; handle: string; returnTo?: View }
  | { kind: 'editing-profile'; returnTo: View }

export function Home() {
  const [view, setView] = useState<View>({ kind: 'idle' })
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const myChannels = useAuthStore((s) => s.myChannels)
  const atprotoAgent = useAuthStore((s) => s.atprotoAgent)
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const settingsLoaded = useAuthStore((s) => s.settingsLoaded)
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

  function renderSidebar(activeChannelID?: string, activeHome = false) {
    // The directory page for your own did:dht is what My Profile points
    // at — same view as clicking your identity anywhere else in the app,
    // resolved off atproto via your identity-doc. returnTo is captured from
    // the live `view` closure so Back retraces to wherever the user opened
    // the sidebar from.
    const activeProfile =
      view.kind === 'handle-directory' && view.handle === myDidDht
    return (
      <Sidebar
        onHome={() => setView({ kind: 'idle' })}
        onProfile={
          myDidDht
            ? () =>
                // Primary nav: no returnTo → no Back on the profile.
                // The sidebar IS the way back.
                setView({
                  kind: 'handle-directory',
                  handle: myDidDht,
                })
            : undefined
        }
        onCurate={() => setView({ kind: 'curate' })}
        onSettings={() => setView({ kind: 'settings' })}
        onCreate={gotoCreating}
        onSubscribe={() => setView({ kind: 'subscribing' })}
        onSeeAll={() => setView({ kind: 'channels' })}
        onChannelClick={(authorHandle, channelID) =>
          setView({
            kind: 'viewing-channel',
            authorHandle,
            channelID,
          })
        }
        activeHome={activeHome}
        activeProfile={activeProfile}
        activeCurate={view.kind === 'curate'}
        activeSettings={view.kind === 'settings'}
        activeChannelID={activeChannelID}
      />
    )
  }

  function renderPinSidebar() {
    return (
      <PinSidebar
        onItemClick={(ref) =>
          setView({
            kind: 'reading',
            entry: { item: ref.item, channel: ref.channel },
            returnTo: { kind: 'idle' },
          })
        }
        onStorageClick={() => setView({ kind: 'storage', returnTo: view })}
      />
    )
  }

  if (view.kind === 'bluesky-login') {
    // No onSignedIn — sign-in redirects out and comes back through App.tsx's
    // OAuth init effect, which hydrates the store. The user lands on the
    // home view after the round-trip; resumeTo is no longer plumbed.
    return (
      <BlueskyLoginScreen
        onCancel={() => setView(view.cancelTo)}
        sidebar={renderSidebar()}
        rightSidebar={renderPinSidebar()}
      />
    )
  }

  if (view.kind === 'storage') {
    const returnTo = view.returnTo
    const storageView = view
    return (
      <MyStorage
        sidebar={renderSidebar()}
        rightSidebar={renderPinSidebar()}
        onClose={() => setView(returnTo)}
        onItemClick={(ref) =>
          setView({
            kind: 'reading',
            entry: { item: ref.item, channel: ref.channel },
            returnTo: storageView,
          })
        }
        onChannelClick={(authorHandle, channelID) =>
          setView({ kind: 'viewing-channel', authorHandle, channelID })
        }
        onHandleClick={(handle) =>
          setView({ kind: 'handle-directory', handle, returnTo: storageView })
        }
      />
    )
  }

  if (view.kind === 'handle-directory') {
    const returnTo = view.returnTo
    const directoryView = view
    return (
      <HandleDirectory
        handle={view.handle}
        onBack={returnTo ? () => setView(returnTo) : undefined}
        onChannelClick={(authorHandle, channelID) =>
          setView({
            kind: 'viewing-channel',
            authorHandle,
            channelID,
          })
        }
        onHandleClick={(handle) =>
          setView({
            kind: 'handle-directory',
            handle,
            returnTo: directoryView,
          })
        }
        onEditProfile={() => {
          // Profile edit writes a record under the user's DID — needs a
          // live Bluesky session. Same gate pattern as gotoCreating: if
          // the agent isn't live (scope-expansion re-consent pending,
          // session not restored, etc.), route through bluesky-login
          // first and resume to the edit view after sign-in.
          if (useAuthStore.getState().atprotoAgent) {
            setView({ kind: 'editing-profile', returnTo: directoryView })
          } else {
            setView({
              kind: 'bluesky-login',
              resumeTo: { kind: 'editing-profile', returnTo: directoryView },
              cancelTo: directoryView,
            })
          }
        }}
        onCreate={gotoCreating}
        sidebar={renderSidebar()}
        rightSidebar={renderPinSidebar()}
      />
    )
  }

  if (view.kind === 'editing-profile') {
    const returnTo = view.returnTo
    return (
      <EditProfile
        onCancel={() => setView(returnTo)}
        onSaved={() => {
          addToast('Profile saved')
          setView(returnTo)
        }}
        sidebar={renderSidebar()}
        rightSidebar={renderPinSidebar()}
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
        sidebar={renderSidebar()}
        rightSidebar={renderPinSidebar()}
      />
    )
  }

  if (view.kind === 'created') {
    return (
      <FormCard sidebar={renderSidebar()} rightSidebar={renderPinSidebar()}>
        <div className="text-center space-y-5">
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
      </FormCard>
    )
  }

  if (view.kind === 'settings') {
    return (
      <FormCard
        onBack={() => setView({ kind: 'idle' })}
        sidebar={renderSidebar()}
        rightSidebar={renderPinSidebar()}
      >
        <SettingsView />
      </FormCard>
    )
  }

  if (view.kind === 'curate') {
    return (
      <FormCard
        onBack={() => setView({ kind: 'idle' })}
        sidebar={renderSidebar()}
        rightSidebar={renderPinSidebar()}
      >
        <CurateView />
      </FormCard>
    )
  }

  if (view.kind === 'subscribing') {
    return (
      <SubscribeToChannel
        onCancel={() => setView({ kind: 'idle' })}
        onSubscribed={() => setView({ kind: 'idle' })}
        sidebar={renderSidebar()}
        rightSidebar={renderPinSidebar()}
      />
    )
  }

  if (view.kind === 'channels') {
    return (
      <ChannelsView
        onCancel={() => setView({ kind: 'idle' })}
        onChannelClick={(authorHandle, channelID) =>
          setView({
            kind: 'viewing-channel',
            authorHandle,
            channelID,
          })
        }
        onHandleClick={(handle) =>
          setView({
            kind: 'handle-directory',
            handle,
            returnTo: { kind: 'channels' },
          })
        }
        onUnsubscribe={async (channelID, name) => {
          if (
            !window.confirm(
              `Unsubscribe from "${name}"? Items already pinned to your storage stay where they are.`,
            )
          )
            return
          useAuthStore.getState().removeSubscription(channelID)
          useFeedStore.getState().removeChannel(channelID)
          await flushSettingsBestEffort()
          addToast(`Unsubscribed from "${name}"`)
        }}
        sidebar={renderSidebar()}
        rightSidebar={renderPinSidebar()}
      />
    )
  }

  if (view.kind === 'viewing-channel') {
    const channelView = view
    const owned = myChannels.find((c) => c.channelID === view.channelID)
    const channelComposerSlot = owned ? (
      atprotoAgent ? (
        <Compose channels={[owned]} />
      ) : (
        <button
          type="button"
          onClick={gotoBlueskyLogin}
          className="w-full text-left px-4 py-3 border border-neutral-200 rounded-lg bg-white text-sm text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 transition-colors cursor-pointer"
        >
          Sign in to Bluesky to publish →
        </button>
      )
    ) : undefined
    const handleUnpinChannel = async () => {
      const sdk = useAuthStore.getState().sdk
      if (!sdk || !owned) return
      const confirmation = window.prompt(
        'This drops every item in this channel from your storage and stops publishing it. Subscribers who pinned individual items keep their copies; their share URLs keep working.\n\nType DELETE to confirm.',
      )
      if (confirmation !== 'DELETE') return
      try {
        // Reference-safe: protect bytes still held by your other channels'
        // manifests or any pin so the retract doesn't yank them.
        const protectedIDs = new Set([
          ...objectIDsInManifests(
            useFeedStore.getState().manifests,
            owned.channelID,
          ),
          ...objectIDsReferencedBy(usePinStore.getState().pinned),
        ])
        // Enumerates the channel's byte objects (incl. its Sia manifest object),
        // clears the locator pointer, and drops the channel from the feed. The
        // pkarr record expires by TTL once we stop republishing it.
        const { objectIDs, urls } = await retractChannel(
          sdk,
          owned,
          protectedIDs,
        )
        useAuthStore.getState().removeMyChannel(owned.channelID)
        useAuthStore.getState().removeSubscription(owned.channelID)
        // The removal is durable once it reaches the PDS settings record.
        // Flush now (awaited) so the retract is durable when we report it done,
        // rather than relying on a background save a reload/close could lose.
        await flushSettingsBestEffort()
        // Byte cleanup as a durable, retried journal action — not a
        // fire-and-forget delete a QUIC blip could silently drop.
        useActionStore.getState().enqueueDeleteObjects({
          objectIDs,
          urls,
          label: `Reclaiming “${owned.name}”`,
        })
        usePinStore.getState().refreshAccount(sdk)
        addToast(`Unpinned “${owned.name}”`)
        setView({ kind: 'idle' })
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Failed to unpin channel')
      }
    }
    return (
      <ChannelView
        authorHandle={view.authorHandle}
        channelID={view.channelID}
        onItemClick={(entry) =>
          setView({ kind: 'reading', entry, returnTo: channelView })
        }
        onChannelClick={(authorHandle, channelID) =>
          setView({
            kind: 'viewing-channel',
            authorHandle,
            channelID,
          })
        }
        onHandleClick={(handle) =>
          setView({
            kind: 'handle-directory',
            handle,
            returnTo: channelView,
          })
        }
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
        onUnsubscribe={
          !owned
            ? async () => {
                if (
                  !window.confirm(
                    `Unsubscribe from this channel? Items already pinned to your storage stay where they are.`,
                  )
                )
                  return
                useAuthStore.getState().removeSubscription(view.channelID)
                useFeedStore.getState().removeChannel(view.channelID)
                await flushSettingsBestEffort()
                addToast('Unsubscribed')
                setView({ kind: 'idle' })
              }
            : undefined
        }
        onBack={() => setView({ kind: 'idle' })}
        composerSlot={channelComposerSlot}
        sidebar={renderSidebar(view.channelID)}
        rightSidebar={
          <PinSidebar
            onItemClick={(ref) =>
              setView({
                kind: 'reading',
                entry: { item: ref.item, channel: ref.channel },
                returnTo: channelView,
              })
            }
            onStorageClick={() =>
              setView({ kind: 'storage', returnTo: channelView })
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
        sidebar={renderSidebar(view.channelID)}
        rightSidebar={renderPinSidebar()}
      />
    )
  }

  if (view.kind === 'editing-post') {
    const returnTo = view.returnTo
    const owned = myChannels.find((c) => c.channelID === view.channelID)
    if (!owned) {
      // Channel no longer owned (unpinned mid-flow) — bail back.
      setView(returnTo)
      return null
    }
    return (
      <div className="flex-1 p-6 lg:min-h-0">
        <div className="flex flex-col gap-6 lg:h-full lg:min-h-0 lg:flex-row lg:items-start">
          {renderSidebar(view.channelID)}
          <div className="flex-1 min-w-0 lg:max-h-full lg:overflow-y-auto">
            <Compose
              channels={[owned]}
              editing={{
                item: view.item,
                channelID: view.channelID,
                onCancel: () => setView(returnTo),
              }}
            />
          </div>
          {renderPinSidebar()}
        </div>
      </div>
    )
  }

  if (view.kind === 'reading') {
    const { item, channel } = view.entry
    const returnTo = view.returnTo
    const onBack = () => setView(returnTo)
    const sidebar = renderSidebar(channel.channelID)
    const readingView = view
    // Reading view's right sidebar passes returnTo through unchanged on
    // pinned-item navigation, so clicking a pinned item replaces the current
    // reading view rather than pushing onto the back stack.
    const rightSidebar = (
      <PinSidebar
        onItemClick={(ref) =>
          setView({
            kind: 'reading',
            entry: { item: ref.item, channel: ref.channel },
            returnTo: view.returnTo,
          })
        }
        onStorageClick={() =>
          setView({ kind: 'storage', returnTo: readingView })
        }
      />
    )
    const backLabel =
      view.returnTo.kind === 'viewing-channel'
        ? `Back to ${channel.name}`
        : view.returnTo.kind === 'storage'
          ? 'Back to My Storage'
          : 'Back to feed'
    const ownedForEdit = myChannels.find(
      (c) => c.channelID === channel.channelID,
    )
    // Edit is owner-only and post-only (channels are post-only; non-text
    // legacy items wouldn't go through the same machinery).
    const onEdit =
      ownedForEdit && item.type === 'text'
        ? () => {
            if (!useAuthStore.getState().atprotoAgent) {
              gotoBlueskyLogin()
              return
            }
            setView({
              kind: 'editing-post',
              item,
              channelID: channel.channelID,
              returnTo: readingView,
            })
          }
        : undefined
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
      onEdit,
    }
    if (item.type === 'image') return <ReadImage {...readerProps} />
    if (item.type === 'audio') return <ReadAudio {...readerProps} />
    if (item.type === 'video') return <ReadVideo {...readerProps} />
    if (item.type === 'file') return <ReadFile {...readerProps} />
    if (item.type === 'app') return <ReadApp {...readerProps} />
    return (
      <ReadText
        {...readerProps}
        onHandleClick={(handle) =>
          setView({ kind: 'handle-directory', handle, returnTo: readingView })
        }
      />
    )
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

  if (
    !settingsLoaded &&
    subscriptions.length === 0 &&
    myChannels.length === 0
  ) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-3">
          <div className="inline-flex items-center gap-2 text-neutral-500 text-sm">
            <span className="size-2 rounded-full bg-green-500 animate-pulse" />
            Restoring your channels from Sia…
          </div>
          <p className="text-neutral-400 text-xs">
            Pulling your settings from Sia. Should only take a moment.
          </p>
        </div>
      </div>
    )
  }

  if (subscriptions.length === 0) {
    return (
      <FormCard
        sidebar={renderSidebar(undefined, true)}
        rightSidebar={renderPinSidebar()}
      >
        <div className="text-center space-y-6">
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
      </FormCard>
    )
  }

  const idleView = view as Extract<View, { kind: 'idle' }>

  return (
    <div className="flex-1 p-6 lg:min-h-0">
      <div className="flex flex-col gap-6 lg:h-full lg:min-h-0 lg:flex-row lg:items-start">
        {renderSidebar(undefined, true)}
        <div className="flex-1 space-y-6 min-w-0 lg:max-h-full lg:overflow-y-auto">
          {composerSlot}
          <HomeFeed
            onItemClick={(entry) =>
              setView({ kind: 'reading', entry, returnTo: idleView })
            }
            onChannelClick={(authorHandle, channelID) =>
              setView({
                kind: 'viewing-channel',
                authorHandle,
                channelID,
              })
            }
            onHandleClick={(handle) =>
              setView({
                kind: 'handle-directory',
                handle,
                returnTo: idleView,
              })
            }
            onErrorClick={() => setView({ kind: 'channels' })}
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
          onStorageClick={() =>
            setView({ kind: 'storage', returnTo: idleView })
          }
        />
      </div>
    </div>
  )
}
