import { useEffect } from 'react'
import {
  autoWatchAdditions,
  listHandleFollows,
  resolveAutoWatchCandidates,
} from '../../core/handleFollow'
import type { SubscriptionRef } from '../../core/types'
import { useAuthStore } from '../../stores/auth'
import { useToastStore } from '../../stores/toast'
import { flushSettingsBestEffort } from './useSettingsSync'

// Once-guard across StrictMode's double-mount (and any remount), same as
// useGhostReconciliation. New channels a followed person claims mid-session
// are picked up on the next boot; following someone mid-session goes through
// reconcileOneHandle (the button path) for an immediate add.
let reconciled = false

// Add the candidates not already held and not tombstoned, then persist.
// Shared by the boot reconcile and the follow-time reconcile. Returns the
// number actually added.
async function applyAutoWatch(
  candidates: SubscriptionRef[],
): Promise<number> {
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

// Resolve one followed person's claimed channels and auto-Watch the new ones
// immediately. Called at follow time so their voices appear without waiting
// for the next boot. Returns how many were added.
export async function reconcileOneHandle(
  followedDID: string,
): Promise<number> {
  const candidates = await resolveAutoWatchCandidates(followedDID)
  return applyAutoWatch(candidates)
}

// Boot reconcile: walk my handle-follows, resolve each followed person's
// currently-claimed public channels, and auto-Watch any that are new (not
// already held, not explicitly dropped). Additive only — never removes;
// unfollow does removal explicitly (see FollowHandleButton). Gated on
// settings being loaded + my DID known (needed to list my own follows).
export function useHandleFollowReconciliation() {
  const settingsLoaded = useAuthStore((s) => s.settingsLoaded)
  const did = useAuthStore((s) => s.atprotoDID)

  useEffect(() => {
    if (!settingsLoaded || !did || reconciled) return
    reconciled = true

    void (async () => {
      let follows: Awaited<ReturnType<typeof listHandleFollows>>
      try {
        follows = await listHandleFollows(did)
      } catch (e) {
        console.warn('Handle-follow reconciliation failed:', e)
        return
      }
      if (follows.length === 0) return

      // Resolve every followed person's claims, then apply in one pass.
      // A per-person failure resolves to [] and doesn't block the others.
      const resolved = await Promise.all(
        follows.map((f) =>
          resolveAutoWatchCandidates(f.record.subject).catch(() => []),
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
  }, [settingsLoaded, did])
}
