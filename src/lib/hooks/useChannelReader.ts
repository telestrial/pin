import { useEffect } from 'react'
import { fetchChannel } from '../../core/channels'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { makeLocatorReader } from '../channelLocator'

// Channel reads are locator-only (Phase D step 6): when the sdk is present,
// inject a reader that resolves each channel purely via its pkarr locator (→ Sia
// → decrypt with K), no atproto fallback. This is the App-level wiring seam that
// keeps the feed store off the auth store (auth imports feed, so the reverse
// would be circular): App holds the sdk, builds the reader, injects it. Before
// the sdk exists (or after sign-out) the feed can't read a locator anyway, so it
// falls back to the store's bootstrap default.
//
// Importing channelLocator pulls pkarr into the bundle, but the wasm only boots on
// the first actual locator resolve (lazy) — a feed refresh.
export function useChannelReader() {
  const sdk = useAuthStore((s) => s.sdk)

  useEffect(() => {
    const setReader = useFeedStore.getState().setChannelReader
    setReader(sdk ? makeLocatorReader(sdk) : fetchChannel)
    return () => setReader(fetchChannel)
  }, [sdk])
}
