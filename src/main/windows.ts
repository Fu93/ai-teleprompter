import { app, BrowserWindow, dialog, screen } from 'electron'
import { join } from 'path'
import os from 'os'
import { IPC } from '@shared/types'
import { EXPANDED_MIN, overlayShapeDesignSize, overlayShapeMin, overlayShapeOf } from '@shared/overlayShapes'
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
    // 順序有意義:setSize 會被最小尺寸夾住,所以下限必須先對齊形態
    applyOverlayMinSize()
    const min = overlayShapeMin(o)
    const [w, h] = state.overlayWindow.getSize()
    // 兩道防線:setMinimumSize(擋使用者拖曳)以及這裡對「目標尺寸」本身的夾取。
    // 只有前者的話,正確性就依賴「Windows 一定會對程式化 setSize 套用最小尺寸」
    // 這個假設 —— 沒成立的話就變成「介面說最小 340、實際被允許 300」的落差,
    // 而那種落差正是這輪修掉的 bug 的形狀。
    //
    // 尺寸的來源是**形態**,不是 o.width/o.height:
    //   o.width/o.height 的語意是「使用者選的展開尺寸」(拖曳/展開時寫入)。
    //   先前這裡對三種形態都用它來 setSize,於是任何設定寫入都會把正在顯示的
    //   藥丸/貼鏡撐回展開大小 —— morph 定案時寫回的展開尺寸就是最明顯的一擊
    //   (實測:貼鏡在 250ms 到 421×170,500ms 被撐回 720×260)。
    //   藥丸要多大由 pillScale 決定、貼鏡有固定設計尺寸,只有展開形態才聽使用者的。
    const design = overlayShapeDesignSize(o)
    const targetW = Math.max(min.w, design ? design.w : o.width)
    const targetH = Math.max(min.h, design ? design.h : o.height)
    if (w !== targetW || h !== targetH) state.overlayWindow.setSize(targetW, targetH)
    // 只有展開形態的尺寸是使用者的。藥丸/貼鏡拖邊只會被下一次尺寸同步拉回 ——
    // 那是「介面允許你做一件不會成功的事」(使用者視角試用發現),所以在這兩種
    // 形態把視窗設成不可拖,讓滑鼠指標本身就不要提供那個暗示。
    // 用 isResizable() 先比對再改:這個函式會因每一次設定寫入而被叫到
    // (含 morph 期間的每一帧),無條件 setResizable 會在那裡做不必要的視窗操作。
    const wantResizable = overlayShapeOf(o) === 'expanded'
    if (state.overlayWindow.isResizable() !== wantResizable) {
      state.overlayWindow.setResizable(wantResizable)
    }
  }
}

let quitTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 關閉視窗守衛。
 *
 * 為什麼需要:在這之前關閉視窗完全沒有保護 —— 講稿編輯到一半、或正在錄音
 * 時直接關掉,內容靜默消失(Record 的 unmount 只做 stopAll,不寫 DB)。
 * 側欄切頁有確認,關視窗沒有,而後者損失更徹底。
 *
 * 為什麼不是 beforeunload:
 *   Electron 的 `will-prevent-unload` 預設會忽略 renderer 的 beforeunload 直接
 *   關閉,要讓它生效得另外處理;而且我們要的是「App 自己畫的對話框」,
 *   不是瀏覽器預設的「要離開此頁面嗎」。所以流程是:
 *     renderer 主動上報 blocker → close 事件 preventDefault → 通知 renderer
 *     → renderer 顯示 ConfirmDialog → 使用者回答 → confirm/cancel IPC
 *
 * 為什麼要有超時兜底:
 *   renderer 卡住或崩潰時,上面那條往返永遠不會有回應,視窗就再也關不掉了。
 *   真的不回應時改用原生對話框詢問,寧可醜一點也不要讓使用者關不掉程式。
 *
 * 為什麼不是 4 秒就彈原生框:
 *   原生 `showMessageBox` 回傳 Promise,沒有可程式化關掉的 handle。一旦它開了,
 *   使用者若接著在 App 內的 ConfirmDialog 選「取消」,那個灰白小視窗會孤零零
 *   留在畫面上關不掉 —— 而拿掉那個視窗正是這整輪重構的目的。所以 renderer
 *   還活著就多等(見 MAX_FALLBACK_ROUNDS),只有真的不回應才退回原生框。
 */
