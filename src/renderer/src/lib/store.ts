import { create } from 'zustand'
import type { AppSettings } from '@shared/types'

interface SettingsState {
  settings: AppSettings | null
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Record<string, unknown>) => Promise<void>
  overlayVisible: boolean
  setOverlayVisible: (v: boolean) => void
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,
  overlayVisible: false,

  load: async () => {
    const settings = await window.api.getSettings()
    set({ settings, loaded: true })
    window.api.onSettingsChanged((s) => set({ settings: s }))
    window.api.onOverlayVisibility((v) => set({ overlayVisible: v }))
    window.api.overlayIsVisible().then((v) => set({ overlayVisible: v }))
  },

  update: async (patch) => {
    const settings = await window.api.setSettings(patch)
    set({ settings })
  },

  setOverlayVisible: (v) => set({ overlayVisible: v })
}))

export function useOverlaySettings() {
  const settings = useSettings((s) => s.settings)
  return settings?.overlay ?? null
}
