// One number on a header, with its label under it.
//
// Shared because a channel's Followers and a profile's are the same claim at two grains,
// and two components meant to look identical drift into two different answers to one
// question — with neither answer ever being decided.

/** `null` renders as a dash rather than a zero.
 *
 *  A follower count is a scan of the crawl's index and is briefly unknown on every
 *  landing. "0 followers" is a claim about the subject; "not counted yet" is a fact about
 *  this device, and only one of them is worth showing as a number. */
export function Stat({
  value,
  label,
  onClick,
  expanded,
}: {
  value: number | null
  label: string
  /** When given, the number opens whatever list stands behind it. */
  onClick?: () => void
  /** Whether that list is open, for the control's expanded state. */
  expanded?: boolean
}) {
  const body = (
    <>
      <div className="text-2xl font-bold text-neutral-900">{value ?? '—'}</div>
      <div className="text-xs text-neutral-500 uppercase tracking-wide">
        {label}
      </div>
    </>
  )
  if (!onClick) return <div className="shrink-0 leading-tight">{body}</div>
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="shrink-0 leading-tight text-left rounded-md -mx-1 px-1 hover:bg-neutral-50 cursor-pointer transition-colors"
    >
      {body}
    </button>
  )
}
