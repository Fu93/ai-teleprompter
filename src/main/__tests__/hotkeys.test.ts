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
 * OS 層級的熱鍵,前一個實例還沒完全退出時,後一個就會拿到 false ——
 * 熱鍵從此不觸發,而測試看到的是「element not found」,完全看不出真正原因。
 */
const registerMock = vi.fn<(acc: string, cb: () => void) => boolean>()
const unregisterAllMock = vi.fn()

vi.mock('electron', () => ({
  globalShortcut: {
    register: (acc: string, cb: () => void) => registerMock(acc, cb),
    unregisterAll: () => unregisterAllMock()
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: {},
  dialog: {},
  screen: {},
  session: {},
  shell: {}
}))

// windows / liveCoaching 只需要在 import 階段不爆,行為與本組無關
vi.mock('../windows', () => ({
  setOverlayVisible: vi.fn(),
  ensureOverlayOnScreen: vi.fn()
}))
vi.mock('../liveCoaching', () => ({ handlePanic: vi.fn(async () => {}) }))

import { registerHotkeys } from '../ipc'
import { state } from '../state'
import { DEFAULT_SETTINGS } from '@shared/types'

describe('registerHotkeys —— 註冊失敗必須看得見', () => {
  beforeEach(() => {
    registerMock.mockReset()
    unregisterAllMock.mockReset()
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
})
