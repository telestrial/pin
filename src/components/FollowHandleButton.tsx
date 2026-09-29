import { useState } from 'react'
import { flushSettingsBestEffort } from '../lib/hooks/useSettingsSync'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

// Follow the whole person (their did:dht), not a single channel. What that gets you is
// their profile feed — the channels they show on their profile, as the crawl last read
// them — so the gesture is the edge alone: nothing is copied into your watches, and an
// unfollow has nothing to sweep. Distinct from the per-channel FollowButton. Rendered on
// another person's did:dht directory (never your own — you can't follow yourself).
export function FollowHandleButton({
  subjectDidDht,
  subjectHandle,
}: {
  subjectDidDht: string
  subjectHandle: string
}) {
  const following = useAuthStore((s) => s.handleFollows.includes(subjectDidDht))
  const addHandleFollow = useAuthStore((s) => s.addHandleFollow)
  const removeHandleFollow = useAuthStore((s) => s.removeHandleFollow)
  const addToast = useToastStore((s) => s.addToast)

  // The edge toggles synchronously; busy covers making it durable.
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      if (following) {
        removeHandleFollow(subjectDidDht)
        await flushSettingsBestEffort()
        addToast(`Unfollowed @${subjectHandle}`)
      } else {
        addHandleFollow(subjectDidDht)
        await flushSettingsBestEffort()
        addToast(`Following @${subjectHandle}`)
      }
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
