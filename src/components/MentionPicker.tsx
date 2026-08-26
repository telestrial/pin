import type { ReachablePerson } from '../core/network'

// The list of people an `@` offers, wherever it is being typed.
//
// Its own file because two composers show it — a post's and a comment's — and a picker that
// looked or behaved differently in one of them would be the same mention surface with two
// answers. Fed by `useMentionBox`, which owns what an `@` DOES; this only draws it.

export function MentionPicker({
  candidates,
  loading,
  activeIndex,
  onPick,
}: {
  candidates: ReachablePerson[]
  loading: boolean
  activeIndex: number
  onPick: (person: ReachablePerson) => void
}) {
  if (candidates.length === 0) {
    return (
      <div className="mt-2 border border-neutral-200 rounded-lg bg-white p-3 text-xs text-neutral-500">
        {loading
          ? 'Searching your network…'
          : 'No one in your network matches.'}
      </div>
    )
  }
  return (
    <div
      role="listbox"
      className="mt-2 border border-neutral-200 rounded-lg bg-white py-1 max-h-64 overflow-y-auto shadow-sm"
    >
      {candidates.map((p, i) => {
        const name = p.username || p.handle
        const active = i === activeIndex
        return (
          <button
            key={p.did}
            type="button"
            role="option"
            aria-selected={active}
            // mousedown (not click) so selection fires before the textarea
            // blur, keeping focus/caret handling clean; preventDefault stops
            // the blur entirely.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(p)
            }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer ${
              active ? 'bg-neutral-100' : 'hover:bg-neutral-50'
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-neutral-900">
              @{name}
              {p.username && (
                <span className="text-neutral-400"> · {p.handle}</span>
              )}
            </span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-400">
              {p.distance === 0 ? 'following' : 'network'}
            </span>
          </button>
        )
      })}
    </div>
  )
}
