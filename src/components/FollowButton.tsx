import { useEffect, useState } from 'react'
import { follow, isFollowing, unfollow } from '../core/follow'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

// Renders only for public channels with an active Bluesky session.
// Obscure channels can't be publicly followed without leaking their
// existence via the AT-URI rkey (which derives from K); the caller is
// responsible for gating on visibility before mounting this.
export function FollowButton({
  channelAuthorDID,
  channelID,
  channelName,
}: {
  channelAuthorDID: string
  channelID: string
  channelName: string
}) {
  const agent = useAuthStore((s) => s.atprotoAgent)
  const myDID = useAuthStore((s) => s.atprotoDID)
  const addToast = useToastStore((s) => s.addToast)

  const [following, setFollowing] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!myDID) {
      setFollowing(null)
      return
    }
    isFollowing(myDID, channelAuthorDID, channelID)
      .then((v) => {
        if (!cancelled) setFollowing(v)
      })
      .catch(() => {
        // Network hiccup or unfamiliar error — treat as "unknown" and
        // hide the button rather than guess wrong.
        if (!cancelled) setFollowing(null)
      })
    return () => {
      cancelled = true
    }
  }, [myDID, channelAuthorDID, channelID])

  if (!agent || !myDID || following === null) return null

  async function handleClick() {
    if (!agent || busy) return
    setBusy(true)
    try {
      if (following) {
        await unfollow(agent, channelAuthorDID, channelID)
        setFollowing(false)
        addToast(`Unfollowed “${channelName}”`)
      } else {
        await follow(agent, channelAuthorDID, channelID)
        setFollowing(true)
        addToast(`Following “${channelName}”`)
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

  // Following = filled green (matches the brand-green PinButton-pinned
  // state). Not-following = neutral pill that turns green on hover.
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
