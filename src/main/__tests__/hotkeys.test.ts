import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 為什麼這組測試存在。
 *
 * globalShortcut.register() 在 accelerator 已被其他程式佔住時**回傳 false,
 * 不丗例外**。原來的寫法是整段包在 try/catch 裡,結果是註冊失敗完全靜默:
 * 使用者按了熱鍵沒反應,App 不會說一句話,診斷快照裡也沒有任何線索。
 *
 * 這組測試把「註冊失敗必須被看見」變成契約,而不是靠人記得去檢查回傳值。
 *
 * 同時它也是 e2e 那個 flake 的機制說明:每個測試實例啟動都會註冊 6 個
 * OS 層級的熱鍵,前一個實例還沒完全退出時,後一個就會拿到 false —— 熱鍵
 * 從此不觸發,而測試看到的是「element not found」,完全看不出真正原因。
 */
const registerMock = vi.fn<(acc: string, cb: () => void) => boolean>()
const unregisterAllMock = vi.fn()
/** ipcMain.handle 的實作由測試自己裝,才能攔到「handler 參數有沒有被弄丟」。 */
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  globalShortcut: {
    register: (acc: string, cb: () => void) => registerMock(acc, cb),
    unregisterAll: () => unregisterAllMock()
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn)
    },
    on: vi.fn()
  },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: () => '0.2.0-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: vi.fn(async () => []) },
  dialog: {},
  screen: { getAllDisplays: () => [] },
  // registerIpc() 會呼叫 session.defaultSession.setDisplayMediaRequestHandler。
  // 這組測試要能真的註冊 IPC handler(才能攔到診斷報告的參數有沒有被弄丟),
  // 所以這裡必須給一個可呼叫的 defaultSession。
  session: { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } },
  shell: {}
}))

// windows / liveCoaching 只需要在 import 階段不爆,行為與本組無關
vi.mock('../windows', () => ({
  setOverlayVisible: vi.fn(),
  ensureOverlayOnScreen: vi.fn()
}))
vi.mock('../liveCoaching', () => ({ handlePanic: vi.fn(async () => {}) }))

import { registerHotkeys, registerIpc } from '../ipc'
import { state } from '../state'
import { recentEvents, __resetEventState } from '../events'
import { DEFAULT_SETTINGS } from '@shared/types'

