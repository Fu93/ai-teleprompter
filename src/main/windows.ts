import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import os from 'os'
import { IPC } from '@shared/types'
import { saveSettings } from './settings'
import { broadcastSettings, state } from './state'

const isDev = !app.isPackaged

/** 視窗安全:禁新視窗;僅允許 dev server 或本地檔案內部導航 */
export function hardenWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    const devBase = process.env['ELECTRON_RENDERER_URL']
    const allowed = isDev && devBase ? url.startsWith(devBase) : url.startsWith('file://')
    if (!allowed) e.preventDefault()
  })
}

export function applyOverlayWindowSettings(): void {
  if (!state.overlayWindow) return
  const o = state.settings.overlay
  state.overlayWindow.setContentProtection(o.captureProtected)
  state.overlayWindow.setIgnoreMouseEvents(o.clickThrough, { forward: true })
  state.overlayWindow.setAlwaysOnTop(o.alwaysOnTop, 'screen-saver')
  // 玻璃質感:Win11 22H2+ 嘗試視窗後 acrylic 毛玻璃;不支援或失敗則靜默降級(CSS 玻璃仍生效)
  try {
    const win11 = process.platform === 'win32' && Number(os.release().split('.')[0]) >= 10 && Number(os.release().split('.')[2]) >= 22621
    if (o.glass && win11) {
      state.overlayWindow.setBackgroundMaterial('acrylic')
    } else {
      state.overlayWindow.setBackgroundMaterial('auto')
    }
  } catch {
    // 忽略:舊版 Electron/OS 不支援
  }
  if (!state.overlayWindow.isDestroyed()) {
    const [w, h] = state.overlayWindow.getSize()
    if (w !== o.width || h !== o.height) state.overlayWindow.setSize(o.width, o.height)
  }
}

export function createMainWindow(): void {
  state.mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    show: false,
    autoHideMenuBar: true,
    title: 'AI 提詞機',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  state.mainWindow.on('ready-to-show', () => state.mainWindow?.show())
  hardenWebContents(state.mainWindow)

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    state.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    state.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  state.mainWindow.on('closed', () => {
    state.mainWindow = null
  })
}

export function createOverlayWindow(): void {
  // 還原上次位置前先驗證還在任一螢幕範圍內:拔掉外接螢幕後舊座標會落於畫面外,
  // 不驗證的話浮層會「消失」,使用者只能刪 settings.json 救回
  const s = state.settings
  const savedPos =
    s.overlay.x !== null && s.overlay.y !== null &&
    screen.getAllDisplays().some(
      (d) =>
        s.overlay.x! >= d.bounds.x - 40 &&
        s.overlay.x! < d.bounds.x + d.bounds.width &&
        s.overlay.y! >= d.bounds.y - 40 &&
        s.overlay.y! < d.bounds.y + d.bounds.height
    )
      ? { x: s.overlay.x, y: s.overlay.y }
      : {}
  state.overlayWindow = new BrowserWindow({
    width: s.overlay.width,
    height: s.overlay.height,
    minWidth: 280,
    minHeight: 40,
    ...savedPos,
    frame: false,
    transparent: true,
    // Windows:frameless 視窗預設帶 WS_THICKFRAME,DWM 會沿視窗矩形畫 1px 淺色邊框——
    // 這是 CSS 怎麼調都還有「白邊」的根因(邊框由系統合成,在 web 內容之外)。
    // thickFrame:false 移除它;resizable 仍由 electron-vite 的 transparent 路徑處理。
    thickFrame: false,
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    paintWhenInitiallyHidden: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  state.overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  applyOverlayWindowSettings()
  hardenWebContents(state.overlayWindow)

  state.overlayWindow.on('hide', () => notifyOverlayVisibility(false))
  state.overlayWindow.on('show', () => notifyOverlayVisibility(true))
  // 記住使用者拖過的位置:防抖 600ms 落盤,拖動中不狂寫 settings.json
  let moveSaveTimer: ReturnType<typeof setTimeout> | null = null
  state.overlayWindow.on('moved', () => {
    if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return
    const [x, y] = state.overlayWindow.getPosition()
    state.settings.overlay.x = x
    state.settings.overlay.y = y
    if (moveSaveTimer) clearTimeout(moveSaveTimer)
    moveSaveTimer = setTimeout(() => saveSettings(state.settings), 600)
  })
  state.overlayWindow.on('closed', () => {
    state.overlayWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    state.overlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/overlay`)
  } else {
    state.overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }
}

export function setOverlayVisible(visible: boolean): void {
  if (!state.overlayWindow || state.overlayWindow.isDestroyed()) {
    if (visible) createOverlayWindow()
    else return
  }
  const win = state.overlayWindow!
  if (visible) {
    // 點擊穿透是單向門:穿透中浮層收不到任何滑鼠事件,原設計唯一的解除入口在主視窗設定頁。
    // 重新顯示浮層(熱鍵或「提詞」按鈕)時自動解除,工具列恢復可點;要再穿透按一下工具列即可。
    if (state.settings.overlay.clickThrough) {
      state.settings.overlay.clickThrough = false
      saveSettings(state.settings)
      applyOverlayWindowSettings()
      broadcastSettings()
    }
    win.showInactive() // 不搶焦點，避免打斷正在使用的應用
  } else {
    win.hide()
  }
}

export function notifyOverlayVisibility(visible: boolean): void {
  state.mainWindow?.webContents.send(IPC.OverlayVisibilityChanged, visible)
}

/** 主視窗關閉後的浮層續命寬限;到期仍可見則再等一輪,隱藏後退出整個 app */
const QUIT_GRACE_MS = 10_000
export function quitWhenOverlayHidden(): void {
  setTimeout(() => {
    const overlayVisible =
      state.overlayWindow !== null && !state.overlayWindow.isDestroyed() && state.overlayWindow.isVisible()
    if (overlayVisible) quitWhenOverlayHidden()
    else app.quit()
  }, QUIT_GRACE_MS)
}
