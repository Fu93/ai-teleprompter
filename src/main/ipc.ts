import { app, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } from 'electron'
import { writeFile, readFile, stat } from 'fs/promises'
import {
  AppInfo,
  IPC,
  type AppSettings,
  type DebugSignalKind,
  type DebugOverlayAction,
  type CoachingKind
} from '@shared/types'
import { EXPANDED_MIN, overlayShapeOf } from '@shared/overlayShapes'
import type { DebugOverlayInfo } from '@shared/api'
import { AUDIT, DEBUG } from './debug'
import { deepMerge, saveSettings } from './settings'
import { abortOllamaChat, ollamaChat, ollamaListModels, ollamaVersion } from './ollama'
import { chatCompletion, testConnection, getUserKeys, setUserKeys } from './ai/aiProvider'
import { listAllScenes } from './packs'
import { broadcastSettings, state } from './state'
import {
  applyOverlayMinSize,
  applyOverlayWindowSettings,
  syncOverlayMaterial,
  setOverlayVisible,
  recenterOverlay,
  cancelCloseRequest,
  forceCloseMainWindow
} from './windows'
import { logFromRenderer, logDir } from './logging'
import {
  getCoachingCounts,
  handlePanic,
  pushLiveTranscript,
  resetSessionContext,
  syncCoachingTimer
} from './liveCoaching'

export function registerHotkeys(): void {
  globalShortcut.unregisterAll()
  const { toggleOverlay, hideOverlay, panicRescue } = state.settings.hotkeys

  /**
   * 為什麼不能只看有沒有丟例外。
   *
   * globalShortcut.register() 在 accelerator 已經被別的程式佔住時**回傳 false,
   * 不丟例外**。所以外面包 try/catch 是接不到的 —— 註冊失敗是完全靜默的。
   *
   * 使用者看到的是:按了熱鍵,什麼都沒發生,而且 App 不會說為什麼。
   * 這正是這個專案要避免的失敗模式(使用者永遠不知道發生了什麼事)。
   * 而它同時是 e2e flake 的來源:每個測試實例啟動都會註冊 6 個 OS 層級的熱鍵,
   * 前一個實例還沒完全退出時,後一個就會拿到 false —— 熱鍵從此不觸發。
   * 本 session 觀察到的 debug-panel「element not found」就是這個形狀。
   */
  const taken: string[] = []
  const bind = (accel: string | undefined | null, fn: () => void): void => {
    if (!accel) return
    let ok = false
    try {
      ok = globalShortcut.register(accel, fn)
    } catch (err) {
      console.error(`熱鍵註冊丟出例外 ${accel}:`, err)
      taken.push(accel)
      return
    }
    if (!ok) {
      taken.push(accel)
      console.warn(
        `熱鍵 ${accel} 註冊失敗 —— 已被其他程式佔用或無效。` +
          `App 仍可操作,但這個快捷鍵不會有反應。`
      )
    }
  }

  bind(toggleOverlay, () => {
    const visible = state.overlayWindow?.isVisible() ?? false
    setOverlayVisible(!visible)
  })
  bind(hideOverlay, () => setOverlayVisible(false))
  bind(panicRescue, () => {
    void handlePanic()
  })
  // 播放/語速熱鍵:浮層可被滑鼠穿透或失焦,全域熱鍵是唯一可靠入口。
  // 廣播給浮層;未顯示時忽略(visibility sync 由 setOverlayVisible 管)
  bind(state.settings.hotkeys.playPause, () => {
    if (state.overlayWindow && !state.overlayWindow.isDestroyed() && state.overlayWindow.isVisible()) {
      state.overlayWindow.webContents.send(IPC.OverlayPlayPause)
    }
  })
  bind(state.settings.hotkeys.speedUp, () => {
    if (state.overlayWindow && !state.overlayWindow.isDestroyed() && state.overlayWindow.isVisible()) {
      state.overlayWindow.webContents.send(IPC.OverlaySpeedStep, 1)
    }
  })
  bind(state.settings.hotkeys.speedDown, () => {
    if (state.overlayWindow && !state.overlayWindow.isDestroyed() && state.overlayWindow.isVisible()) {
      state.overlayWindow.webContents.send(IPC.OverlaySpeedStep, -1)
    }
  })

  if (taken.length) {
    // 寫進診斷快照,讓 DebugPanel 的「複製診斷 JSON」與使用者的回報裡
    // 看得到「你的熱鍵根本沒有註冊上去」,而不只是一句「沒反應」。
    state.hotkeyConflicts = taken
  } else {
    state.hotkeyConflicts = []
  }
}

