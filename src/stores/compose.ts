import { create } from 'zustand'
import type { PinnedItemRef } from './pin'

// Holds the single "armed" item — the pinned-library item the user has
// loaded as a link target for the composer's word-snap-select interaction.
// Click a sidebar pin → toggle. Esc → clear. The composer reads this state
// to drive the warm-sand hover decoration over words; mouseup commits a
// pin.itemLink facet and disarms.
//
// Intentionally minimal: no committed-facet state lives here, no editor
// internals — those belong with the editor instance. This is just the
// shared piece between the sidebar (sender) and the editor (receiver).
type ComposeState = {
  armedItem: PinnedItemRef | null
  arm: (item: PinnedItemRef) => void
  disarm: () => void
  toggle: (item: PinnedItemRef) => void
  isArmed: (itemURL: string) => boolean
}

export const useComposeStore = create<ComposeState>()((set, get) => ({
  armedItem: null,
  arm: (item) => set({ armedItem: item }),
  disarm: () => set({ armedItem: null }),
  toggle: (item) => {
    const current = get().armedItem
    if (current && current.item.itemURL === item.item.itemURL) {
      set({ armedItem: null })
    } else {
      set({ armedItem: item })
    }
  },
  isArmed: (itemURL) => get().armedItem?.item.itemURL === itemURL,
}))
