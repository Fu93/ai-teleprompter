/**
 * closePromptRace.test.ts — 「確認對話框還沒回答時再按一次 X」不能關掉視窗。
 *
 * 為什麼這組測試存在(這是資料損失級別的缺陷):
 *   close 事件原本的寫法是 `if (!blocker || closePromptPending) return` —— 意思是
 *   「已經在問了就放行」。於是使用者在對話框還開著的時候又按一次 X(或不小心
 *   拖曳視窗標題列再放開觸發一次 close),視窗就**直接關掉了**:未儲存的講稿、
 *   正在錄音的整場會議,全部沒了,而且他連對話框都還沒看到答案。
 *   這個守衛存在的全部目的,被它自己的第二個分支推翻。
 *
 * 為什麼要真的建立視窗而不是測一個 predicate:
 *   缺陷在「事件觸發的順序」上,不在某個布林判斷上。純函式測試會給人
 *   「這裡有被測到」的錯覺,實際上 handler 的分支組合仍然沒被量到。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

type Handler = (e: { preventDefault: () => void }, ...rest: unknown[]) => void

// vi.mock 的 factory 會被提升到檔案最上方,裡面不能用到這裡的 const。
// vi.hoisted 是 vitest 官方為此提供的解法:在提升階段就建立好,兩邊共用同一份。
const h = vi.hoisted(() => ({
  windowHandlers: new Map<string, (e: { preventDefault: () => void }) => void>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
  messageBox: vi.fn(async () => ({ response: 1 }))
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getVersion: () => '0.2.0-test',
    quit: vi.fn()
  },
  BrowserWindow: class {
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }),
      isCrashed: () => false,
      setBackgroundMaterial: vi.fn(),
      setWindowButtonVisibility: vi.fn()
    }
    on = (event: string, fn: Handler): void => {
      h.windowHandlers.set(event, fn)
    }
    once = vi.fn()
    isDestroyed = (): boolean => false
    isVisible = (): boolean => true
    isMinimized = (): boolean => false
    show = vi.fn()
    close = vi.fn()
    focus = vi.fn()
    loadURL = vi.fn()
    loadFile = vi.fn()
    setMenuBarVisibility = vi.fn()
    setAlwaysOnTop = vi.fn()
    setBounds = vi.fn()
    getBounds = () => ({ x: 0, y: 0, width: 100, height: 100 })
  },
  dialog: { showMessageBox: h.messageBox },
  screen: { getAllDisplays: () => [] },
  shell: {}
}))

import { createMainWindow, cancelCloseRequest } from '../windows'
import { state } from '../state'
import { IPC } from '@shared/types'

/** 觸發一次 close,回報有沒有被擋下來。 */
function fireClose(): boolean {
  let prevented = false
  h.windowHandlers.get('close')?.({ preventDefault: () => { prevented = true } })
  return prevented
}

describe('關閉確認:對話框還沒回答時再按一次 X', () => {
  beforeEach(() => {
    h.windowHandlers.clear()
    h.sent.length = 0
    h.messageBox.mockClear()
    state.closeBlocker = null
    createMainWindow()
  })

  it('第一次按 X:擋下並發出確認請求', () => {
    state.closeBlocker = '正在錄音。請先按「停止並儲存」再關閉。'
    expect(fireClose()).toBe(true)
    expect(h.sent.filter((s) => s.channel === IPC.AppCloseRequested)).toHaveLength(1)
  })

  it('第二次按 X:仍然擋下,而且不重複發確認(否則畫面上會疊兩個對話框)', () => {
    state.closeBlocker = '「開場白」有未儲存的修改。'
    expect(fireClose()).toBe(true)
    expect(fireClose(), '第二次按 X 不能讓視窗在守衛未回答時關掉').toBe(true)
    expect(h.sent.filter((s) => s.channel === IPC.AppCloseRequested)).toHaveLength(1)
  })

  it('沒有守衛時必須放行 —— 否則使用者會被自己回答過的對話框永遠困住', () => {
    expect(fireClose()).toBe(false)
  })

  it('使用者按「取消」之後,還能再問一次(視窗不會變成關不掉)', () => {
    state.closeBlocker = '正在錄音。'
    expect(fireClose()).toBe(true)
    cancelCloseRequest()
    expect(fireClose()).toBe(true)
    expect(h.sent.filter((s) => s.channel === IPC.AppCloseRequested)).toHaveLength(2)
  })
})