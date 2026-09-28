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

// main 的設定廣播是全視窗單一通道:這裡只需要一條訂閱。
// load() 必須冪等——App 啟動 effect 與 SidebarHotkeyHint 的補載 effect 都會呼叫它
// (React 子組件 effect 先跑),重複註冊會讓同一則廣播被處理多次且數量持續膨脹。
let broadcastBound = false

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,
  overlayVisible: false,

  load: async () => {
    const settings = await window.api.getSettings()
    set({ settings, loaded: true })
    if (!broadcastBound) {
      broadcastBound = true
      window.api.onSettingsChanged((s) => set({ settings: s }))
      window.api.onOverlayVisibility((v) => set({ overlayVisible: v }))
    }
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
