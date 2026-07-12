import { useEffect, useState } from 'react'
import {
  followHandle,
  isFollowingHandle,
  unfollowHandle,
} from '../core/handleFollow'
import {
  reconcileOneHandle,
  sweepHandleFollow,
} from '../lib/hooks/useHandleFollowReconciliation'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

// Follow the whole person (their DID), not a single channel. Following
// auto-Watches every public channel they currently claim and tracks new ones
// across boots; unfollowing sweeps all their feeds back out. Distinct from the
// per-channel FollowButton on a channel page. Rendered on another person's
// handle directory (never your own — you can't follow yourself).
export function FollowHandleButton({
  subjectDID,
  subjectHandle,
}: {
  subjectDID: string
  subjectHandle: string
}) {
  const agent = useAuthStore((s) => s.atprotoAgent)
  const myDID = useAuthStore((s) => s.atprotoDID)
  const addToast = useToastStore((s) => s.addToast)

  const [following, setFollowing] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!myDID || myDID === subjectDID) {
      setFollowing(null)
      return
    }
    isFollowingHandle(myDID, subjectDID)
      .then((v) => {
        if (!cancelled) setFollowing(v)
      })
      .catch(() => {
        // Unknown — hide rather than guess wrong (matches FollowButton).
        if (!cancelled) setFollowing(null)
      })
    return () => {
      cancelled = true
    }
  }, [myDID, subjectDID])

  // No session, self, or unknown state → no button.
  if (!agent || !myDID || myDID === subjectDID || following === null)
    return null

  async function handleClick() {
    if (!agent || busy) return
    setBusy(true)
    try {
      if (following) {
        await unfollowHandle(agent, subjectDID)
        setFollowing(false)
        const removed = await sweepHandleFollow(subjectDID).catch(() => 0)
        addToast(
          removed > 0
            ? `Unfollowed @${subjectHandle} · removed ${removed} ${removed === 1 ? 'channel' : 'channels'}`
            : `Unfollowed @${subjectHandle}`,
        )
      } else {
        await followHandle(agent, subjectDID)
        setFollowing(true)
        const added = await reconcileOneHandle(subjectDID).catch(() => 0)
        addToast(
          added > 0
            ? `Following @${subjectHandle} · added ${added} ${added === 1 ? 'channel' : 'channels'}`
            : `Following @${subjectHandle}`,
        )
      }
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const label = busy
    ? following
      ? 'Unfollowing…'
      : 'Following…'
    : following
      ? 'Following'
      : 'Follow'

  // Following = filled green; not-following = neutral pill that greens on
  // hover. Same visual language as the per-channel FollowButton.
  const className = following
    ? 'inline-flex items-center px-2.5 py-1 text-xs font-medium text-white bg-green-600 hover:bg-green-700 rounded-full transition-colors cursor-pointer disabled:opacity-60'
    : 'inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-700 hover:text-white bg-neutral-100 hover:bg-green-600 rounded-full transition-colors cursor-pointer disabled:opacity-60'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={className}
    >
      {label}
    </button>
  )
}
