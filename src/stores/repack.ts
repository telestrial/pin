import { create } from 'zustand'

// Tiny store for "background storage work in progress." Two flags so
// the repack runner and orphan sweep can independently signal activity;
// PinSidebar shows the Box indicator if either is active.
type RepackState = {
  running: boolean
  sweeping: boolean
  setRunning: (running: boolean) => void
  setSweeping: (sweeping: boolean) => void
}

export const useRepackStore = create<RepackState>()((set) => ({
  running: false,
  sweeping: false,
  setRunning: (running) => set({ running }),
  setSweeping: (sweeping) => set({ sweeping }),
}))
