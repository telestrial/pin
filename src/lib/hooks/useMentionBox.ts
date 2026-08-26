import { useState } from 'react'
import type { ReachablePerson } from '../../core/network'
import type { DraftMention } from '../facets'
import {
  filterMentionCandidates,
  useMentionCandidates,
} from './useMentionCandidates'

// Typing an @-mention into a box, wherever that box is.
//
// The BEHAVIOUR is here and the textarea is not, deliberately. A post's composer and a
// comment's are styled differently on purpose — one is borderless and grows into the page,
// the other is a bordered box at the foot of a thread — and that difference is fine. What is
// not fine is two implementations of what an `@` does, because a mention is only a mention
// by virtue of the DID underneath it: get the anchoring wrong in one of them and it resolves
// to nobody, silently, in whichever surface nobody happened to test.
//
// Mentions are captured in insertion order and resolved to byte-range facets against the
// FINAL body at submit (`buildMentionFacets`), so editing text around one doesn't need
// per-keystroke re-anchoring — and one whose surface the author edited away is simply
// dropped.

/** The `@…` token being typed, if there is one. */
type MentionQuery = { text: string; start: number; end: number }

export type MentionBox = {
  /** Everything picked so far, in insertion order. Hand these to `buildMentionFacets`. */
  mentions: DraftMention[]
  /** Preload, for editing something that already carries facets. */
  setMentions: React.Dispatch<React.SetStateAction<DraftMention[]>>
  /** Drop everything, for a box that has just been submitted. */
  clear: () => void
  /** Call whenever the text or the caret moves. */
  onTextChanged: (value: string, caret: number) => void
  /** Arrow keys, Enter/Tab to pick, Escape to dismiss. Returns true when it handled the
   *  key, so a caller can leave its own handling alone. */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** What the picker should show, or null when no token is open. */
  picker: {
    candidates: ReachablePerson[]
    loading: boolean
    activeIndex: number
    pick: (person: ReachablePerson) => void
  } | null
}

export function useMentionBox({
  value,
  setValue,
  textarea,
  initial,
}: {
  value: string
  setValue: (next: string) => void
  /** The box being typed into, so the caret can be put back after an insertion. */
  textarea: React.RefObject<HTMLTextAreaElement | null>
  /** What the box starts with, for editing something that already carries facets — read
   *  once, so a re-render cannot resurrect a mention the author has since deleted. */
  initial?: () => DraftMention[]
}): MentionBox {
  const {
    candidates,
    loading,
    ensureLoaded: ensureCandidates,
  } = useMentionCandidates()
  const [mentions, setMentions] = useState<DraftMention[]>(
    () => initial?.() ?? [],
  )
  const [query, setQuery] = useState<MentionQuery | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  // A token is an `@` at start-of-string or after whitespace, followed by non-whitespace up
  // to the caret. Opening one lazily loads the candidate pool.
  const onTextChanged = (next: string, caret: number) => {
    const m = next.slice(0, caret).match(/(^|\s)@(\S*)$/)
    if (!m) {
      setQuery(null)
      return
    }
    setQuery({
      text: m[2],
      start: (m.index ?? 0) + m[1].length,
      end: caret,
    })
    setActiveIndex(0)
    ensureCandidates()
  }

  const pick = (person: ReachablePerson) => {
    if (!query) return
    const surface = `@${person.username || person.handle}`
    const inserted = `${surface} `
    const next = value.slice(0, query.start) + inserted + value.slice(query.end)
    const caret = query.start + inserted.length
    setValue(next)
    setMentions((prev) => [
      ...prev,
      { did: person.did, handle: person.handle, surface },
    ])
    setQuery(null)
    // Focus and caret restored after React re-renders with the new value.
    requestAnimationFrame(() => {
      const ta = textarea.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(caret, caret)
      }
    })
  }

  const filtered = query ? filterMentionCandidates(candidates, query.text) : []

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!query) return false
    if (e.key === 'Escape') {
      e.preventDefault()
      setQuery(null)
      return true
    }
    if (filtered.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % filtered.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const chosen = filtered[Math.min(activeIndex, filtered.length - 1)]
      if (chosen) pick(chosen)
      return true
    }
    return false
  }

  return {
    mentions,
    setMentions,
    clear: () => {
      setMentions([])
      setQuery(null)
    },
    onTextChanged,
    onKeyDown,
    picker: query ? { candidates: filtered, loading, activeIndex, pick } : null,
  }
}
