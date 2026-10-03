import { app, desktopCapturer, dialog, globalShortcut, ipcMain, powerSaveBlocker, screen, session, shell, webContents } from 'electron'
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
import type { DebugOverlayInfo, OverlayShowPayload } from '@shared/api'
import { canSyncOverlayScript } from '@shared/overlayScript'
import { AUDIT, DEBUG, E2E_ENV } from './debug'
import { deepMerge, saveSettings, saveSettingsThrottled } from './settings'
import { abortOllamaChat, ollamaChat, ollamaListModels, ollamaVersion } from './ollama'
import { describeOutboundDenial, normalizeCloudEndpointUrl } from './ai/outboundEndpoint'
import { chatCompletion, testConnection, getUserKeys, setUserKeys } from './ai/aiProvider'
import { releaseRequest, trackRequest } from './ai/aiAbort'
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
import { recordEvent } from './events'
import { buildDiagnosticsReport } from './diagnostics'
import type { EventPayload } from '@shared/observability'
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
    /**
     * `startup_hotkey_conflict` —— 宣告了很久,但沒有任何呼叫端。
     *
     * 沒有這一筆的症狀很難講:使用者說「Ctrl+Shift+P 沒反應」,而我們看到的
     * 日誌裡「App 正常啟動、主視窗正常」—— 兩邊都對,拼不出問題。
     * 有了它,`grep startup_hotkey_conflict` 就能分出「沒衝突」與「有衝突但
     * 他不知道是什麼」;而 conflict count 是**數量**而不是名單,因為六個欄位
     * 名稱都是已知的(與 diagnostics.ts 的 hotkey_conflict_count 同一個理由)。
     */
    recordEvent({
      name: 'startup_hotkey_conflict',
      // 只放**數量**,不放 accelerator 本身。
      // accelerator 是使用者自己設定的字串,而日誌會隨著「回報問題時附上」
      // 離開這台電腦 —— 「有幾個被佔走 / 總共幾個」就足以定位問題。
      metrics: { count: taken.length, total: Object.keys(state.settings.hotkeys).length }
    })
  } else {
    state.hotkeyConflicts = []
  }
}

/**
 * request.frame 是否屬於本 app 的視窗:沿 parent 走到根框架,再對照所有
 * webContents 的主框架。setDisplayMediaRequestHandler 若不驗來源,任何 frame 的
 * getDisplayMedia 都會自動拿到螢幕影像與系統音訊 —— renderer 被注入時等於
 * 靜默錄製整台機器的聲音。
 */
function isOurFrame(frame: unknown): boolean {
  if (!frame) return false
  try {
    let f = frame as Electron.WebFrameMain
    while (f.parent) f = f.parent
    return webContents.getAllWebContents().some((wc) => wc.mainFrame === f)
  } catch {
    return false // 框架已銷毀等狀況:一律當「不是我們的」
  }
}