const CLOSE_PROMPT_FALLBACK_MS = 4_000
/** renderer 看起來活著卻一直不回答時,最多再等這麼多輪才退回原生對話框 */
const MAX_FALLBACK_ROUNDS = 2
let closeConfirmed = false
let closePromptTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 已送出 AppCloseRequested 且還沒有人回答。
 * 刻意與計時器分開:計時器在每次重排時都會先把自己清空,而「還在問」
 * 這件事要維持到使用者真的回答為止 —— 否則連按兩次 X 就會送出兩次請求,
 * 畫面上疊兩個 ConfirmDialog,而 confirm.ts 只會保留最後一個。
 */
let closePromptPending = false
/** 已經等過幾輪沒回應(只影響是否退回原生框) */
let closePromptRounds = 0
/** app.before-quit 之後為 true:真正的退出必須繞過守衛(見 index.ts 的說明) */
let quitting = false

/** 由 index.ts 的 before-quit 呼叫 */
export function markQuitting(): void {
  quitting = true
}

function clearClosePrompt(): void {
  if (closePromptTimer) {
    clearTimeout(closePromptTimer)
    closePromptTimer = null
  }
  closePromptPending = false
  closePromptRounds = 0
}

/** renderer 按了「放棄並關閉」 */
export function forceCloseMainWindow(): void {
  clearClosePrompt()
  closeConfirmed = true
  const win = state.mainWindow
  if (win && !win.isDestroyed()) win.close()
}

/** renderer 按了「取消」 */
export function cancelCloseRequest(): void {
  clearClosePrompt()
}

function cancelQuitWhenOverlayHidden(): void {
  if (quitTimer) {
    clearTimeout(quitTimer)
    quitTimer = null
  }
}

