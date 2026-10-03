import { app, globalShortcut, screen } from 'electron'
import { join } from 'path'
import { initState, state } from './state'
import {
  createMainWindow,
  createOverlayWindow,
  markQuitting,
  quitWhenOverlayHidden,
  ensureOverlayOnScreen
} from './windows'
import { registerHotkeys, registerIpc } from './ipc'
import { saveSettings } from './settings'
import { syncCoachingTimer } from './liveCoaching'
import { initLogging, logMain } from './logging'
import { recordEvent } from './events'
import { DEBUG } from './debug'
import { initUpdater } from './updater'
import { createQuitGuard } from './quitGuard'
import { migrateLegacyKeys } from './ai/aiProvider'
import { registerAppAssetProtocol, registerAppAssetScheme } from './appProtocol'

// app:// 資源 scheme(mediapipe wasm/模型):privileged 註冊必須在 ready 之前
registerAppAssetScheme()

// e2e 隔離:測試進程以 AI_TP_E2E=1 啟動時,把 userData 重導到暫存目錄,
// 測試建立的講稿/會議/設定不會汙染真實使用者資料(真實發生過:測試講稿出現在使用者 Dashboard)。
// 必須在 initState()(讀 settings.json)之前執行。
//
// AI_TP_E2E_USERDATA 讓測試釘住那個目錄。為什麼需要:預設每次啟動都是新的
// 暫存目錄,所以「退出 App 再重開,資料還在嗎」這種跨啟動的問題**測不了** ——
// 第二個實例會看到一個全空的 IndexedDB,而測試會把它讀成「資料沒存到」。
// 這只影響 e2e:整段程式碼都在 AI_TP_E2E=1 裡,打包後的使用者永遠走不到。
if (process.env['AI_TP_E2E'] === '1') {
  const pinned = process.env['AI_TP_E2E_USERDATA']
  app.setPath(
    'userData',
    pinned && pinned.trim() ? pinned : join(app.getPath('temp'), `ai-teleprompter-e2e-${Date.now()}`)
  )
}

initState()
initLogging()
// 讓「為什麼看不到除錯面板」有唯一的可查答案(設定、e2e 排除都會影響這個結果)
logMain('INFO', `debug 能力:${DEBUG ? '已啟用 (Ctrl+Shift+D 開面板)' : '已停用'}`)

// ---------- 生命週期 ----------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!state.mainWindow) {
      // 用回傳值而非 state.mainWindow:後者在 if 內已被窄化成 null,
      // 呼叫 createMainWindow() 不會解除窄化,直接讀會是 never。
      const win = createMainWindow()
      win.once('ready-to-show', () => {
        if (!win.isDestroyed()) win.focus()
      })
      return
    }
    if (state.mainWindow.isMinimized()) state.mainWindow.restore()
    state.mainWindow.focus()
  })

  app.whenReady().then(() => {
    // safeStorage 必須等 Electron ready 後才可依賴；在此遷移舊 settings.json 明文金鑰。
    // saveSettings 走靜態 import:settings.ts 已被 state/ipc/windows 靜態引入,
    // 動態 import 只是讓 vite 每次啟動都警告「dynamic import will not move module」。
    if (migrateLegacyKeys(state.settings)) {
      saveSettings(state.settings)
    }
    /**
     * 啟動耗時的起點。
     *
     * 為什麼量這個:使用者回報「開很久」時,我們手上只有症狀。
     * 而啟動慢有兩個完全不同的成因(視窗建立 vs 遷移/熱鍵),分不出來就只能猜。
     */
    const startupT0 = Date.now()
    registerIpc()
    registerAppAssetProtocol()
    createMainWindow()
    createOverlayWindow()
    // 執行中拔螢幕 / 改解析度 / 切鏡射模式會讓浮層座標失效而靜默消失。
    // createOverlayWindow 的防護只涵蓋「上次座標」,這裡補上執行中的。
    screen.on('display-removed', ensureOverlayOnScreen)
    screen.on('display-metrics-changed', ensureOverlayOnScreen)
    registerHotkeys()
    syncCoachingTimer()
    initUpdater()
    /**
     * `startup_main_ready` —— 這個事件名在 shared/observability.ts 裡早已宣告,
     * 但一直到這裡都沒有任何呼叫端。
     *
     * 沒有它,「他開不起來」與「他根本沒開過」在診斷報告裡長得一模一樣:
     * 兩者都沒有任何 startup 事件,而報告裡那份事件清單是唯一的證據。
     *
     * 熱鍵衝突數一起帶上:它是回報率最高的問題之一(「我的快捷鍵沒反應」),
     * 而它在啟動的同一刻就已經知道了 —— 不順手記下來就要等他自己另外去猜。
     */
    recordEvent({
      name: 'startup_main_ready',
      metrics: { ms: Date.now() - startupT0, conflicts: state.hotkeyConflicts.length },
      fields: { debug: DEBUG }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return
    // 浮層預設隱藏 → 主視窗關閉後 10s 退出整個 app(過程中 second-instance 仍能救回);
    // 若使用者正開著浮層提詞則持續寬限,直到浮層隱藏才退出。
    quitWhenOverlayHidden()
  })

  /**
   * 真正要退出時(自動更新重啟、OS 關機、quitWhenOverlayHidden 的寬限到期)
   * 必須繞過「未存變更」的關閉守衛。
   *
   * 為什麼:守衛是在 close 事件裡 preventDefault + 問使用者。OS 關機時
   * (`before-quit` 先觸發) 沒有人有機會回答那個對話框,視窗就再也關不掉 ——
   * 使用者會看到「關機被一個程式的確認框卡住」。自動更新的 quitAndInstall
   * 同理。
   *
   * 但「繞過守衛」不等於「可以什麼都不管就退」:逐字稿只存在 renderer 的
   * React state 裡,而 `autoInstallOnAppQuit = true` 意味著自動更新下載完
   * 就會退出安裝 —— 使用者正在錄音時,整場會議會在這裡**靜默消失**。
   * 所以錄音中先把已有的逐字稿存進 IndexedDB 一次,再真的退出。
   * 守衛本身的邏輯(逾時、第二次放行、失敗不阻擋)在 quitGuard.ts 裡,可單元測試。
   */
  const quitGuard = createQuitGuard({
    isRecording: () => state.isRecording,
    flush: async () => {
      const win = state.mainWindow
      if (!win || win.isDestroyed()) throw new Error('主視窗已不存在')
      // executeJavaScript 跑在 page 的 main world(與 renderer 程式碼同一個世界),
      // 並且會 await 回傳的 promise —— 所以「存好了才退出」是成立的。
      return win.webContents.executeJavaScript(
        'window.__aiTpFlushRecording ? window.__aiTpFlushRecording() : false'
      )
    },
    markQuitting,
    requestQuit: () => app.quit(),
    log: (msg) => logMain('WARN', `退出流程:${msg}`)
  })
  app.on('before-quit', (e) => quitGuard.handleBeforeQuit(e))

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
