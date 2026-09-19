// ── Command palette store ──
// One boolean, global on purpose: the palette opens from three places that are
// not each other's parents — the Cmd/Ctrl+K accelerator (via the menu action
// channel in AppLayout) and, later, any surface that wants a shortcut. A local
// AppLayout state could not be reached from those.

import { create } from 'zustand'

interface CommandPaletteState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
