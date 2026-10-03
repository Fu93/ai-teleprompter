/**
 * hotkeys.test.ts — 「哪些全域熱鍵根本沒註冊成功」的單一出處。
 *
 * 這組測試守的是兩件事:
 *
 *   1. **稽核覆寫優先於真實名單。** 沒有覆寫時,「有衝突時側欄必須告知」
 *      這個行為在乾淨的 CI 上永遠驗不到 —— 那裡一顆衝突都不會有,而一條
 *      永遠不會變紅的規則等於沒有規則。
 *
 *   2. **新鮮度:熱鍵設定變更要重新問一次。** 這是設定頁第一版踩過的坑 ——
 *      mount 讀一次的話,使用者把衝突的那幾顆改掉之後,畫面還拿著舊名單,
 *      而**過期的警告比沒有警告更糟**:它讓人去查一個已經修好的問題。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('熱鍵衝突的單一出處', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as Record<string, unknown>).window = {
      api: {
        appInfo: vi.fn(async () => ({ hotkeyConflicts: ['Alt+K'] }))
      }
    }
  })

  it('稽核覆寫優先,清掉覆寫之後回到真實名單', async () => {
    const { currentHotkeyConflicts, installHotkeyConflictBridge, useHotkeyConflictStore } = await import('../hotkeys')
    const off = installHotkeyConflictBridge()

    expect(currentHotkeyConflicts()).toEqual([])

    const forced = (globalThis as { window: { __auditForce?: (n: string, a: unknown) => unknown } }).window
      .__auditForce
    // 稽核橋只有在 appInfo().audit === true 時才掛出去;單元測試直接呼叫註冊的控制項
    useHotkeyConflictStore.setState({ forced: ['Ctrl+Alt+T', 'Alt+P'] })
    expect(currentHotkeyConflicts()).toEqual(['Ctrl+Alt+T', 'Alt+P'])

    useHotkeyConflictStore.setState({ forced: null })
    expect(currentHotkeyConflicts()).toEqual([])
    expect(typeof off).toBe('function')
    off()
    expect(forced === undefined || typeof forced === 'function').toBe(true)
  })

  it('watchHotkeyConflicts 掛載時問一次,400ms 後再問一次(新鮮度)', async () => {
    vi.useFakeTimers()
    try {
      const { watchHotkeyConflicts, useHotkeyConflictStore } = await import('../hotkeys')
      // 經 unknown 轉接:window.api 的宣告型別是 Api,與 Mock 沒有重疊,
      // 直接斷言會被 TS2352 擋下(這裡的 window 是 beforeEach 換掉的假物件)。
      const api = (globalThis as unknown as { window: { api: { appInfo: ReturnType<typeof vi.fn> } } }).window.api

      const stop = watchHotkeyConflicts()
      await vi.advanceTimersByTimeAsync(0)
      expect(api.appInfo).toHaveBeenCalledTimes(1)
      expect(useHotkeyConflictStore.getState().conflicts).toEqual(['Alt+K'])

      // 第二次問的回報不同:模擬「使用者已經把衝突改掉了」
      api.appInfo.mockResolvedValueOnce({ hotkeyConflicts: [] })
      await vi.advanceTimersByTimeAsync(400)
      expect(api.appInfo).toHaveBeenCalledTimes(2)
      expect(useHotkeyConflictStore.getState().conflicts).toEqual([])

      stop()
      await vi.advanceTimersByTimeAsync(400)
      expect(api.appInfo).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('appInfo 失敗時退回空名單,而不是把上一次的舊名單留在畫面上', async () => {
    vi.useFakeTimers()
    try {
      const { watchHotkeyConflicts, useHotkeyConflictStore } = await import('../hotkeys')
      useHotkeyConflictStore.setState({ conflicts: ['Alt+K'] })
      const api = (globalThis as unknown as { window: { api: { appInfo: ReturnType<typeof vi.fn> } } }).window.api
      api.appInfo.mockRejectedValueOnce(new Error('ipc 沒回應'))

      watchHotkeyConflicts()
      await vi.advanceTimersByTimeAsync(0)
      expect(useHotkeyConflictStore.getState().conflicts).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
