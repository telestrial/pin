import { create } from 'zustand'

// Tiny store for "background storage work in progress." Multiple flags so
// each runner can independently signal activity; PinSidebar shows the Box
// indicator if any are active.
type StorageActivityState = {
  running: boolean
  sweeping: boolean
  savingSettings: boolean
  setRunning: (running: boolean) => void
  setSweeping: (sweeping: boolean) => void
  setSavingSettings: (savingSettings: boolean) => void
}

export const useStorageActivityStore = create<StorageActivityState>()(
  (set) => ({
    running: false,
    sweeping: false,
    savingSettings: false,
    setRunning: (running) => set({ running }),
    setSweeping: (sweeping) => set({ sweeping }),
    setSavingSettings: (savingSettings) => set({ savingSettings }),
  }),
)
