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
import { syncCoachingTimer } from './liveCoaching'
import { initLogging, logMain } from './logging'
import { DEBUG } from './debug'
import { initUpdater } from './updater'
import { migrateLegacyKeys } from './ai/aiProvider'

// e2e 隔離:測試進程以 AI_TP_E2E=1 啟動時,把 userData 重導到暫存目錄,
// 測試建立的講稿/會議/設定不會汙染真實使用者資料(真實發生過:測試講稿出現在使用者 Dashboard)。
// 必須在 initState()(讀 settings.json)之前執行。
if (process.env['AI_TP_E2E'] === '1') {
  app.setPath('userData', join(app.getPath('temp'), `ai-teleprompter-e2e-${Date.now()}`))
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

  app.whenReady().then(async () => {
    // safeStorage 必須等 Electron ready 後才可依賴；在此遷移舊 settings.json 明文金鑰。
    if (migrateLegacyKeys(state.settings)) {
      const { saveSettings } = await import('./settings')
      saveSettings(state.settings)
    }
    registerIpc()
    createMainWindow()
    createOverlayWindow()
    // 執行中拔螢幕 / 改解析度 / 切鏡射模式會讓浮層座標失效而靜默消失。
    // createOverlayWindow 的防護只涵蓋「上次座標」,這裡補上執行中的。
    screen.on('display-removed', ensureOverlayOnScreen)
    screen.on('display-metrics-changed', ensureOverlayOnScreen)
    registerHotkeys()
    syncCoachingTimer()
    initUpdater()
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
   */
  app.on('before-quit', () => {
    markQuitting()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
