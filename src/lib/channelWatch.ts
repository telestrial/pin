import { useAuthStore } from '../stores/auth'
import { flushSettingsBestEffort } from './hooks/useSettingsSync'
import { resolveIdentityDoc } from './identityDoc'

// Following a CHANNEL watches it.
//
// A `FollowEdge` carries no K, and doesn't need to: a public channel advertises its K in
// its author's directory, so following one resolves that directory and keeps the one
// channel. Following a PERSON is different and needs none of this — it reads their profile
// feed out of the crawl's record of them (see lib/reading.ts), so nothing is copied into
// the watches and nothing has to be swept back out.

/** Watch the ONE channel a channel-follow names. Returns whether it was added. */
export async function watchOneChannel(
  didDht: string,
  channelID: string,
): Promise<boolean> {
  const auth = useAuthStore.getState()
  if (!auth.client) return false
  if (auth.subscriptions.some((s) => s.channelID === channelID)) return false
  const doc = await resolveIdentityDoc(auth.client, didDht).catch(() => null)
  const channel = doc?.channels.find((c) => c.channelID === channelID)
  if (!channel) return false
  useAuthStore.getState().addSubscription({
    authorHandle: '',
    authorDID: '',
    didDht,
    channelID: channel.channelID,
    channelKey: channel.key,
    cachedName: channel.name,
    addedAt: new Date().toISOString(),
  })
  await flushSettingsBestEffort()
  return true
}

/** Drop the one channel an unfollow names. No network: what to drop is named by the
 *  follow being undone. */
export async function unwatchOneChannel(channelID: string): Promise<boolean> {
  const auth = useAuthStore.getState()
  if (!auth.subscriptions.some((s) => s.channelID === channelID)) return false
  // The feed follows the read set (useReading), which still holds this channel if a
  // followed author shows it.
  auth.removeSubscription(channelID)
  await flushSettingsBestEffort()
  return true
}