describe('registerHotkeys —— 註冊失敗必須看得見', () => {
  beforeEach(() => {
    registerMock.mockReset()
    unregisterAllMock.mockReset()
    ipcHandlers.clear()
    __resetEventState()
    state.settings = structuredClone(DEFAULT_SETTINGS)
    state.hotkeyConflicts = []
  })

  it('全部註冊成功時,衝突清單是空的', () => {
    registerMock.mockReturnValue(true)
    registerHotkeys()
    expect(state.hotkeyConflicts).toEqual([])
  })

  it('register 回傳 false 時要記下來(這是原本完全漏掉的情況)', () => {
    // 預設全部成功,只有第二個被別的程式佔住
    registerMock.mockReturnValue(true)
    registerMock.mockReturnValueOnce(true).mockReturnValueOnce(false)
    registerHotkeys()
    expect(state.hotkeyConflicts).toHaveLength(1)
    expect(state.hotkeyConflicts[0]).toBe(DEFAULT_SETTINGS.hotkeys.hideOverlay)
  })

  it('六個全部被佔住時六個都要被記下來,不是只記第一個', () => {
    registerMock.mockReturnValue(false)
    registerHotkeys()
    expect(state.hotkeyConflicts).toHaveLength(6)
  })

  it('先 unregisterAll —— 否則同一個實例重複註冊時會自我衝突', () => {
    registerMock.mockReturnValue(true)
    registerHotkeys()
    expect(unregisterAllMock).toHaveBeenCalled()
  })

  it('register 丗例外時也要記下來,而不是讓整組熱鍵中止', () => {
    // 第二個丗例外,後面的仍要繼續註冊 —— 否則一個壞的設定讓其他熱鍵全部失效
    registerMock.mockReturnValue(true)
    registerMock
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error('bad accelerator')
      })
    registerHotkeys()
    expect(state.hotkeyConflicts).toHaveLength(1)
    // 原本的 try/catch 會讓這個 throw 中止整段,後面的熱鍵全部沒註冊
    expect(registerMock.mock.calls.length).toBeGreaterThan(3)
  })

  it('設定為空字串的熱鍵不註冊,也不記成衝突', () => {
    registerMock.mockReturnValue(true)
    state.settings.hotkeys.hideOverlay = ''
    state.settings.hotkeys.panicRescue = ''
    registerHotkeys()
    expect(state.hotkeyConflicts).toEqual([])
    expect(registerMock.mock.calls.map((c) => c[0])).not.toContain('')
  })

  /**
   * 熱鍵衝突必須**進得了事件日誌**,而不只是 state 裡的一個陣列。
   *
   * 理由:state.hotkeyConflicts 只活在這個程序裡,而使用者能拿到的證據
   * 是診斷報告 —— 那是從事件日誌組出來的。所以「記在 state」與「記得到」是
   * 兩件事,而後者才會被使用者看到。
   *
   * 這一組測試寫在補上呼叫端之後:`startup_hotkey_conflict` 這個事件名
   * 在 shared/observability.ts 裡宣告了很久卻沒有任何發射者 ——
   * 一個沒有人發的事件名,與一個不存在的契約長得一模一樣。
   */
  describe('startup_hotkey_conflict 事件', () => {
    it('有衝突時發出事件,數量與 state 一致', () => {
      registerMock.mockReturnValue(false)
      registerHotkeys()
      const ev = recentEvents().filter((e) => e.name === 'startup_hotkey_conflict')
      expect(ev).toHaveLength(1)
      // 數量在 metrics 而不是 fields —— 兩者用途不同:metrics 只放數字。
      expect(ev[0].metrics?.count).toBe(6)
      expect(ev[0].metrics?.total).toBe(6)
      // accelerator 字串完全不出現(理由見下一條)。
      expect(ev[0].fields).toBeUndefined()
    })

    it('全部註冊成功時**不**發事件(沒衝突不是問題,不是新聞)', () => {
      registerMock.mockReturnValue(true)
      registerHotkeys()
      expect(recentEvents().filter((e) => e.name === 'startup_hotkey_conflict')).toHaveLength(0)
    })

    it('事件裡不得出現 accelerator 字串本身', () => {
      // 反向斷言。日誌會隨著「回報問題時附上」而離開這台電腦,
      // 而 accelerator 是使用者自己設定的字串。診斷只需要
      // 「有幾個被佔走 / 總共幾個」兩個數字。
      registerMock.mockReturnValue(false)
      registerHotkeys()
      const text = JSON.stringify(recentEvents())
      expect(text).not.toContain(DEFAULT_SETTINGS.hotkeys.toggleOverlay)
      expect(text).not.toContain(DEFAULT_SETTINGS.hotkeys.hideOverlay)
      expect(text).not.toContain('Alt')
      expect(text).not.toContain('Ctrl')
    })

    it('metrics 進得了記憶體(診斷報告是從記憶體組的)', () => {
      // 釘住本輪修掉的一個真缺陷:metrics 原本只寫進日誌**檔案**、不進記憶體。
      // 後果是「啟動花了 4.2 秒」寫進了檔案,使用者複製報告時卻看不到 ——
      // 而那份報告才是他會貼給我們的東西。
      registerMock.mockReturnValue(false)
      registerHotkeys()
      const ev = recentEvents().find((e) => e.name === 'startup_hotkey_conflict')
      expect(ev?.metrics?.count).toBe(6)
    })
  })

  /**
   * 診斷報告的**呼叫端**必須真的把衝突數傳進去。
   *
   * 為什麼需要這一層:上面那組只證明「給了數字就會寫進報告」,
   * 而真正的缺陷在**呼叫端** —— 它從來不傳,預設值 0。
   *
   * 而 typecheck 抓不到這一類:少傳一個有預設值的選項是完全合法的型別。
   * 實測過 —— 把呼叫端改回 `buildDiagnosticsReport(state.settings)`,
   * `npm run typecheck` 仍然 exit 0。也就是說「報告永遠寫衝突數 0」
   * 這種會讓我們**主動排除**最高頻問題假設的缺陷,型別系統完全看不見。
   *
   * 所以這裡呼叫的是**被註冊的 IPC handler**,不是那個函式本身:
   * 這是唯一能攔到「參數在傳遞途中被弄丟」的位置。
   */
  describe('診斷報告的 IPC handler 必須帶上真實衝突數', () => {
    beforeEach(() => {
      registerIpc()
    })

    it('六個熱鍵全被佔走時,診斷報告說 6 而不是 0', () => {
      registerMock.mockReturnValue(false)
      registerHotkeys()
      const h = ipcHandlers.get('util:diagnostics-report')
      expect(h).toBeTypeOf('function')
      const report = h?.({}, {}) as { settings: Record<string, unknown> }
      expect(report.settings.hotkey_conflict_count).toBe(6)
    })

    it('全部註冊成功時報告裡是 0(這一欄不是壞的,是會變的)', () => {
      registerMock.mockReturnValue(true)
      registerHotkeys()
      const h = ipcHandlers.get('util:diagnostics-report')
      const report = h?.({}, {}) as { settings: Record<string, unknown> }
      expect(report.settings.hotkey_conflict_count).toBe(0)
    })
  })
})