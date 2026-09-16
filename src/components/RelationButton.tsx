import { useState } from 'react'

/** The pill a relation toggles on: Follow, Watch, and whatever comes next.
 *
 *  One component because they are one shape — a label, an on state, and a busy state
 *  while the side-effect lands — and two that were meant to look alike drift into two
 *  answers to a question nobody asked. Which is exactly what happened the first time
 *  Follow was built: it got a busy state and a colour, and the only other relation in the
 *  app had no button at all.
 *
 *  IT OWNS THE BUSY STATE, and that is the whole reason the label can be right. Every
 *  relation toggles its store SYNCHRONOUSLY and then awaits the slow half, so by the time
 *  anything renders, `active` already describes the destination rather than where you came
 *  from — and a busy label derived from it says "Unfollowing…" while it follows you. The
 *  intent is knowable only at the click, so it is captured there and held; deriving it
 *  from state that has already moved is what was wrong, and doing that in each caller is
 *  how both buttons had the bug.
 *
 *  `tone` is the one real difference between the relations, and it carries meaning rather
 *  than decoration: PUBLIC is green — the brand colour, the same one a pin lights up in —
 *  because it is a claim other people can read. PRIVATE is neutral, because it says
 *  nothing to anybody. The axis the colour tracks is the axis the relations differ on. */
export function RelationButton({
  onLabel,
  offLabel,
  turningOnLabel,
  turningOffLabel,
  active,
  tone,
  onClick,
}: {
  /** What it says while the relation holds, e.g. "Following". */
  onLabel: string
  /** What it says while it does not, e.g. "Follow". */
  offLabel: string
  /** While it is being taken on, e.g. "Following…". */
  turningOnLabel: string
  /** While it is being dropped, e.g. "Unfollowing…". */
  turningOffLabel: string
  active: boolean
  tone: 'public' | 'private'
  onClick: () => Promise<void> | void
}) {
  const [pending, setPending] = useState<'on' | 'off' | null>(null)

  async function handleClick() {
    if (pending) return
    // Read BEFORE the handler runs, because the handler is what moves it.
    setPending(active ? 'off' : 'on')
    try {
      await onClick()
    } finally {
      setPending(null)
    }
  }

  const base =
    'inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer disabled:opacity-60'
  const on =
    tone === 'public'
      ? 'text-white bg-green-600 hover:bg-green-700'
      : 'text-white bg-neutral-700 hover:bg-neutral-800'
  const off =
    tone === 'public'
      ? 'text-neutral-700 hover:text-white bg-neutral-100 hover:bg-green-600'
      : 'text-neutral-700 hover:text-white bg-neutral-100 hover:bg-neutral-700'

  // Styled from `active` rather than from the intent, deliberately: the store has already
  // moved, so the pill wears its destination while the slow half lands. That is the
  // optimistic state reading correctly — it is only the LABEL, which names an action in
  // progress rather than a state, that has to come from the intent.
  const label = pending
    ? pending === 'on'
      ? turningOnLabel
      : turningOffLabel
    : active
      ? onLabel
      : offLabel

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending !== null}
      className={`${base} ${active ? on : off}`}
    >
      {label}
    </button>
  )
}
