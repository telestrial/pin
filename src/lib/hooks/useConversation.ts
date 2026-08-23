// Reading one post's conversation from a screen.
//
// Its own hook rather than a field on `useEngagement`, for the reason the two live in
// separate records: a feed row wants the count and nothing else, and mounting this per row
// would have every row in a feed reading every comment body in it. A post that has been
// OPENED is where the words are wanted.
//
// Reads the cache the Curator writes and re-reads when it moves, exactly as a count does.
// Both rungs land at one address, so nothing here knows whether what it is reading arrived
// by live sync from the author or off Sia through the floor.

import { useEffect, useState } from 'react'
import { useAuthStore } from '../../stores/auth'
import { type Conversation, readConversation } from '../channelConversations'
import { subscribeDocChanges } from '../docs'
import type { EndorsedItem } from '../engagement'

/** The collection a conversation is cached in. Named here only to filter the change feed;
 *  the addresses themselves come from Rust. */
const THREAD = 'thread'

export function useConversation(item: EndorsedItem): Conversation | null {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const [conversation, setConversation] = useState<Conversation | null>(null)

  // Destructured so the effect depends on the item's identity rather than on the object,
  // which callers rebuild every render.
  const { channelID, publishedAt, attachment } = item

  useEffect(() => {
    if (!storedKeyHex) return
    let cancelled = false

    const refresh = async () => {
      const held = await readConversation(storedKeyHex, {
        channelID,
        publishedAt,
        attachment,
      })
      if (!cancelled) setConversation(held)
    }

    // Subscribed BEFORE the first read, and only once the doc is open — both halves for the
    // reasons `useEngagement` gives: subscribing to an engine that isn't up fails silently,
    // and reading first would drop a write that landed in between.
    let unsub = () => {}
    void (async () => {
      try {
        unsub = subscribeDocChanges(({ collection }) => {
          if (collection && collection !== THREAD) return
          void refresh()
        })
      } catch {
        // No stream: the mount read below still shows what is cached, and the next mount
        // tries again.
      }
      if (!cancelled) void refresh()
    })()

    return () => {
      cancelled = true
      unsub()
    }
  }, [storedKeyHex, channelID, publishedAt, attachment])

  return conversation
}