export function registerIpc(): void {
  const settings = (): AppSettings => state.settings

  ipcMain.handle(IPC.SettingsGet, () => settings())

  ipcMain.handle(IPC.SettingsSet, (_e, patch: unknown) => {
    // 形狀不對的 patch 直接拒絕:deepMerge 對非物件原樣回傳,一筆 null 就會把
    // state.settings 變 null、'null' 寫進 settings.json,而且啟動載入經同一條
    // deepMerge 又是 null —— 只能刪檔救援。renderer 是可信的,但「可信的呼叫端
    // 寫錯一次」與「設定永久損壞」之間不該只隔一層型別斷言。
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return state.settings
    }
    const hotkeysBefore = JSON.stringify(state.settings.hotkeys)
    state.settings = deepMerge(state.settings, patch)
    saveSettingsThrottled(state.settings)
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
    state.overlayWindow?.webContents.send(IPC.OverlayLoadScript, state.lastOverlayPayload)
  })

  ipcMain.handle(IPC.OverlayGetLastPayload, () => state.lastOverlayPayload)

  /**
   * 主視窗改稿 → 浮層換稿(2026-10-03)。
   *
   * 為什麼需要:浮層內容只在 OverlayShow 收到一次,所以「改一句稿 → 立刻上台」
   * 這個主流程會讓使用者站在台上講舊版,而且畫面上沒有任何地方說明它是舊的。
   *
   * 為什麼不直接每次存檔都推:使用者編輯 A 稿(浮層正在講 A)時存檔 B 稿是正常
   * 操作,那時換掉浮層等於**把沒人要的稿子推上舞台**。所以規則是「同一份稿才同步」
   * (見 shared/overlayScript.ts),而 payload 帶 scriptId 就是為了能做這個判斷。
   *
   * 刻意不呼叫 setOverlayVisible:使用者是存檔不是要求開浮層,同步不應該叫出視窗。
   * 回傳是否真的同步了,呼叫端可用它決定要不要提示(現在只用於除錯與日誌)。
   */
  ipcMain.handle(IPC.OverlaySync, (_e, payload: OverlayShowPayload) => {
    if (!canSyncOverlayScript(state.lastOverlayPayload, payload)) return false
    state.lastOverlayPayload = { ...payload }
    const win = state.overlayWindow
    // isDestroyed 守衛:存檔是日常操作,而浮層視窗關閉/重建之間是有空窗的,
    // 在那裡 send 會拋「Object has been destroyed」而讓整次存檔失敗。
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.OverlayLoadScript, state.lastOverlayPayload)
    }
    return true
  })

  ipcMain.handle(IPC.OverlayHide, () => setOverlayVisible(false))
  ipcMain.handle(IPC.OverlayToggle, () => setOverlayVisible(!(state.overlayWindow?.isVisible() ?? false)))
  ipcMain.handle(IPC.OverlayIsVisible, () => state.overlayWindow?.isVisible() ?? false)

  ipcMain.handle(IPC.OverlaySetClickThrough, (_e, v: boolean) => {
    state.settings.overlay.clickThrough = v
    saveSettingsThrottled(state.settings)
    applyOverlayWindowSettings()
    broadcastSettings()
  })

  ipcMain.handle(IPC.OverlaySetCaptureProtection, (_e, v: boolean) => {
    state.settings.overlay.captureProtected = v
    saveSettingsThrottled(state.settings)
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
    hotkeyConflicts: [...state.hotkeyConflicts],
    /**
     * e2e 環境情境。renderer 用它在 getUserMedia / fetch 的邊界注入故障,
     * 而「測試跑在哪個世界裡」需要一個單一出處 —— 否則 e2e 失敗時只能猜。
     *
     * 打包版裡這一定是 E2E_ENV_DEFAULT(兩個 'ok'),見 debug.ts 的說明。
     */
    e2eEnv: E2E_ENV
  }))

  // ---- AI (Ollama) ----
  ipcMain.handle(IPC.OllamaListModels, async (_e, baseUrl: string) => {
    try {
      const [models, version] = await Promise.all([
        ollamaListModels(baseUrl),
        ollamaVersion(baseUrl)
      ])
      return { models, version, installed: version !== null }
    } catch (err) {
      // 連不上/網址打錯會在這裡拋例外:不接的話 renderer 只會收到 Electron 的
      // 泛用「Error invoking remote method」,使用者無從判斷是 Ollama 沒開還是網址錯。
      throw new Error(`連不上 Ollama(${err instanceof Error ? err.message : String(err)})`)
    }
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
    requestId: string
    baseUrl: string
    apiKey: string
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    temperature?: number
  }) => {
    // 出站端點必須先過政策,再做任何事。
    //
    // 為什麼在這裡擋:baseUrl 是從 renderer 送上來的,而這兩條路徑原本是字串拼接
    // 後直接 fetch()。同一份設定走 aiProvider.resolveEndpoint 會被擋、走這裡不會
    // —— 使用者看到的行為取決於他按了哪個按鈕。出站政策集中在一處才叫政策
    // (理由見 ai/outboundEndpoint.ts 檔頭)。
    const endpoint = normalizeCloudEndpointUrl(req.baseUrl, '/chat/completions')
    if (!endpoint.ok) {
      // 回 { ok:false } 而不是 throw:這兩條路徑的呼叫端(Record / Practice /
      // Calibration)已經把錯誤訊息顯示給使用者了,throw 會讓它們拿到 Electron
      // 的泛用錯誤字串,把真正的原因吃掉。
      return { ok: false, error: describeOutboundDenial(endpoint.reason) }
    }
    // 雲端也進同一張登錄表:「只有本地 Ollama 可取消」是使用者最不會預期的組合
    // —— 他按了取消,本機模型停了,雲端那邊還在跑而且仍在計費。
    const controller = trackRequest(req.requestId)
    const timeout = setTimeout(() => controller.abort(), 180_000)
    try {
      const secureAiKey = getUserKeys()?.apiKey
      const apiKey = typeof secureAiKey === 'string' && secureAiKey ? secureAiKey : req.apiKey
      const res = await fetch(endpoint.url, {
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
        signal: controller.signal
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
      // 逾時與取消共用這條路徑,對呼叫端來說是同一件事:這次呼叫沒有結果。
      if (controller.signal.aborted) return { ok: false, error: '已取消' }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timeout)
      releaseRequest(req.requestId)
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
    // 同 OpenAiChat:出站端點先過政策。STT 這條尤其不該漏 ——
    // 它會把**錄音內容** POST 出去,擋下來等於少洩漏一次使用者的聲音。
    const endpoint = normalizeCloudEndpointUrl(args.baseUrl, '/audio/transcriptions')
    if (!endpoint.ok) {
      return { ok: false, error: describeOutboundDenial(endpoint.reason) }
    }
    try {
      const secureSttKey = getUserKeys()?.sttApiKey
      const apiKey = typeof secureSttKey === 'string' && secureSttKey ? secureSttKey : args.apiKey
      const form = new FormData()
      form.append('file', new Blob([args.audio], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', args.model)
      if (args.language && args.language !== 'auto') form.append('language', args.language)
      const res = await fetch(endpoint.url, {
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
    try {
      await writeFile(filePath, Buffer.from(args.bytes))
    } catch (err) {
      // 磁碟滿/唯讀/路徑無效:讓使用者知道是「存不下」而不是「app 壞了」
      throw new Error(`影片存檔失敗(${err instanceof Error ? err.message : String(err)})`)
    }
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
    // 用「目前遮住浮層最多的那台螢幕」而不是一律主螢幕:浮層在外接/投影
    // 螢幕上時,吸附到主螢幕等於把它從使用者眼前拽走(與 ensureOverlayOnScreen
    // 的多螢幕原則同一條,見 windows.ts)。
    const { workArea } = screen.getDisplayMatching(state.overlayWindow.getBounds())
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
  // 「正在錄音」是給退出流程讀的事實,與給人看的 closeBlocker 分開存。
  ipcMain.handle(IPC.AppSetRecording, (_e, recording: unknown) => {
    state.isRecording = recording === true
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
  ipcMain.handle(IPC.RevealPath, async (_e, path: string) => {
    if (!path || typeof path !== 'string') return
    // 只 reveal 真的存在檔案:呼叫端是「開啟錄影檔所在資料夾」,路徑來自
    // 存檔對話框;存在性檢查讓壞路徑(檔案已被移走/改名)安靜地無事發生,
    // 而不是開一個空的檔案總管視窗讓使用者以為 app 瘋了。
    try {
      const info = await stat(path)
      if (!info.isFile()) return
    } catch {
      return
    }
    shell.showItemInFolder(path)
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

  // ---- 結構化事件(純本機)----
  // 遮蔽在 main 端的 recordEvent 裡做(shared/observability.ts 的 redactEventFields),
  // 這裡**不**再過濾一次:兩層各過濾一次會讓「到底遮了什麼」沒有單一出處,
  // 而遮蔽規則正是這個功能唯一不能出錯的部分。
  ipcMain.handle(IPC.LogEvent, (_e, payload: EventPayload) => {
    recordEvent(payload)
  })

  ipcMain.handle(IPC.DiagnosticsReport, () => {
    recordEvent({ name: 'diagnostics_report_requested' })
    // 熱鍵衝突數**必須傳進去**:不傳的話報告會寫 0,而「六個熱鍵全部被佔走」
    // 正是使用者會來回報的那件事 —— 一個寫 0 的欄位會讓我們主動排除它。
    return buildDiagnosticsReport(state.settings, { hotkeyConflicts: state.hotkeyConflicts.length })
  })

  // ---- 匯出檔案 ----
  ipcMain.handle(IPC.ExportFile, async (_e, args: { defaultName: string; content: string }) => {
    if (!state.mainWindow) return { ok: false, error: 'no-window' }
    const { canceled, filePath } = await dialog.showSaveDialog(state.mainWindow, {
      defaultPath: args.defaultName
    })
    if (canceled || !filePath) return { ok: false, error: 'canceled' }
    try {
      await writeFile(filePath, args.content, 'utf-8')
    } catch (err) {
      throw new Error(`匯出失敗,檔案沒有寫入(${err instanceof Error ? err.message : String(err)})`)
    }
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
    let info: Awaited<ReturnType<typeof stat>>
    let text: string
    try {
      info = await stat(filePath)
      text = await readFile(filePath, 'utf-8')
    } catch (err) {
      throw new Error(`讀取備份檔失敗(${err instanceof Error ? err.message : String(err)})`)
    }
    if (info.size > max) {
      return { ok: false, error: `檔案太大（${Math.round(info.size / 1024 / 1024)}MB）,這不像是備份檔。` }
    }
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

  // ---- 電源:錄音/轉錄期間阻止系統睡眠 ----
  // 開會的人常常已經沒在碰電腦(正是系統會想睡覺的時候),而 OS 睡眠會直接
  // 打斷擷取與逐字稿,app 端無警示也無恢復。'prevent-app-suspension' 不阻止
  // 螢幕變暗;app 退出時 Electron 會自動清掉 blocker,不需要額外收尾。
  let powerSaveId: number | null = null
  ipcMain.handle(IPC.PowerSaveStart, () => {
    if (powerSaveId === null || !powerSaveBlocker.isStarted(powerSaveId)) {
      powerSaveId = powerSaveBlocker.start('prevent-app-suspension')
    }
    return true
  })
  ipcMain.handle(IPC.PowerSaveStop, () => {
    if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) powerSaveBlocker.stop(powerSaveId)
    powerSaveId = null
    return true
  })

  // ---- 錄音/錄影中的環境指示(見 IPC.WindowCaptureIndicator)----
  // 最小化後「還在錄」是完全不可見的:攝影機/麥克風指示燈在機殼上,
  // 而工作列底下的視窗看起來與平時一樣。標題 + 工作列閃爍是不需要平台
  // 資源的最小解(tray 圖示留獨立一輪,見 docs/UX_FINDINGS.md P2 附錄 #1)。
  // 還原值 'AI 提詞機' = createMainWindow 的 title(見 windows.ts),兩處同字串。
  ipcMain.handle(IPC.WindowCaptureIndicator, (_e, s: { active: boolean; label?: string }) => {
    const win = state.mainWindow
    if (!win || win.isDestroyed()) return
    win.setTitle(s?.active ? s.label || 'AI 提詞機' : 'AI 提詞機')
    // flashFrame(true):Windows/Linux 閃工作列直到視窗取得焦點;macOS 是 dock
    // 退避一次。停止時呼叫 false 只是停止目前的閃爍,不會反向閃。
    win.flashFrame(!!s?.active)
  })

  // ---- 設定頁「重新啟動以套用更新」----
  // quit 走正常關閉流程:electron-updater 的 autoInstallOnAppQuit 掛在 quit 上,
  // 用 app.exit() 反而不會安裝更新。
  ipcMain.handle(IPC.AppRelaunch, () => {
    app.relaunch()
    app.quit()
  })

  // ---- 系統音訊 loopback 授權（Windows）----
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // 只核准自家視窗的要求(見 isOurFrame 的說明)
      if (!isOurFrame(request.frame)) {
        callback({} as Parameters<typeof callback>[0])
        return
      }
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
