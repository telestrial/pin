import { Pin } from 'lucide-react'
import type { ComponentPropsWithoutRef } from 'react'

// Canonical pin glyph. Two render modes:
//
//  - Brand-bare (no `state` prop) — used as a wordmark / glyph in
//    Navbar, AuthShell, Compose's publish/pin affordance. Pass-through
//    around lucide Pin at size-5; accepts arbitrary className for
//    contextual color/sizing.
//
//  - State-aware (`state` prop set) — used in action affordances where
//    the icon expresses a custody state on a specific item:
//      'pinnable' → grey outlined pin (offered, no custody)
//      'pinned'   → green-filled pin (this is yours)
//      'edited'   → grey outlined pin + small green dot at top-right
//                   (you don't own this rendered version, but you own a
//                   previous one — the dot is the "related custody"
//                   modifier)
//    State-aware rendering is fully determined by `state` — additional
//    className / props on the lucide Pin are ignored to keep visuals
//    consistent across surfaces.

export type PinState = 'pinnable' | 'pinned' | 'edited'

type PinIconProps = Omit<
  ComponentPropsWithoutRef<typeof Pin>,
  'size' | 'width' | 'height'
> & {
  state?: PinState
}

export function PinIcon({ state, className = '', ...rest }: PinIconProps) {
  if (state === undefined) {
    return <Pin className={`size-5 ${className}`} {...rest} />
  }
  if (state === 'pinnable') {
    return <Pin className="size-6 text-neutral-400" strokeWidth={1} />
  }
  if (state === 'pinned') {
    return (
      <Pin
        className="size-6 fill-green-600 text-green-600"
        strokeWidth={1}
      />
    )
  }
  return (
    <span className="relative inline-flex">
      <Pin className="size-6 text-neutral-400" strokeWidth={1} />
      <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-green-600 border-2 border-white" />
    </span>
  )
}
