import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { notReady, useFeedStore } from '../../stores/feed'
import { makeCachingLocatorReader, makeLocatorReader } from '../channelLocator'

// Channel reads are locator-only (Phase D step 6): when the sdk is present,
// inject a reader that resolves each channel purely via its pkarr locator (→ Sia
// → decrypt with K). This is the App-level wiring seam that keeps the feed store
// off the auth store (auth imports feed, so the reverse would be circular): App
// holds the sdk, builds the reader, injects it. Before the sdk exists (or after
// sign-out) a locator can't be read anyway — fall back to a not-ready reject.
//
// Importing channelLocator pulls pkarr into the bundle, but the wasm only boots on
// the first actual locator resolve (lazy) — a feed refresh.
//
// notReady is shared with the feed store (same identity) so refresh can detect a
// racing boot-time load and skip it rather than flash a not-initialized error.

export function useChannelReader() {
  const client = useAuthStore((s) => s.client)
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)
  // Owned channels resolve fresh (never from the sub/ cache); recompute the reader
  // when the owned SET changes.
  const ownedKey = useAuthStore((s) =>
    s.myChannels
      .map((c) => c.channelID)
      .sort()
      .join(','),
  )

  useEffect(() => {
    const feed = useFeedStore.getState()
    if (!client) {
      feed.setChannelReader(notReady)
      return
    }
    // Resolution-ladder reader: for a subscribed channel, prefer the shared-doc
    // cache (`sub/<channelID>`, kept fresh by useSubscriptionPull) → else resolve
    // via locator + cache back. Owned channels always resolve fresh. Needs the
    // AppKey to open the doc; without it, plain resolve.
    const ownedIDs = new Set(ownedKey ? ownedKey.split(',') : [])
    feed.setChannelReader(
      appKeyHex
        ? makeCachingLocatorReader(client, appKeyHex, ownedIDs)
        : makeLocatorReader(client),
    )
    // HomeFeed's first load fires as a child effect, which React runs BEFORE
    // this App-level parent effect — so on the connect commit it can read with
    // the not-ready placeholder and error out. Now that the reader is live,
    // re-run the load so those reads resolve, rather than sitting on the
    // boot-race error until a manual refresh. Fresh onboarding has no
    // subscriptions, so the guard skips the extra load there.
    const subs = useAuthStore.getState().subscriptions
    if (subs.length > 0) feed.refresh(subs)
    return () => useFeedStore.getState().setChannelReader(notReady)
  }, [client, appKeyHex, ownedKey])
}