export function registerIpc(): void {
  const settings = (): AppSettings => state.settings

  ipcMain.handle(IPC.SettingsGet, () => settings())

  ipcMain.handle(IPC.SettingsSet, (_e, patch: unknown) => {
    const hotkeysBefore = JSON.stringify(state.settings.hotkeys)
    state.settings = deepMerge(state.settings, patch)
    saveSettings(state.settings)
    applyOverlayWindowSettings()
    broadcastSettings()
    // 熱鍵只有在真的變了才重新註冊:設定頁的字體/速度滑桿拖一格就是一次
    // SettingsSet,每 tick 都 unregisterAll + 註冊 6 顆 OS 層熱鍵是純浪費,
    // 也放大「前一個實例還沒退乾淨就 register 失敗」的 flake 面積
    // (見 registerHotkeys 對 globalShortcut.register 回傳 false 的說明)。
    if (JSON.stringify(state.settings.hotkeys) !== hotkeysBefore) registerHotkeys()
    syncCoachingTimer()
    return state.settings
  })

  ipcMain.handle(IPC.OverlayShow, (_e, payload: { title?: string; content?: string }) => {
    state.lastOverlayPayload = payload ?? {}
    setOverlayVisible(true)
    state.overlayWindow?.webContents.send('overlay:load-script', state.lastOverlayPayload)
  })

  ipcMain.handle(IPC.OverlayGetLastPayload, () => state.lastOverlayPayload)

  ipcMain.handle(IPC.OverlayHide, () => setOverlayVisible(false))
  ipcMain.handle(IPC.OverlayToggle, () => setOverlayVisible(!(state.overlayWindow?.isVisible() ?? false)))
  ipcMain.handle(IPC.OverlayIsVisible, () => state.overlayWindow?.isVisible() ?? false)

  ipcMain.handle(IPC.OverlaySetClickThrough, (_e, v: boolean) => {
    state.settings.overlay.clickThrough = v
    saveSettings(state.settings)
    applyOverlayWindowSettings()
    broadcastSettings()
  })

  ipcMain.handle(IPC.OverlaySetCaptureProtection, (_e, v: boolean) => {
    state.settings.overlay.captureProtected = v
    saveSettings(state.settings)
    applyOverlayWindowSettings()
    broadcastSettings()
  })

  /**
   * 定案尺寸。
   *
   * 只在**展開形態**才把尺寸記進 settings:
   *   overlay.width/height 的語意是「使用者選的展開尺寸」（拖曳視窗、離開 morph 時寫入），
   *   展開形態才是它唯一的作者。藥丸/貼鏡呼叫這裡是為了把視窗定案到形態尺寸，
   *   如果把藥丸的 320×48 也寫進去，下次啟動的展開視窗就會是一顆藥丸(實際上會被
   *   EXPANDED_MIN 夾成 280×40 的怪尺寸)，而 morph 期間的展開尺寸也失去來源。
   *   （所以 useMorph 在藥丸/貼鏡定案時會把展開尺寸暫存在 renderer 的 ref；
   *    視窗尺寸本身現在由形態決定，見 applyOverlayWindowSettings。）
   */
  ipcMain.handle(IPC.OverlaySetSize, (_e, w: number, h: number) => {
    const shape = overlayShapeOf(state.settings.overlay)
    if (shape === 'expanded') {
      state.settings.overlay.width = Math.max(EXPANDED_MIN.w, Math.round(w))
      state.settings.overlay.height = Math.max(EXPANDED_MIN.h, Math.round(h))
      saveSettings(state.settings)
    }
    applyOverlayWindowSettings()
  })

  /** 動畫用即時尺寸:每幀呼叫,只改視窗與記憶體設定,不落盤(結束時由 OverlaySetSize 定案)。
   *  刻意不走 applyOverlayWindowSettings:那裡含 setContentProtection/setIgnoreMouseEvents/
   *  setBackgroundMaterial 與 os.release 解析,每幀 60 次全是浪費,morph 只需要 setSize。
   *  例外是材質:syncOverlayMaterial 是形態閘(acrylic 只准在展開形態),內部有
   *  lastMaterial 快取,值沒變就是純比較 —— morph 開始的第一幀就切換,膠囊四角的
   *  磨砂補丁不會拖到動畫結束才消失。 */
  ipcMain.handle(IPC.OverlaySetSizeLive, (_e, w: number, h: number) => {
    if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
      // 形態下限必須跟著動畫走,理由見 applyOverlayMinSize 的註解。
      // 這裡不能整包走 applyOverlayWindowSettings:那會每帧做 setContentProtection、
      // setIgnoreMouseEvents、setBackgroundMaterial 與 os.release() 解析。
      applyOverlayMinSize()
      syncOverlayMaterial()
      // 刻意不寫 settings.overlay.width/height:那兩個欄位是「使用者選的展開尺寸」，
      // 這條路徑每帧呼叫(morph 動畫)，寫進去等於用動畫中的尺寸不斷污染它。
      state.overlayWindow.setSize(Math.round(w), Math.round(h))
    }
  })

  ipcMain.handle(IPC.AppInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    userDataPath: app.getPath('userData'),
    debug: DEBUG,
    audit: AUDIT,
    // 附在 AppInfo 上是為了讓「熱鍵沒反應」有唯一可查答案:e2e 失敗時把它
    // 印出來,就不必再用「疑似全域熱鍵爭用」去猜(那個說法查過之後不成立)。
    hotkeyConflicts: [...state.hotkeyConflicts]
  }))

  // ---- AI (Ollama) ----
  ipcMain.handle(IPC.OllamaListModels, async (_e, baseUrl: string) => {
    const [models, version] = await Promise.all([
      ollamaListModels(baseUrl),
      ollamaVersion(baseUrl)
    ])
    return { models, version, installed: version !== null }
  })

  ipcMain.handle(IPC.OllamaChat, async (_e, req: Parameters<typeof ollamaChat>[0]) => {
    try {
      const text = await ollamaChat(req, state.settings)
      return { ok: true, text }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.OllamaAbort, (_e, requestId: string) => {
    abortOllamaChat(requestId)
  })

  // ---- OpenAI 相容 chat 代理 ----
  ipcMain.handle(IPC.OpenAiChat, async (_e, req: {
    baseUrl: string
    apiKey: string
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    temperature?: number
  }) => {
    try {
      const secureAiKey = getUserKeys()?.apiKey
      const apiKey = typeof secureAiKey === 'string' && secureAiKey ? secureAiKey : req.apiKey
      const res = await fetch(`${req.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature ?? 0.7
        }),
        signal: AbortSignal.timeout(180_000)
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`API 回應 ${res.status}: ${detail.slice(0, 200)}`)
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return { ok: true, text: data.choices?.[0]?.message?.content ?? '' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 雲端語音辨識代理 ----
  ipcMain.handle(IPC.CloudTranscribe, async (_e, args: {
    baseUrl: string
    apiKey: string
    model: string
    audio: Uint8Array
    language?: string
  }) => {
    try {
      const secureSttKey = getUserKeys()?.sttApiKey
      const apiKey = typeof secureSttKey === 'string' && secureSttKey ? secureSttKey : args.apiKey
      const form = new FormData()
      form.append('file', new Blob([args.audio], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', args.model)
      if (args.language && args.language !== 'auto') form.append('language', args.language)
      const res = await fetch(`${args.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        body: form,
        signal: AbortSignal.timeout(60_000)
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`語音 API 回應 ${res.status}: ${detail.slice(0, 200)}`)
      }
      const data = (await res.json()) as { text?: string }
      return { ok: true, text: (data.text ?? '').trim() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 錄影存檔 ----
  ipcMain.handle(IPC.SaveRecording, async (_e, args: { bytes: Uint8Array; defaultName: string }) => {
    if (!state.mainWindow) return { ok: false, error: 'no-window' }
    const { canceled, filePath } = await dialog.showSaveDialog(state.mainWindow, {
      defaultPath: args.defaultName,
      filters: [{ name: '影片', extensions: ['webm', 'mp4'] }]
    })
    if (canceled || !filePath) return { ok: false, error: 'canceled' }
    await writeFile(filePath, Buffer.from(args.bytes))
    return { ok: true, filePath }
  })

  // ---- 分享前模擬測試:回傳主螢幕擷取縮圖(擷取保護生效時浮層不會出現)----
  ipcMain.handle(IPC.ShareSimulation, async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 960, height: 540 }
      })
      if (sources.length === 0) return { ok: false, error: 'no-screen' }
      return { ok: true, dataUrl: sources[0].thumbnail.toDataURL() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 貼鏡模式吸附:浮層移到螢幕上緣角落 ----
  ipcMain.handle(IPC.OverlaySnapCorner, (_e, corner: 'tl' | 'tc' | 'tr') => {
    if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return
    const { workArea } = screen.getPrimaryDisplay()
    const [w] = state.overlayWindow.getSize()
    const x = corner === 'tl' ? workArea.x + 8 : corner === 'tr' ? workArea.x + workArea.width - w - 8 : workArea.x + Math.round((workArea.width - w) / 2)
    state.overlayWindow.setPosition(x, workArea.y + 8)
  })

  // ---- 浮層置中:掉出畫面時的保險,使用者不必重開浮層 ----
  ipcMain.handle(IPC.OverlayRecenter, () => {
    recenterOverlay()
  })

  // ---- 關閉視窗守衛 ----
  // renderer 在「未存講稿 / 錄音中」時上報訊息,main 在 close 事件裡讀它。
  // main 沒有辦法同步查詢 renderer,所以方向必須是 renderer 主動推。
  ipcMain.handle(IPC.AppSetCloseBlocker, (_e, text: string | null) => {
    state.closeBlocker = typeof text === 'string' && text.trim() ? text : null
    return true
  })
  ipcMain.handle(IPC.AppConfirmClose, () => {
    forceCloseMainWindow()
    return true
  })
  ipcMain.handle(IPC.AppCancelClose, () => {
    cancelCloseRequest()
    return true
  })

  // ---- 開發者除錯(UI/UX debug 支援)----
  // 每個 handler 都先檢查 DEBUG:未啟用時能力完全不存在,而不是「存在但藏起來」。
  ipcMain.handle(IPC.DebugOpenDevTools, (_e, target: 'main' | 'overlay') => {
    if (!DEBUG) return false
    const win = target === 'overlay' ? state.overlayWindow : state.mainWindow
    if (!win || win.isDestroyed()) return false
    // detach:浮層是 280px 起跳的窄視窗,內嵌 DevTools 會把內容擠到看不見
    win.webContents.openDevTools({ mode: 'detach' })
    return true
  })

  ipcMain.handle(
    IPC.DebugEmitSignal,
    (_e, args: { kind: DebugSignalKind; text?: string; coachingKind?: CoachingKind }) => {
      // AUDIT 也放行:這個 backdoor 是「把 UI 推進到 headless 到不了的狀態」,
      // 而 turn-yield / coaching / panic 三個覆蓋層正是這一類(沒有按鈕可以「到達」
      // 它們,只能等真實事件發生)。離線稽核以前完全沒有量過它們。
      // AUDIT 只在開發環境以環境變數開啟(src/main/debug.ts),打包版永遠是 false。
      if (!DEBUG && !AUDIT) return false
      const win = state.overlayWindow
      if (!win || win.isDestroyed()) return false
      const at = Date.now()
      // 走與 liveCoaching 相同的廣播通道與 payload 形狀:除錯路徑若自己發明一套
      // 格式,測出來的就不是真實事件觸發時的樣子。
      if (args.kind === 'turn') {
        win.webContents.send(IPC.TurnYieldSignal, {
          kind: args.text === 'peer_silence' ? 'peer_silence' : 'turn',
          question: args.text !== 'peer_silence',
          at
        })
      } else if (args.kind === 'coaching') {
        win.webContents.send(IPC.CoachingSignal, {
          kind: args.coachingKind ?? 'fast',
          message: args.text || '（除錯）語速偏快,放慢一點',
          at
        })
      } else {
        win.webContents.send(IPC.PanicRescue, {
          sentence: args.text || '（除錯）這是一張救援卡示範句',
          points: '先回應問題核心 / 補一個具體例子 / 收在可執行的下一步',
          confidence: 0.78,
          source: 'template',
          scene: 'debug'
        })
      }
      // 浮層可能在隱藏狀態,不顯示的話等於按了沒反應
      setOverlayVisible(true)
      return true
    }
  )

  ipcMain.handle(IPC.DebugOverlaySnapshot, async () => {
    if (!DEBUG) return null
    const win = state.overlayWindow
    if (!win || win.isDestroyed()) return null
    try {
      // 在主世界執行 —— 浮層的 React 掛在 main world,preload 的隔離世界看不到它
      return await win.webContents.executeJavaScript(
        'window.__debugSnapshot ? window.__debugSnapshot() : null'
      )
    } catch {
      return null
    }
  })

  /**
   * 在浮層裡跑同一套 DOM 稽核(src/renderer/src/lib/domAudit.ts)。
   * 面板的「稽核」分頁用它,離線的 audit-deep.mjs 用同一支函式 ——
   * 兩邊的規則必須是同一個,否則面板說合格、稽核說不合格。
   */
  ipcMain.handle(IPC.DebugOverlayAudit, async () => {
    if (!DEBUG) return null
    const win = state.overlayWindow
    if (!win || win.isDestroyed()) return null
    try {
      return await win.webContents.executeJavaScript(
        'window.__debugAudit ? window.__debugAudit() : null'
      )
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.DebugOverlayCall, async (_e, action: DebugOverlayAction) => {
    if (!DEBUG) return false
    const win = state.overlayWindow
    if (!win || win.isDestroyed()) return false
    if (action === 'recenter') {
      recenterOverlay()
      return true
    }
    // 其餘動作交給浮層自己的控制項:形態切換(compact/lens)會改變視窗尺寸
    // (藥丸 460×56、貼鏡 420×170,展開則回到設定的寬高)。從 main 端 setSettings
    // 只會翻動設定旗標而不會 resize,morph 動畫也不會跑 —— 結果是「藥丸的內容
    // 裝在展開的視窗裡」這種前後不一致的狀態。走浮層自己的按鈕才是真實路徑。
    try {
      return Boolean(
        await win.webContents.executeJavaScript(
          `window.__debugControl ? window.__debugControl(${JSON.stringify(action)}) : false`
        )
      )
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.DebugOverlayInfo, (): DebugOverlayInfo | null => {
    if (!DEBUG) return null
    const win = state.overlayWindow
    if (!win || win.isDestroyed()) return null
    const [x, y] = win.getPosition()
    const [width, height] = win.getSize()
    const display = screen.getDisplayMatching({ x, y, width, height })
    return {
      x,
      y,
      width,
      height,
      visible: win.isVisible(),
      scaleFactor: display.scaleFactor,
      workArea: display.workArea,
      displayBounds: display.bounds
    }
  })

  // ---- 在檔案總管顯示檔案 ----
  ipcMain.handle(IPC.RevealPath, (_e, path: string) => {
    if (path && typeof path === 'string') shell.showItemInFolder(path)
  })

  // ---- 開外部連結(只准 http/https)----
  ipcMain.handle(IPC.OpenExternal, async (_e, url: string) => {
    if (typeof url !== 'string') return false
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    // 只准 http/https。file:// 等於開本機檔案,javascript: 等於注入腳本,
    // data: 可以拿來做 phishing 頁面。winston 這裡寧可拒絕得比需要的更嚴。
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    await shell.openExternal(parsed.toString())
    return true
  })

  // ---- 崩潰回報基礎:renderer 錯誤落盤 + 開啟記錄資料夾 ----
  ipcMain.handle(IPC.LogFromRenderer, (_e, args: { level: 'ERROR' | 'WARN' | 'INFO'; message: string }) => {
    logFromRenderer(args.level, String(args.message).slice(0, 4000))
  })

  ipcMain.handle(IPC.OpenLogDir, () => {
    shell.openPath(logDir())
  })

  // ---- 匯出檔案 ----
  ipcMain.handle(IPC.ExportFile, async (_e, args: { defaultName: string; content: string }) => {
    if (!state.mainWindow) return { ok: false, error: 'no-window' }
    const { canceled, filePath } = await dialog.showSaveDialog(state.mainWindow, {
      defaultPath: args.defaultName
    })
    if (canceled || !filePath) return { ok: false, error: 'canceled' }
    await writeFile(filePath, args.content, 'utf-8')
    return { ok: true, filePath }
  })

  // ---- 讀入 JSON(資料備份的還原)----
  ipcMain.handle(IPC.ImportJsonFile, async (_e, args: { defaultName?: string; maxBytes?: number }) => {
    if (!state.mainWindow) return { ok: false, error: 'no-window' }
    const { canceled, filePaths } = await dialog.showOpenDialog(state.mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'AI 提詞機備份', extensions: ['json'] }],
      ...(args?.defaultName ? { defaultPath: args.defaultName } : {})
    })
    if (canceled || filePaths.length === 0) return { ok: false, error: 'canceled' }
    const filePath = filePaths[0]
    // 大小上限:這是備份檔,正常是幾百 KB。給一個 64MB 的天花板,
    // 避免使用者誤選一個巨大的 JSON 而把 renderer 的字串處理拖死。
    // 超出就回人話錯誤,不截斷 —— 截斷出來的 JSON 解析失敗,錯誤訊息更難懂。
    const max = args?.maxBytes ?? 64 * 1024 * 1024
    const info = await stat(filePath)
    if (info.size > max) {
      return { ok: false, error: `檔案太大（${Math.round(info.size / 1024 / 1024)}MB）,這不像是備份檔。` }
    }
    const text = await readFile(filePath, 'utf-8')
    return { ok: true, filePath, text }
  })

  // ---- Phase C:統一 AI / 金鑰 / panic / 場景 ----
  ipcMain.handle(IPC.AiChatCompletion, async (_e, req: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    maxTokens?: number
    temperature?: number
    jsonMode?: boolean
    timeoutMs?: number
  }) => {
    return chatCompletion(state.settings, req.messages, req)
  })

  ipcMain.handle(IPC.AiTestConnection, (_e, args: Parameters<typeof testConnection>[0]) => testConnection(args))

  ipcMain.handle(IPC.KeysGet, () => getUserKeys())

  ipcMain.handle(IPC.KeysSet, (_e, keys: Record<string, unknown>) => setUserKeys(keys))

  ipcMain.handle(IPC.SceneList, () =>
    listAllScenes().map((s) => ({
      key: s.key,
      label: s.label,
      tone: s.tone,
      tempo: s.tempo,
      lengthBudget: s.lengthBudget,
      riskLevel: s.riskLevel,
      turns: s.turns,
      source: s.source ?? 'builtin'
    }))
  )

  ipcMain.handle(IPC.ContextPushTranscript, (_e, args: { text: string; speaker?: 'me' | 'them' | 'unknown' }) =>
    pushLiveTranscript(args.text, args.speaker ?? 'unknown')
  )

  ipcMain.handle(IPC.PanicTrigger, () => {
    void handlePanic()
    return true
  })

  ipcMain.handle(IPC.ContextReset, () => {
    resetSessionContext()
  })

  ipcMain.handle(IPC.CoachingStatsGet, () => getCoachingCounts())

  // ---- 系統音訊 loopback 授權（Windows）----
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (sources.length === 0) {
            callback({} as Parameters<typeof callback>[0])
            return
          }
          // Windows: audio 'loopback' 會擷取系統播放中的音訊
          callback({ video: sources[0], audio: 'loopback' } as Parameters<typeof callback>[0])
        })
        .catch(() => callback({} as Parameters<typeof callback>[0]))
    },
    { useSystemPicker: false }
  )
}
