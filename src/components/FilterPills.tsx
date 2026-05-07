import type { FeedEntry } from '../core/feed'

export type TypeFilter =
  | 'all'
  | 'post'
  | 'image'
  | 'audio'
  | 'video'
  | 'file'
  | 'app'

const FILTER_ORDER: TypeFilter[] = [
  'all',
  'post',
  'image',
  'audio',
  'video',
  'file',
  'app',
]

export const FILTER_LABEL: Record<TypeFilter, string> = {
  all: 'All',
  post: 'Posts',
  image: 'Images',
  audio: 'Audio',
  video: 'Video',
  file: 'Files',
  app: 'Apps',
}

export function entryFilter(entry: FeedEntry): TypeFilter {
  const { item } = entry
  if (item.type === 'text') return 'post'
  return item.type
}

export function availableFiltersFor(entries: FeedEntry[]): TypeFilter[] {
  const present = new Set<TypeFilter>(['all'])
  for (const e of entries) present.add(entryFilter(e))
  return FILTER_ORDER.filter((f) => present.has(f))
}

export function FilterPills({
  available,
  filter,
  onFilterChange,
}: {
  available: TypeFilter[]
  filter: TypeFilter
  onFilterChange: (filter: TypeFilter) => void
}) {
  if (available.length <= 1) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {available.map((f) => {
        const active = filter === f
        return (
          <button
            key={f}
            type="button"
            onClick={() => onFilterChange(f)}
            className={`px-3 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer ${
              active
                ? 'bg-neutral-900 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900'
            }`}
          >
            {FILTER_LABEL[f]}
          </button>
        )
      })}
    </div>
  )
}
