import { useState } from 'react'
import {
  reconcileOneHandle,
  sweepHandleFollow,
} from '../lib/hooks/useHandleFollowReconciliation'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

// Follow the whole person (their did:dht), not a single channel. The follow
// state is a synchronous local-store edge (handleFollows), mirrored into the
// identity-doc — no atproto. Following auto-Watches every public channel they
// currently advertise and tracks new ones across boots; unfollowing sweeps all
// their feeds back out. Distinct from the per-channel FollowButton. Rendered on
// another person's did:dht directory (never your own — you can't follow
// yourself).
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

  // The follow edge toggles synchronously (local store); busy covers the async
  // auto-Watch side-effect (resolve their identity-doc + add/sweep channels).
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      if (following) {
        removeHandleFollow(subjectDidDht)
        const removed = await sweepHandleFollow(subjectDidDht).catch(() => 0)
        addToast(
          removed > 0
            ? `Unfollowed @${subjectHandle} · removed ${removed} ${removed === 1 ? 'channel' : 'channels'}`
            : `Unfollowed @${subjectHandle}`,
        )
      } else {
        addHandleFollow(subjectDidDht)
        const added = await reconcileOneHandle(subjectDidDht).catch(() => 0)
        addToast(
          added > 0
            ? `Following @${subjectHandle} · added ${added} ${added === 1 ? 'channel' : 'channels'}`
            : `Following @${subjectHandle}`,
        )
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
