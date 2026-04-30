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

function paletteIndex(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return Math.abs(h) % PALETTE.length
}

function firstLetter(...sources: string[]): string {
  for (const s of sources) {
    const m = s.match(/\p{L}/u)
    if (m) return m[0].toUpperCase()
  }
  return '?'
}

export function ChannelMark({
  channelID,
  channelName,
  authorHandle,
  size = 'md',
}: {
  channelID: string
  channelName: string
  authorHandle: string
  size?: 'md' | 'lg'
}) {
  const [bg, fg] = PALETTE[paletteIndex(channelID)]
  const letter = firstLetter(channelName, authorHandle)
  const sizeClass = size === 'lg' ? 'size-16 text-2xl' : 'size-10 text-sm'
  return (
    <div
      aria-hidden="true"
      style={{ backgroundColor: bg, color: fg }}
      className={`${sizeClass} shrink-0 rounded-full flex items-center justify-center font-semibold select-none`}
    >
      {letter}
    </div>
  )
}
