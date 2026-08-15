import { Heart } from 'lucide-react'
import { useEngagement } from '../../lib/hooks/useEngagement'
import type { PinInput } from '../../stores/pin'
import { PinButton } from '../pin/PinButton'

// The gestures an item carries, and what they add up to.
//
// The pin lives here rather than up in the header, where it sat while it was the only one.
// It is the same gesture it always was — a pin mirrors bytes into your Sia scope, and on
// your OWN post it is a retract — but it now stands beside a count, because a pin is a
// redundancy count before it is a popularity one: publishing makes you pin #1, and the
// number falling to zero would mean nobody is paying to keep the bytes alive.
//
// A count of zero shows nothing. Absent and zero mean the same thing to a reader, and one
// of them is far the more common: most items are unendorsed, and an item whose channel no
// pass has read counts for yet reads identically.

/** A count beside its gesture, or nothing when there is none to show. */
function Count({ n }: { n: number }) {
  if (n === 0) return null
  return <span className="text-xs tabular-nums text-neutral-500">{n}</span>
}

export function EngagementRow({ input }: { input: PinInput }) {
  const { likes, pins, liked, toggleLike, busy } = useEngagement({
    channelID: input.channel.channelID,
    publishedAt: input.item.publishedAt,
    contentHash: input.item.contentHash,
  })

  // The row that contains this is itself a click target for opening the item, so a
  // gesture has to stop there rather than also navigating — the same thing PinButton
  // does with its own click.
  const handleLike = (e: React.MouseEvent) => {
    e.stopPropagation()
    toggleLike()
  }

  return (
    <div className="flex items-center gap-3 -ml-1">
      <div className="flex items-center gap-1">
        <Count n={likes} />
        <button
          type="button"
          onClick={handleLike}
          disabled={busy}
          title={liked ? 'Remove your like' : 'Like'}
          aria-pressed={liked}
          className={`p-1 cursor-pointer transition-all duration-300 disabled:cursor-default disabled:opacity-50 ${
            liked
              ? 'text-rose-500 opacity-80 hover:opacity-100'
              : 'text-neutral-400 hover:text-rose-400'
          }`}
        >
          <Heart
            className="size-5"
            strokeWidth={1.5}
            fill={liked ? 'currentColor' : 'none'}
            aria-hidden="true"
          />
        </button>
      </div>

      <div className="flex items-center gap-1">
        <Count n={pins} />
        <PinButton input={input} />
      </div>
    </div>
  )
}
