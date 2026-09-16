/** The pill a relation toggles on: Follow, Watch, and whatever comes next.
 *
 *  One component because they are one shape — a label, an on state, and a busy state
 *  while the side-effect lands — and two that were meant to look alike drift into two
 *  answers to a question nobody asked. Which is exactly what happened the first time
 *  Follow was built: it got a busy state and a colour, and the only other relation in the
 *  app had no button at all.
 *
 *  `tone` is the one real difference, and it carries meaning rather than decoration:
 *  PUBLIC is green — the brand colour, the same one a pin lights up in — because it is a
 *  claim other people can read. PRIVATE is neutral, because it says nothing to anybody.
 *  The axis the colour tracks is the axis the two relations differ on. */
export function RelationButton({
  label,
  busyLabel,
  active,
  busy,
  tone,
  onClick,
}: {
  label: string
  busyLabel: string
  active: boolean
  busy: boolean
  tone: 'public' | 'private'
  onClick: () => void
}) {
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

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`${base} ${active ? on : off}`}
    >
      {busy ? busyLabel : label}
    </button>
  )
}
