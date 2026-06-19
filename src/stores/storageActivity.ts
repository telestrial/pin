import { create } from 'zustand'

// Tiny store for "background storage work in progress." Multiple flags so
// each runner can independently signal activity; PinSidebar shows the Box
// indicator if any are active.
type StorageActivityState = {
  running: boolean
  savingSettings: boolean
  setRunning: (running: boolean) => void
  setSavingSettings: (savingSettings: boolean) => void
}

export const useStorageActivityStore = create<StorageActivityState>()(
  (set) => ({
    running: false,
    savingSettings: false,
    setRunning: (running) => set({ running }),
    setSavingSettings: (savingSettings) => set({ savingSettings }),
  }),
)
