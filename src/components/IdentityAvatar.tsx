import { useItemBlobURL } from '../lib/hooks/useItemBytes'

// A PERSON's avatar, as a row shows it.
//
// The counterpart of `ChannelAvatar`, and separate from it because the two answer different
// questions from different records: a channel's picture comes out of its manifest, a
// person's out of their identity-doc profile. Same size, same shape, same hash-derived
// fallback, so a row that swaps one for the other doesn't move.
//
// The mark is keyed on the DID rather than on the name, deliberately. A name is
// self-asserted and mutable — somebody renaming themselves would otherwise change colour —
// where the DID is the identity and never moves.

const PALETTE: [string, string][] = [
  ['#fee2e2', '#991b1b'],
  ['#fed7aa', '#9a3412'],
  ['#fef3c7', '#854d0e'],
  ['#d9f99d', '#3f6212'],
  ['#bbf7d0', '#14532d'],
  ['#a7f3d0', '#065f46'],
  ['#99f6e4', '#115e59'],
  ['#bae6fd', '#075985'],
  ['#bfdbfe', '#1e40af'],
  ['#c7d2fe', '#3730a3'],
  ['#ddd6fe', '#5b21b6'],
  ['#f5d0fe', '#86198f'],
  ['#fbcfe8', '#9d174d'],
]

/** A letter on a colour, derived from the DID so it is stable across renames. */
function Mark({ didDht, name }: { didDht: string; name: string }) {
  let h = 0
  for (let i = 0; i < didDht.length; i++) {
    h = (h * 31 + didDht.charCodeAt(i)) | 0
  }
  const [bg, fg] = PALETTE[Math.abs(h) % PALETTE.length]
  const letter = (name.match(/\p{L}/u)?.[0] ?? '?').toUpperCase()
  return (
    <div
      aria-hidden="true"
      style={{ backgroundColor: bg, color: fg }}
      className="size-10 shrink-0 rounded-full flex items-center justify-center text-sm font-semibold select-none"
    >
      {letter}
    </div>
  )
}

export function IdentityAvatar({
  didDht,
  name,
  avatarURL,
}: {
  didDht: string
  /** What they're called, for the mark's letter. Never for its colour. */
  name: string
  avatarURL?: string
}) {
  // Profile records carry no content hash, so the URL is the cache key. Falls back to the
  // mark on a URL that will not resolve, which is ordinary rather than an error: an avatar
  // lives in its owner's scope and they may have stopped paying for it.
  const { url, error } = useItemBlobURL(
    avatarURL ?? '',
    'image/jpeg', // a Blob hint only; the image element sniffs the real type
    undefined,
  )
  if (!avatarURL || error || !url) return <Mark didDht={didDht} name={name} />
  return (
    <img
      src={url}
      alt=""
      className="size-10 shrink-0 rounded-full object-cover bg-neutral-100"
    />
  )
}
