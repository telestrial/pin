import { fetchChannel } from './channels'
import type { ChannelCover, ItemRef, SubscriptionRef } from './types'

export type FeedEntry = {
  item: ItemRef
  channel: {
    authorHandle: string
    channelID: string
    name: string
    coverArt?: ChannelCover
  }
}

export type FeedFetchError = {
  authorHandle: string
  channelID: string
  label?: string
  error: string
}

export type FeedFetchResult = {
  entries: FeedEntry[]
  errors: FeedFetchError[]
}

export async function buildHomeFeed(
  subscriptions: SubscriptionRef[],
): Promise<FeedFetchResult> {
  const settled = await Promise.allSettled(
    subscriptions.map((sub) =>
      fetchChannel(
        sub.authorDID || sub.authorHandle,
        sub.channelID,
        sub.channelKey,
      ),
    ),
  )

  const entries: FeedEntry[] = []
  const errors: FeedFetchError[] = []

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    const sub = subscriptions[i]
    if (result.status === 'fulfilled') {
      const manifest = result.value
      for (const item of manifest.items) {
        entries.push({
          item,
          channel: {
            authorHandle: sub.authorHandle,
            channelID: sub.channelID,
            name: manifest.name,
            coverArt: manifest.coverArt,
          },
        })
      }
    } else {
      errors.push({
        authorHandle: sub.authorHandle,
        channelID: sub.channelID,
        label: sub.label,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      })
    }
  }

  entries.sort((a, b) =>
    a.item.publishedAt < b.item.publishedAt
      ? 1
      : a.item.publishedAt > b.item.publishedAt
        ? -1
        : 0,
  )

  return { entries, errors }
}
