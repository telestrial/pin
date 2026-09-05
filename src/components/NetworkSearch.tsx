import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  type ChannelHit,
  label,
  type PersonHit,
  type SearchablePerson,
  searchDirectories,
} from '../core/directorySearch'
import { searchableDirectories } from '../lib/directories'
import { useAuthStore } from '../stores/auth'
import { IdentityAvatar } from './IdentityAvatar'

// Finding somebody, or something to read, in what the crawl has read.
//
// The first way into Pin that is not a link somebody sent you. Everything it offers is
// local — the corpus is the Curator's index, so typing costs no network at all, and what
// is findable is exactly what the crawl has reached. That is the honest limit and it is
// why nothing here reaches for the network on a miss: a name the index does not hold is a
// person the crawl has not got to yet, not a person who does not exist.
//
// The corpus is built once per opening rather than per keystroke: reading the index is one
// doc read per held identity, so a query against the doc would scan the whole thing every
// character.

export function NetworkSearch({
  onPerson,
  onChannel,
}: {
  onPerson: (didDht: string) => void
  onChannel: (didDht: string, channelID: string) => void
}) {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [corpus, setCorpus] = useState<SearchablePerson[] | null>(null)
  const box = useRef<HTMLDivElement>(null)

  // Built when the box opens, and again on each reopening: the crawl writes to the index
  // continuously, so a corpus held for the whole session would go stale in exactly the
  // direction that matters — somebody newly read would stay unfindable.
  useEffect(() => {
    if (!open || !storedKeyHex) return
    let cancelled = false
    searchableDirectories(storedKeyHex).then((held) => {
      if (!cancelled) setCorpus(held)
    })
    return () => {
      cancelled = true
    }
  }, [open, storedKeyHex])

  // A click anywhere else closes it. Pointerdown rather than click so the dropdown is gone
  // before whatever was clicked reacts to being clicked.
  useEffect(() => {
    if (!open) return
    function away(e: PointerEvent) {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const hits = corpus
    ? searchDirectories(query, corpus)
    : { people: [], channels: [] }
  const empty = hits.people.length === 0 && hits.channels.length === 0

  function close() {
    setQuery('')
    setOpen(false)
  }

  return (
    <div ref={box} className="relative w-full max-w-md">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-neutral-400" />
        <input
          type="search"
          value={query}
          placeholder="Search your network"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
          }}
          className="w-full rounded-full border border-neutral-200 bg-neutral-50 py-1.5 pl-8 pr-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:bg-white focus:border-neutral-300 focus:outline-none"
        />
      </div>

      {open && query.trim() !== '' && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1.5 max-h-96 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-sm">
          {corpus === null ? (
            <p className="px-3 py-2 text-xs text-neutral-500">
              Reading your index…
            </p>
          ) : empty ? (
            // Never "no such person". The index holds what the crawl has reached, so a
            // miss is a statement about our own reach and saying otherwise would claim
            // something about the network that nothing here knows.
            <p className="px-3 py-2 text-xs text-neutral-500">
              Nothing in what the Curator has read yet.
            </p>
          ) : (
            <>
              {hits.channels.length > 0 && (
                <Section title="Channels">
                  {hits.channels.map((c) => (
                    <ChannelRow
                      key={`${c.didDht}:${c.channelID}`}
                      hit={c}
                      onPick={() => {
                        close()
                        onChannel(c.didDht, c.channelID)
                      }}
                    />
                  ))}
                </Section>
              )}
              {hits.people.length > 0 && (
                <Section title="People">
                  {hits.people.map((p) => (
                    <PersonRow
                      key={p.didDht}
                      hit={p}
                      onPick={() => {
                        close()
                        onPerson(p.didDht)
                      }}
                    />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Channels lead, because a channel hit carries its K and therefore OPENS, where a person
 *  hit is a page about somebody. */
function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="py-1">
      <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
        {title}
      </div>
      {children}
    </div>
  )
}

function ChannelRow({ hit, onPick }: { hit: ChannelHit; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50 cursor-pointer"
    >
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-900">
        {hit.name}
      </span>
    </button>
  )
}

function PersonRow({ hit, onPick }: { hit: PersonHit; onPick: () => void }) {
  const name = label({ ...hit, didDht: undefined })
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50 cursor-pointer"
    >
      <IdentityAvatar
        didDht={hit.didDht}
        name={name}
        avatarURL={hit.avatarURL}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-900">
        @{name}
      </span>
    </button>
  )
}