export function createMainWindow(): BrowserWindow {
  cancelQuitWhenOverlayHidden()
  // 一律用區域變數 win 操作,不在事件觸發時重新讀 state.mainWindow:
  // second-instance 可能在舊視窗與新視窗之間交替,重讀全域會作用到錯誤的視窗。
  const win = new BrowserWindow({
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

  state.mainWindow = win

  win.on('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  hardenWebContents(win)

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 新視窗 = 新的守衛狀態(second-instance 會重建主視窗)
  closeConfirmed = false
  clearClosePrompt()

  // renderer 重載會讓它自己回報的 blocker 失效(重載後一個守衛都沒掛,
  // report() 不會再被呼叫),但 main 端這個值會留著。症狀是按 X 跳出一個
  // 「正在錄音」的警告而畫面上根本沒在錄音。renderer 端也會清一次,這裡是第二道。
  win.webContents.on('did-start-loading', () => {
    state.closeBlocker = null
    clearClosePrompt()
  })

  win.on('close', (e) => {
    if (closeConfirmed || quitting) return
    const blocker = state.closeBlocker
    // 沒有守衛(或已經在問了)就讓它正常關閉 —— 不能讓使用者被自己的對話框困住
    if (!blocker || closePromptPending) return
    e.preventDefault()
    closePromptPending = true
    win.webContents.send(IPC.AppCloseRequested, blocker)
    // 具名函式而不是內聯箭頭:它要自己重排自己(多等一輪再退回原生框)
    const onFallbackTimeout = (): void => {
      closePromptTimer = null
      if (!closePromptPending) return
      // renderer 活著 = App 內的 ConfirmDialog 已經在螢幕上了,使用者看得到、
      // 也正在回答。這時候再彈原生框只會讓兩個對話框同時存在,而原生框沒有
      // 可關閉它的 handle —— 使用者若接著選「取消」,那個灰白視窗會孤零零留著。
      // 所以先多等 MAX_FALLBACK_ROUNDS 輪(共 12 秒),真的不回應才退回原生框。
      if (!win.isDestroyed() && !win.webContents.isCrashed() && closePromptRounds < MAX_FALLBACK_ROUNDS) {
        closePromptRounds += 1
        closePromptTimer = setTimeout(onFallbackTimeout, CLOSE_PROMPT_FALLBACK_MS)
        return
      }
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          buttons: ['放棄並關閉', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '結束前確認',
          message: blocker,
          detail: '主視窗沒有回應,無法顯示 App 內的確認對話框。'
        })
        .then((res) => {
          if (res.response === 0) forceCloseMainWindow()
        })
    }
    closePromptTimer = setTimeout(onFallbackTimeout, CLOSE_PROMPT_FALLBACK_MS)
  })

  win.on('closed', () => {
    // 只在自己仍是「當前主視窗」時才清空:second-instance 會在舊視窗與新視窗
    // 關閉順序交錯時,舊視窗不可清除新視窗的參照。
    if (state.mainWindow !== win) return
    clearClosePrompt()
    state.closeBlocker = null
    state.mainWindow = null
    // 隱藏的 overlay BrowserWindow 仍會讓 Electron 保持「有視窗」,
    // 因此 window-all-closed 不會在關閉主視窗時觸發。
    if (process.platform !== 'darwin') quitWhenOverlayHidden()
  })

  return win
}

/**
 * 判斷一塊矩形是否「還算看得到」。
 * 門檻不是「完全在畫面內」而是「有足夠比例落在工作區內」——
 * 提詞時把浮層刻意推到螢幕邊緣是正常用法(只露出上半截)，
 * 用「完全在內」的標準會把這些正常狀態誤判成消失、把它拉回來。
 */
function coverageOnDisplay(win: BrowserWindow, display: Electron.Display): number {
  const [x, y] = win.getPosition()
  const [w, h] = win.getSize()
  const b = display.workArea
  const ix = Math.max(0, Math.min(x + w, b.x + b.width) - Math.max(x, b.x))
  const iy = Math.max(0, Math.min(y + h, b.y + b.height) - Math.max(y, b.y))
  return (ix * iy) / Math.max(1, w * h)
}

/**
 * 把浮層視窗的可縮放下限對齊「目前形態」的需求。
 *
 * 為什麼需要:同一個 frameless 視窗要服務三種需求完全不同的版面 —— 展開(使用者
 * 自訂,可以很窄)、藥丸(固定一列)、貼鏡(420×170)。用單一 280×40 當下限時,
 * 藥丸與貼鏡可以被縮到它們的內容放不下,而超出的部分是 overflow-hidden:
 * 使用者看到的是「按鈕被切掉、正文整段不見」,最右邊那顆(展開鈕,也是藥丸唯一
 * 的出口)甚至點不到。
 *
 * 為什麼取 min(形態下限, 目前尺寸):
 *   形態切換有動畫。若在動畫開始的瞬間就把下限拉到目標形態的需求(例如藥丸
 *   460×56 → 貼鏡 420×170 時把最小高度設成 170),OS 會立刻把視窗擘高,
 *   動畫就從一個已被夾過的尺寸起跳。取 min 之後,下限只會跟著目前尺寸走,
 *   永遠不會夾住正在跑的 morph;等 morph 定案(OverlaySetSize)時視窗已經是
 *   目標尺寸,那時算出來的就是完整的形態下限。
 */
export function applyOverlayMinSize(): void {
  const win = state.overlayWindow
  if (!win || win.isDestroyed()) return
  const min = overlayShapeMin(state.settings.overlay)
  const [curW, curH] = win.getSize()
  win.setMinimumSize(Math.min(min.w, curW), Math.min(min.h, curH))
}

/** 把浮層移到指定螢幕頂部置中,並落盤(避免下次啟動又用舊座標)。 */
function moveOverlayToDisplay(win: BrowserWindow, display: Electron.Display): void {
  const [w] = win.getSize()
  const wa = display.workArea
  win.setPosition(wa.x + Math.round((wa.width - w) / 2), wa.y + 8)
  const [x, y] = win.getPosition()
  state.settings.overlay.x = x
  state.settings.overlay.y = y
  saveSettings(state.settings)
}

/**
 * 執行期把浮層拉回畫面內。
 *
 * createOverlayWindow 已經防護「上次座標落在已拔掉的螢幕上」,
 * 但執行中拔螢幕 / 改解析度 / 改鏡射模式會讓當下的座標失效,
 * 浮層會靜默消失——使用者在台上只能靠盲按熱鍵猜。
 * 這裡在每次顯示前與螢幕變動時補上防護。
 */
export function ensureOverlayOnScreen(): void {
  const win = state.overlayWindow
  // 不檢查 isVisible:隱藏中的浮層同樣可能已經落在畫面外,
  // 顯示前才修正正是這裡的用途。
  if (!win || win.isDestroyed()) return
  const displays = screen.getAllDisplays()
  // 還看得到就什麼都不做(允許使用者刻意貼邊)
  if (displays.some((d) => coverageOnDisplay(win, d) >= 0.5)) return
  // 否則挑「遮住最多」的那台(而非一律主螢幕),使用者接外接螢幕時浮層才不會跳離
  let best = displays[0]
  let bestCover = -1
  for (const d of displays) {
    const c = coverageOnDisplay(win, d)
    if (c > bestCover) {
      bestCover = c
      best = d
    }
  }
  moveOverlayToDisplay(win, best)
}

/** 使用者按「置中」:回到主螢幕頂部置中。 */
export function recenterOverlay(): void {
  const win = state.overlayWindow
  if (!win || win.isDestroyed()) return
  moveOverlayToDisplay(win, screen.getPrimaryDisplay())
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
  // 初始尺寸就跟著還原後的形態走:直接沿用展開尺寸的話,啟動時會先出現一個
  // 720×260 的暗方塊,renderer 掛載後才被還原成藥丸(那一眼就是「閃一下」)。
  const initial = overlayShapeDesignSize(s.overlay) ?? { w: s.overlay.width, h: s.overlay.height }
  state.overlayWindow = new BrowserWindow({
    width: initial.w,
    height: initial.h,
    minWidth: EXPANDED_MIN.w,
    minHeight: EXPANDED_MIN.h,
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
    // 顯示前先確認還在畫面上(執行中拔螢幕的情況),否則使用者會以為熱鍵壞了
    ensureOverlayOnScreen()
    win.showInactive() // 不搶焦點，避免打斷正在使用的應用
  } else {
    win.hide()
  }
}

/**
 * 浮層顯示狀態廣播。
 *
 * 為什麼也要送給浮層自己:
 *   浮層被隱藏(熱鍵/工具列 ✕)後視窗仍然活著,裡面的 renderer 照常跑 —— 語音跟讀
 *   一旦啟動就會繼續開著麥克風與 Whisper 轉錄,指示燈亮著、CPU 照燒,而畫面上
 *   什麼都看不到。浮層需要知道「我被藏起來了」才有辦法自己收手。
 *   只送主視窗(原本的寫法)時,浮層是唯一不知道這件事的一方。
 */
export function notifyOverlayVisibility(visible: boolean): void {
  state.mainWindow?.webContents.send(IPC.OverlayVisibilityChanged, visible)
  if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
    state.overlayWindow.webContents.send(IPC.OverlayVisibilityChanged, visible)
  }
}

/** 主視窗關閉後的浮層續命寬限;到期仍可見則再等一輪,隱藏後退出整個 app */
const QUIT_GRACE_MS = 10_000
export function quitWhenOverlayHidden(): void {
  if (process.platform === 'darwin' || state.mainWindow || quitTimer) return
  quitTimer = setTimeout(() => {
    quitTimer = null
    // 使用者可能在寬限期間以第二個 instance 重新開啟主視窗。
    if (state.mainWindow) return
    const overlayVisible =
      state.overlayWindow !== null && !state.overlayWindow.isDestroyed() && state.overlayWindow.isVisible()
    if (overlayVisible) quitWhenOverlayHidden()
    else app.quit()
  }, QUIT_GRACE_MS)
}
