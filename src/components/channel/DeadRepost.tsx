import { Recycle } from 'lucide-react'
import { useState } from 'react'
import type { RepostRef } from '../../core/types'
import { unrepostFromChannel } from '../../lib/channelWrites'
import { type PortalOutcome, targetOf } from '../../lib/repost'
import { useAuthStore } from '../../stores/auth'
import { useToastStore } from '../../stores/toast'

// A portal in your own channel with nothing at the other end.
//
// Only the owner sees this. A reader sees nothing at all, because there is nothing they
// could do about it and every failure looks the same from outside — so a row explaining
// somebody else's absent post would be noise about a stranger's decision. The owner is
// the one person who can act, and the only thing to do is a gesture: dismiss it, which
// takes the portal out of the manifest.
//
// A gesture rather than a background pass, deliberately. A loop that pruned dead portals
// would be writing to your published channel unattended on the strength of a read — the
// shape this codebase has got wrong three times. Here the authority sits where the
// manifest does, and nothing accumulates unseen because the one person who can clear it
// is the one who sees it.

/** What the owner is told, and whether asking again could change it.
 *
 *  The absences differ and the difference is worth showing. A retract is final: the address
 *  carries the post's publish time and a re-publish takes a new one, so nothing will ever
 *  appear there again. An un-advertised channel is access withdrawn rather than content
 *  gone, and advertising is reversible — so that one might simply come back. A comment the
 *  host no longer publishes is reversible too, and for a sharper reason: a comment's address
 *  is derived from who wrote it and when, so nobody can reassign it, and one put back comes
 *  back where it was.
 *
 *  What that last case does NOT say is why. The commenter withdrawing it and the host
 *  declining to publish it are indistinguishable from out here, and guessing between them in
 *  the copy would be inventing a fact. */
function describe(state: PortalOutcome['state']): {
  text: string
  final: boolean
} | null {
  switch (state) {
    case 'deleted':
      return { text: 'The author deleted this post.', final: true }
    case 'unavailable':
      return {
        text: 'The author is no longer sharing this channel.',
        final: false,
      }
    case 'unpublished':
      return {
        text: 'This comment is no longer shown on that post.',
        final: false,
      }
    default:
      // Unreachable says nothing about the post. Showing a tombstone for it would be
      // reporting the network as a decision somebody made.
      return null
  }
}

export function DeadRepost({
  channel,
  repost,
  state,
}: {
  channel: { channelID: string; channelKey: string }
  repost: RepostRef
  state: PortalOutcome['state']
}) {
  const client = useAuthStore((s) => s.client)
  const addToast = useToastStore((s) => s.addToast)
  const [busy, setBusy] = useState(false)

  const said = describe(state)
  if (!said || !client) return null

  const dismiss = async () => {
    if (busy) return
    setBusy(true)
    try {
      await unrepostFromChannel(client, channel, targetOf(repost))
    } catch (e) {
      addToast(
        `Could not remove it: ${e instanceof Error ? e.message : String(e)}`,
      )
      setBusy(false)
    }
    // No success branch: the row goes with the portal it was describing.
  }

  return (
    <li className="py-4 px-2 -mx-2">
      <div className="flex items-start gap-3">
        <div className="size-10 shrink-0 rounded-full bg-neutral-100 flex items-center justify-center">
          <Recycle
            className="size-4 text-neutral-400"
            strokeWidth={1.5}
            aria-hidden
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm text-neutral-500">
            {repost.cachedName
              ? `A post you reposted from ${repost.cachedName} is gone.`
              : 'A post you reposted is gone.'}
          </p>
          <p className="text-xs text-neutral-400">
            {said.text}
            {said.final ? '' : ' It may come back.'}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          disabled={busy}
          className="shrink-0 rounded-full bg-neutral-100 hover:bg-neutral-200 px-2.5 py-1 text-xs text-neutral-700 cursor-pointer disabled:cursor-default disabled:opacity-60"
        >
          {busy ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </li>
  )
}
