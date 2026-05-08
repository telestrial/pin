import { create } from 'zustand'

// Tiny store driven by useRepackRunner. PinSidebar reads `running` to
// decide whether to render the ambient pulsing dot next to "My Storage."
type RepackState = {
  running: boolean
  setRunning: (running: boolean) => void
}

export const useRepackStore = create<RepackState>()((set) => ({
  running: false,
  setRunning: (running) => set({ running }),
}))
