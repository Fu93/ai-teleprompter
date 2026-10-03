import { BrowserWindow } from 'electron'
import { IPC, type AppSettings } from '@shared/types'
import type { OverlayShowPayload } from '@shared/api'
import { loadSettings } from './settings'

/**
 * 共享可變單例:全 main 模組的唯一狀態源,依賴方向一律指向這裡。
 * settings 用屬性存取(state.settings)而非直接綁定——SettingsSet 的 deepMerge
 * 是整顆重賦值,直接 re-export 變數會讓其他模組拿到 stale 參照。
 *
 * settings 不在 module level 載入:e2e 隔離要把 userData 重導到暫存目錄,
 * 該重導發生在 index.ts 本體(晚於所有 import 求值),必須等 initState() 顯式呼叫。
 */
const state = {
  settings: null as unknown as AppSettings,
  mainWindow: null as BrowserWindow | null,
  overlayWindow: null as BrowserWindow | null,
  /** 最近一次 OverlayShow/OverlaySync 的內容;panic 無語音上下文時退用講稿結尾 */
  lastOverlayPayload: { title: undefined, content: undefined } as OverlayShowPayload,
  /**
   * renderer 宣告的「現在關掉會丢東西」訊息(未存講稿 / 錄音中)。
   * main 無法同步查詢 renderer,所以由 renderer 主動上報,close 事件只讀這裡。
   * null = 沒有阻擋,視窗正常關閉。
   */
  closeBlocker: null as string | null,
  /**
   * renderer 上報的「現在正在錄音」事實。
   *
   * 與 closeBlocker 分開的理由見 IPC.AppSetRecording 的註解。退出前存檔
   * (quitGuard)只看這一個布林:逐字稿只存在 renderer 的 React state 裡,
   * 而 App 退出流程(before-quit)會繞過 close 守衛,於是 OS 關機或自動更新
   * 可以在錄音中把整場會議靜默清空。
   */
  isRecording: false,
  /**
   * 註冊失敗的全域熱鍵(已被其他程式佔用或無效)。
   *
   * 為什麼要記:globalShortcut.register() 失敗時回傳 false 而不丟例外,
   * 所以「熱鍵沒反應」原本是完全靜默的。使用者只能體驗到「按了沒用」,
   * 而診斷快照裡也不會有任何線索。這份清單是讓它變得可見的唯一地方。
   */
  hotkeyConflicts: [] as string[]
}

/** e2e userData 重導之後、任何模組讀取 settings 之前呼叫(index.ts whenReady 前) */
export function initState(): void {
  state.settings = loadSettings()
}

export function broadcastSettings(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.OverlaySettingsChanged, state.settings)
  }
}

export { state }
