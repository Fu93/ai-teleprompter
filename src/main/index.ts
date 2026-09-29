import { app, globalShortcut } from 'electron'
import { join } from 'path'
import { initState, state } from './state'
import { createMainWindow, createOverlayWindow, quitWhenOverlayHidden } from './windows'
import { registerHotkeys, registerIpc } from './ipc'
import { syncCoachingTimer } from './liveCoaching'
import { initLogging } from './logging'
import { initUpdater } from './updater'

// e2e 隔離:測試進程以 AI_TP_E2E=1 啟動時,把 userData 重導到暫存目錄,
// 測試建立的講稿/會議/設定不會汙染真實使用者資料(真實發生過:測試講稿出現在使用者 Dashboard)。
// 必須在 initState()(讀 settings.json)之前執行。
if (process.env['AI_TP_E2E'] === '1') {
  app.setPath('userData', join(app.getPath('temp'), `ai-teleprompter-e2e-${Date.now()}`))
}

initState()
initLogging()

// ---------- 生命週期 ----------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore()
      state.mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpc()
    createMainWindow()
    createOverlayWindow()
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

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
