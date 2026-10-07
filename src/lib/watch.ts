import { entriesForChannel } from '../core/feed'
import type { ChannelManifest } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { flushSettingsBestEffort } from './hooks/useSettingsSync'

/** Start watching a channel whose manifest is already in hand.
 *
 *  Watching is the private half of following: it gets you the channel and says nothing in
 *  public. The mechanism under both is a subscription, which is what carries K and what
 *  the pull loop reads — so this is the one place that engages it, rather than each
 *  surface that can start a watch growing its own idea of what starting one means.
 *
 *  Two callers, and they differ only in where the manifest came from: the paste form
 *  fetched it from a URL somebody sent, and the channel page resolved it because you were
 *  looking at the channel. Neither needs a second fetch.
 *
 *  Seeds the feed store from that same manifest. Without it a channel you just started
 *  watching is one the store has nothing for, so the page it is on goes blank until a
 *  refresh lands — visible, and avoidable, since the bytes are right here.
 *
 *  Settings are flushed before this reports done: a reload inside the background debounce
 *  used to drop the subscription entirely, which is the ghost-channel shape. */
export async function startWatching(sub: {
  authorHandle: string
  authorDID?: string
  didDht?: string
  channelID: string
  channelKey: string
  manifest: ChannelManifest
}): Promise<void> {
  const { manifest, ...ref } = sub
  useAuthStore.getState().addSubscription({
    authorHandle: ref.authorHandle,
    authorDID: ref.authorDID ?? manifest.authorATProtoDID ?? '',
    didDht: ref.didDht,
    channelID: ref.channelID,
    channelKey: ref.channelKey,
    cachedName: manifest.name,
    label: manifest.name,
    addedAt: new Date().toISOString(),
  })

  // Through the shared collation rather than a map over `items`, so what a just-watched
  // channel contributes is what it contributes anywhere else. NOT currently observable:
  // no portals are passed, and an unresolved one contributes nothing either way, so the
  // two agree today and no test can tell them apart. It is here so that threading portals
  // through is a change at one call site rather than a rule this file forgot it had.
  const fresh = entriesForChannel(
    {
      authorHandle: ref.authorHandle,
      authorDidDht: ref.didDht,
      channelID: ref.channelID,
      name: manifest.name,
      avatar: manifest.avatar,
    },
    manifest,
  )
  useFeedStore.setState((s) => ({
    entries: [...s.entries, ...fresh],
    manifests: { ...s.manifests, [ref.channelID]: manifest },
  }))

  await flushSettingsBestEffort()
}

/** Start watching a channel that cannot be read yet: a private one this identity has asked
 *  to join. The subscription is what makes an approval a follow without anything else
 *  happening — once the author seats this identity and the Curator climbs to the key, it
 *  is a member that watches, which is what the Curator derives a follow from. Until then
 *  it reads nothing, so there is no manifest to seed the feed with. */
export async function startWatchingByKey(sub: {
  didDht: string
  channelID: string
  channelKey: string
  name?: string
}): Promise<void> {
  useAuthStore.getState().addSubscription({
    authorHandle: '',
    authorDID: '',
    didDht: sub.didDht,
    channelID: sub.channelID,
    channelKey: sub.channelKey,
    cachedName: sub.name,
    label: sub.name,
    addedAt: new Date().toISOString(),
  })
  await flushSettingsBestEffort()
}
