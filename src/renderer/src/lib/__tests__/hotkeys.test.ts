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

/**
 * StrictMode 的掛載 → 清理 → 再掛載。
 *
 * 這個 bug 是 `audit:states` 報出來的 `hotkey-conflict-stale` 的根因:
 * 稽核呼叫 `__auditForce('app.hotkeyConflicts', null)` 想把畫面上的警示清掉,
 * 但那時控制項早已不在 registry 裡 —— 呼叫回 ok,畫面卻紋風不動。
 *
 * 舊實作用一個 `bridgeInstalled` 布林當守門,卻從不設回 false。於是:
 *   第 1 次掛載 → 註冊
 *   清理       → unregister(registry 清空)
 *   第 2 次掛載 → 看到 bridgeInstalled === true,**直接 return,什麼都沒註冊**
 * 而 `main.tsx` 確實包在 `<React.StrictMode>` 裡,開發模式必然走这条路徑。
 */
describe('稽核橋在 StrictMode 的重複掛載後仍然可用', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as Record<string, unknown>).window = {
      api: { appInfo: vi.fn(async () => ({ hotkeyConflicts: [] })) }
    }
  })

  it('掛載 → 清理 → 再掛載:控制項仍在清單裡(舊實作在這裡壞掉)', async () => {
    const hotkeys = await import('../hotkeys')
    const bridge = await import('../auditBridge')

    // 第一次掛載
    const off1 = hotkeys.installHotkeyConflictBridge()
    expect(bridge.listAuditControls()).toContain('app.hotkeyConflicts')

    // 清理(StrictMode 會呼叫)
    off1()
    expect(bridge.listAuditControls()).not.toContain('app.hotkeyConflicts')

    // 第二次掛載 —— 這一格就是缺陷所在
    const off2 = hotkeys.installHotkeyConflictBridge()
    expect(
      bridge.listAuditControls(),
      '第二次掛載後控制項必須重新註冊,否則稽核的強制呼叫會靜默失效'
    ).toContain('app.hotkeyConflicts')

    off2()
  })

  it('稽核的清空呼叫真的作用到 store(不只是回 ok)', async () => {
    const hotkeys = await import('../hotkeys')
    const bridge = await import('../auditBridge')

    const off1 = hotkeys.installHotkeyConflictBridge()
    off1()
    const off2 = hotkeys.installHotkeyConflictBridge()

    const r = (await bridge.forceAuditState('app.hotkeyConflicts', ['Ctrl+Alt+T'])) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(hotkeys.currentHotkeyConflicts()).toEqual(['Ctrl+Alt+T'])

    // 這一格是 audit-states 報的那筆問題的直接對應
    const r2 = (await bridge.forceAuditState('app.hotkeyConflicts', null)) as { ok: boolean }
    expect(r2.ok).toBe(true)
    expect(
      hotkeys.currentHotkeyConflicts(),
      '清空之後畫面上的警示必須真的消失 —— 留著就是讓人去查一個已經修好的問題'
    ).toEqual([])

    off2()
  })

  it('反覆掛載不會累積多份控制項', async () => {
    const hotkeys = await import('../hotkeys')
    const bridge = await import('../auditBridge')
    const offs: Array<() => void> = []
    for (let i = 0; i < 5; i++) offs.push(hotkeys.installHotkeyConflictBridge())
    const count = bridge.listAuditControls().filter((n) => n === 'app.hotkeyConflicts').length
    expect(count).toBe(1)
    offs[offs.length - 1]()
  })
})
