import { useEffect } from 'react'
import type { FetchChannel } from '../../core/feed'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { makeLocatorReader } from '../channelLocator'

// Channel reads are locator-only (Phase D step 6): when the sdk is present,
// inject a reader that resolves each channel purely via its pkarr locator (→ Sia
// → decrypt with K). This is the App-level wiring seam that keeps the feed store
// off the auth store (auth imports feed, so the reverse would be circular): App
// holds the sdk, builds the reader, injects it. Before the sdk exists (or after
// sign-out) a locator can't be read anyway — fall back to a not-ready reject.
//
// Importing channelLocator pulls pkarr into the bundle, but the wasm only boots on
// the first actual locator resolve (lazy) — a feed refresh.
const notReady: FetchChannel = () =>
  Promise.reject(new Error('channel reader not initialized'))

export function useChannelReader() {
  const sdk = useAuthStore((s) => s.sdk)

  useEffect(() => {
    const setReader = useFeedStore.getState().setChannelReader
    setReader(sdk ? makeLocatorReader(sdk) : notReady)
    return () => setReader(notReady)
  }, [sdk])
}
