// One-off recovery helper exposed on window.pinDebug for console use.
// Restores myChannels/subscriptions from a previously-saved recovery.json.
//
// Safe to leave in production — an explicit-action helper, not auto-running.
// Remove later if desired.
//
// (A raw fetch-object-by-id helper used to live here too; it's gone with the
// SiaClient seam — the coarse client intentionally exposes no raw object
// handles, and it targeted a legacy settings-object shape the app no longer
// writes.)

import { useAuthStore } from '../stores/auth'

declare global {
  interface Window {
    pinDebug?: {
      restoreFromRecovery: (recovery: {
        myChannels?: unknown[]
        subscriptions?: unknown[]
      }) => void
    }
  }
}

if (typeof window !== 'undefined') {
  window.pinDebug = {
    restoreFromRecovery(recovery) {
      const store = useAuthStore.getState()
      if (recovery.myChannels && Array.isArray(recovery.myChannels)) {
        for (const ch of recovery.myChannels as Parameters<
          typeof store.addMyChannel
        >[0][]) {
          store.addMyChannel(ch)
        }
      }
      if (recovery.subscriptions && Array.isArray(recovery.subscriptions)) {
        for (const sub of recovery.subscriptions as Parameters<
          typeof store.addSubscription
        >[0][]) {
          store.addSubscription(sub)
        }
      }
      console.log('Restored. Refresh the feed to see channels.')
    },
  }
}
