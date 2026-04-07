// UI-only state. Anything that touches server data lives in TanStack Query.
// This store is for: sidebar collapsed flag, theme preference (always dark in
// v0 but the slot exists for B.7), modal/dialog stack.

import { create } from 'zustand';

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebar: (collapsed: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebar: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));
