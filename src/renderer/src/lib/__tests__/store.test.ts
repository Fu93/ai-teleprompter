import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 回歸:load() 曾在每次呼叫時重新註冊 onSettingsChanged/onOverlayVisibility listener
 * 且永不解除——App 啟動 effect 與 SidebarHotkeyHint 的補載 effect 都會呼叫它,
 * 每次啟動至少兩條重複訂閱,同一則廣播被處理多次。修復後綁定只發生一次(load 冪等)。
 */
describe('useSettings store 冪等載入', () => {
  let settingsChangedSubs: number
  let visibilitySubs: number
  let pushSettings: ((s: unknown) => void) | null

  beforeEach(async () => {
    vi.resetModules()
    settingsChangedSubs = 0
    visibilitySubs = 0
    pushSettings = null
    ;(globalThis as Record<string, unknown>).window = {
      api: {
        getSettings: async () => ({ overlay: {}, hotkeys: {} }),
        setSettings: async (patch: unknown) => ({ overlay: patch, hotkeys: {} }),
        overlayIsVisible: async () => false,
        onSettingsChanged: (cb: (s: unknown) => void) => {
          settingsChangedSubs += 1
          pushSettings = cb
          return () => undefined
        },
        onOverlayVisibility: () => {
          visibilitySubs += 1
          return () => undefined
        }
      }
    }
  })

  it('load() 被呼叫多次只註冊一條廣播訂閱', async () => {
    const { useSettings } = await import('../store')
    await useSettings.getState().load()
    await useSettings.getState().load()
    await useSettings.getState().load()
    expect(settingsChangedSubs).toBe(1)
    expect(visibilitySubs).toBe(1)
    expect(useSettings.getState().loaded).toBe(true)
  })

  it('廣播到達時 store 同步更新(單一訂閱即可收到)', async () => {
    const { useSettings } = await import('../store')
    await useSettings.getState().load()
    pushSettings?.({ overlay: { rate: 2 }, hotkeys: {} })
    expect((useSettings.getState().settings as unknown as { overlay: { rate: number } }).overlay.rate).toBe(2)
  })
})
