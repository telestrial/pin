import { useEffect } from 'react'
import { autoWatchAdditions, autoWatchRemovals } from '../../core/handleFollow'
import type { SubscriptionRef } from '../../core/types'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { useToastStore } from '../../stores/toast'
import { resolveIdentityDoc } from '../identityDoc'
import { flushSettingsBestEffort } from './useSettingsSync'

// Once-guard across StrictMode's double-mount (and any remount). New channels a
// followed person advertises mid-session are picked up on the next boot;
// following someone mid-session goes through reconcileOneHandle (the button
// path) for an immediate add.
let reconciled = false

// Resolve one followed person's advertised public channels into Watch
// candidates — the iroh path. Their identity-doc's `channels` already bundle
// {channelID, key, name}, so this is a single resolve (no atproto self-claim
// walk + per-channel getChannelRecord). Obscure channels aren't advertised, so
// they're naturally absent → not auto-Watched. cachedName seeds the display;
// the feed refreshes it from the manifest on first load. authorHandle/authorDID
// stay empty — the feed reads these channels via their K-derived locator, not
// by author identity.
async function resolveAutoWatchCandidates(
  followedDidDht: string,
): Promise<SubscriptionRef[]> {
  const client = useAuthStore.getState().client
  if (!client) return []
  const doc = await resolveIdentityDoc(client, followedDidDht).catch(() => null)
  if (!doc) return []
  const addedAt = new Date().toISOString()
  return doc.channels.map((c) => ({
    authorHandle: '',
    authorDID: '',
    didDht: followedDidDht,
    channelID: c.channelID,
    channelKey: c.key,
    cachedName: c.name,
    addedAt,
  }))
}

// Add the candidates not already held and not tombstoned, then persist.
// Shared by the boot reconcile and the follow-time reconcile. Returns the
// number actually added.
async function applyAutoWatch(candidates: SubscriptionRef[]): Promise<number> {
  const auth = useAuthStore.getState()
  const subscribedChannelIDs = new Set(
    auth.subscriptions.map((s) => s.channelID),
  )
  const dismissed = new Set(auth.dismissedAutoWatch)
  const additions = autoWatchAdditions(
    candidates,
    subscribedChannelIDs,
    dismissed,
  )
  if (additions.length === 0) return 0
  for (const sub of additions) auth.addSubscription(sub)
  await flushSettingsBestEffort()
  return additions.length
}

// Resolve one followed person's advertised channels and auto-Watch the new
// ones immediately. Called at follow time so their voices appear without
// waiting for the next boot. Returns how many were added.
export async function reconcileOneHandle(
  followedDidDht: string,
): Promise<number> {
  const candidates = await resolveAutoWatchCandidates(followedDidDht)
  return applyAutoWatch(candidates)
}

// Unfollow sweep: remove all of the unfollowed person's feeds from my Watches.
// "All their feeds" is re-derived live (their currently-advertised public
// channels), matching the literal intent — including a channel I'd also
// subscribed to manually. Clears the tombstones for the swept channels too, so
// a later re-follow re-adds them fresh. Returns how many were removed.
export async function sweepHandleFollow(
  followedDidDht: string,
): Promise<number> {
  const candidates = await resolveAutoWatchCandidates(followedDidDht)
  const claimedIDs = candidates.map((c) => c.channelID)
  if (claimedIDs.length === 0) return 0
  const auth = useAuthStore.getState()
  const subscribedChannelIDs = new Set(
    auth.subscriptions.map((s) => s.channelID),
  )
  const removals = autoWatchRemovals(claimedIDs, subscribedChannelIDs)
  const feed = useFeedStore.getState()
  for (const id of removals) {
    auth.removeSubscription(id) // tombstones it…
    feed.removeChannel(id)
  }
  // Clear tombstones for ALL their advertised channels, not just the ones we
  // removed — a channel you'd earlier unsubscribed (tombstoned, not held) must
  // also clear, so re-following this person later re-adds everything fresh.
  auth.clearDismissedAutoWatch(claimedIDs)
  await flushSettingsBestEffort()
  return removals.length
}

// Boot reconcile: walk my handle-follows (local did:dhts), resolve each
// followed person's currently-advertised public channels, and auto-Watch any
// that are new (not already held, not explicitly dropped). Additive only —
// unfollow does removal explicitly (see FollowHandleButton). Gated on settings
// being loaded + an sdk (needed to resolve identity-docs).
export function useHandleFollowReconciliation() {
  const settingsLoaded = useAuthStore((s) => s.settingsLoaded)
  const client = useAuthStore((s) => s.client)

  useEffect(() => {
    if (!settingsLoaded || !client || reconciled) return
    reconciled = true

    void (async () => {
      const handleFollows = useAuthStore.getState().handleFollows
      if (handleFollows.length === 0) return

      // Resolve every followed person's advertised channels, then apply in one
      // pass. A per-person failure resolves to [] and doesn't block the others.
      const resolved = await Promise.all(
        handleFollows.map((didDht) =>
          resolveAutoWatchCandidates(didDht).catch(() => []),
        ),
      )
      const added = await applyAutoWatch(resolved.flat())
      if (added > 0) {
        useToastStore
          .getState()
          .addToast(
            `Added ${added} new ${added === 1 ? 'channel' : 'channels'} from people you follow`,
          )
      }
    })()
  }, [settingsLoaded, client])
}
