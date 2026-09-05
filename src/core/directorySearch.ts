// Finding a person or a channel in what the crawl has read.
//
// The index is the only corpus Pin has that nobody handed you: the crawl walks servers
// pointing at servers and records a directory per identity it reads, so what is searched
// here is the network as this identity has actually seen it. Before this there was no way
// to find a channel at all — you were sent a link or you did not know it existed.
//
// Pure, and over a snapshot rather than the doc. Reading the index costs one doc read per
// held identity, so querying the doc per keystroke would scan the whole thing every
// character; the snapshot is built once and queried many times, which is the only shape
// that makes typing affordable.

/** What a search reads out of one held directory record.
 *
 *  Narrow on purpose, the way a reach walk's view is: the corpus is a name and some names,
 *  and taking whole records would couple this to fields it never reads. */
export type SearchablePerson = {
  didDht: string
  username?: string
  displayName?: string
  avatarURL?: string
  channels: { channelID: string; key: string; name: string }[]
}

/** Somebody the crawl has read, whose own name matched. */
export type PersonHit = {
  didDht: string
  username?: string
  displayName?: string
  avatarURL?: string
  /** Which name it was. Ranking is by provenance, never by a score. */
  matched: 'username' | 'displayName'
}

/** A channel somebody advertises, whose name matched.
 *
 *  Carries `key`, so a hit OPENS: an advertised channel publishes its K, which is what
 *  makes it readable to whoever holds the record it was found in. */
export type ChannelHit = {
  didDht: string
  channelID: string
  key: string
  name: string
}

export type SearchHits = {
  people: PersonHit[]
  channels: ChannelHit[]
}

/** How many of each a query answers with.
 *
 *  A cap rather than a scroll, because the list is a dropdown under a text box and the
 *  answer to "too many matches" is a longer query. */
export const MAX_HITS = 8

/** Everyone and everything held whose name contains `query`.
 *
 *  Case-insensitive substring, and the ordering is provenance rather than a score: a
 *  username match before a display-name match, then by name so the same index answers the
 *  same way twice. Nothing here ranks anybody by anything they did.
 *
 *  A person whose CHANNEL matched is not also a person hit — the channel names them
 *  already, and listing them twice would spend both halves of a small dropdown saying one
 *  thing.
 *
 *  `bio` is deliberately not searched. It is prose, so matching it surfaces people for
 *  words that happen to appear in a sentence about something else, and a search that
 *  answers with people you cannot see why it chose is the opposite of what this is for. */
export function searchDirectories(
  query: string,
  corpus: readonly SearchablePerson[],
  limit = MAX_HITS,
): SearchHits {
  const q = query.trim().toLowerCase()
  if (q === '') return { people: [], channels: [] }

  const people: PersonHit[] = []
  const channels: ChannelHit[] = []

  for (const person of corpus) {
    for (const channel of person.channels) {
      if (channel.name.toLowerCase().includes(q)) {
        channels.push({
          didDht: person.didDht,
          channelID: channel.channelID,
          key: channel.key,
          name: channel.name,
        })
      }
    }
    const matched = person.username?.toLowerCase().includes(q)
      ? 'username'
      : person.displayName?.toLowerCase().includes(q)
        ? 'displayName'
        : null
    if (matched) {
      people.push({
        didDht: person.didDht,
        username: person.username,
        displayName: person.displayName,
        avatarURL: person.avatarURL,
        matched,
      })
    }
  }

  people.sort(
    (a, b) =>
      Number(b.matched === 'username') - Number(a.matched === 'username') ||
      label(a).localeCompare(label(b)) ||
      a.didDht.localeCompare(b.didDht),
  )
  channels.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.didDht.localeCompare(b.didDht) ||
      a.channelID.localeCompare(b.channelID),
  )
  return { people: people.slice(0, limit), channels: channels.slice(0, limit) }
}

/** What a person is sorted and rendered by. */
export function label(person: {
  username?: string
  displayName?: string
  didDht?: string
}): string {
  return person.username ?? person.displayName ?? person.didDht ?? ''
}
