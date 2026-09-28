import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } from 'electron'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import os from 'os'
import {
  AppInfo,
  AppSettings,
  IPC,
  RescuePayload
} from '@shared/types'
import { loadSettings, saveSettings, deepMerge } from './settings'
import { abortOllamaChat, ollamaChat, ollamaListModels, ollamaVersion } from './ollama'
import { chatCompletion, testConnection, getUserKeys, setUserKeys, resolveProvider } from './ai/aiProvider'
import { getScene, ConversationTracker, buildPanicSystemPrompt, pickFallbackTemplate } from './context-engine/scenes'
import { buildPanicPrompt, parseRescueResponse, computeConfidence, structuredFallback } from './context-engine/panicAi'
import { pushTranscript, getRecentContext, clearContext } from './liveContext'
import {
  createTurnYieldState,
  evaluateTurnYield,
  recordTurnYield,
  resetTurnYieldState
} from './context-engine/turnYield'
import {
  checkDeadAir,
  checkInterrupt,
  createCoachingState,
  onMeSegment,
  onThemSegment,
  resetCoachingState,
  type CoachingKind,
  type CoachingSignal as EngineSignal
} from './context-engine/coachingRules'
import { listAllScenes } from './packs'

// panic 的 provider 差異化 timeout(v3:Groq 900ms / Ollama 2500ms / 其他 1500ms)
function panicTimeoutMs(): number {
  const resolved = resolveProvider(settings)
  if (!resolved) return 1500
  if (resolved.cfg.id === 'groq') return 900
  if (resolved.cfg.isLocal) return 2500
  return 1500
}

let panicInFlight = false
const conversation = new ConversationTracker(6)

// turn-yield(Phase B):對方講完問句 → 提示「該你說話了」
const turnYieldState = createTurnYieldState()
let turnYieldTimer: ReturnType<typeof setTimeout> | null = null
let turnYieldPending: { kind: 'turn' | 'peer_silence'; question: boolean } | null = null

// 即時教練:語速/填充詞/損話/冷場/獨白(Phase B+)
const coachingState = createCoachingState()
let coachingTimer: ReturnType<typeof setInterval> | null = null
/** 會議期間各 coaching 訊號觸發次數(會後報告用;contextReset 歸零) */
const coachingCounts: Partial<Record<CoachingKind, number>> = {}

function coachingOptions(): { baselineCpm: number } {
  return { baselineCpm: settings.personal.profile?.charsPerMin ?? 0 }
}

/** 開始/停止冷場週期檢查(2s); coaching 關閉時停掉 */
function syncCoachingTimer(): void {
  const want = settings.overlay.coaching
  if (want && coachingTimer === null) {
    coachingTimer = setInterval(() => {
      const signal = checkDeadAir(coachingState, Date.now(), coachingOptions())
      if (signal) deliverCoaching(signal)
    }, 2_000)
  } else if (!want && coachingTimer !== null) {
    clearInterval(coachingTimer)
    coachingTimer = null
  }
}

function deliverCoaching(signal: EngineSignal): void {
  coachingCounts[signal.kind] = (coachingCounts[signal.kind] ?? 0) + 1
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.webContents.send(IPC.CoachingSignal, {
    kind: signal.kind,
    message: signal.message,
    at: Date.now()
  })
}

function onMeSegmentForCoaching(text: string): void {
  if (!settings.overlay.coaching) return
  const now = Date.now()
  // 搶話判定要先於段統計(需要「對方剛講完」的時間戳)
  const interrupt = checkInterrupt(coachingState, now, coachingOptions())
  if (interrupt) deliverCoaching(interrupt)
  const signal = onMeSegment(coachingState, text, now, coachingOptions())
  if (signal) deliverCoaching(signal)
}

function onThemSegmentForCoaching(text: string): void {
  if (!settings.overlay.coaching) return
  onThemSegment(coachingState, text, Date.now(), coachingOptions())
}

function deliverRescue(payload: RescuePayload): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) setOverlayVisible(true)
  overlayWindow?.webContents.send(IPC.PanicRescue, payload)
}

function sendTurnYield(kind: 'turn' | 'peer_silence', question: boolean): void {
  if (!settings.overlay.turnYield) return
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.webContents.send(IPC.TurnYieldSignal, { kind, question, at: Date.now() })
}

function cancelTurnYield(): void {
  turnYieldPending = null
  if (turnYieldTimer) {
    clearTimeout(turnYieldTimer)
    turnYieldTimer = null
  }
}

/** 會話邊界:清空語音上下文與即時回饋狀態(Record 起停、新場次呼叫) */
function resetSessionContext(): void {
  clearContext()
  conversation.turns.length = 0
  resetTurnYieldState(turnYieldState)
  cancelTurnYield()
  resetCoachingState(coachingState)
  for (const k of Object.keys(coachingCounts) as CoachingKind[]) {
    delete coachingCounts[k]
  }
}

/** 對方新段落 → 問句/長段評估;1.2s 防抖後提示浮層(等可能接續的後半句)。
 *  turn 問句優先於 peer_silence(長段)——被問倒比「對方停頓」更值得提示 */
function evaluateTurnYieldForSegment(text: string): void {
  if (!settings.overlay.turnYield) return // 關閉時不評估也不記冷卻
  const now = Date.now()
  const result = evaluateTurnYield(turnYieldState, text, now)
  if (!result) return
  recordTurnYield(turnYieldState, result, now)
  // turn 優先:已有 pending 時只升級不降級(peer_silence 不覆蓋 turn)
  if (turnYieldPending?.kind === 'turn' && result.kind === 'peer_silence') return
  turnYieldPending = { kind: result.kind, question: result.question }
  if (turnYieldTimer) clearTimeout(turnYieldTimer)
  turnYieldTimer = setTimeout(() => {
    turnYieldTimer = null
    if (!turnYieldPending) return
    sendTurnYield(turnYieldPending.kind, turnYieldPending.question)
    turnYieldPending = null
  }, 1200)
}

async function handlePanic(): Promise<void> {
  if (panicInFlight) return
  panicInFlight = true
  // 場景查表純函數(getScene 對未知 key 也有 fallback),放 try 外讓 catch 專注 AI 鏈路
  const scene = getScene(settings.scenario.activeScene)
  const mode = settings.scenario.panicMode
  try {
    // AI 關閉:直接場景模板,不出 AI 卡
    if (!settings.scenario.aiModeEnabled) {
      deliverRescue({
        sentence: pickFallbackTemplate(scene, conversation),
        points: scene.label,
        confidence: 0.2,
        source: 'template',
        scene: scene.key
      })
      return
    }

    deliverRescue({ sentence: '', points: '', confidence: 0, source: 'template' }) // thinking 前哨(清舊卡)
    overlayWindow?.webContents.send(IPC.PanicThinking)

    // 上下文:最近的轉錄;若尚無語音,退而求其次用目前講稿結尾
    let context = getRecentContext()
    if (context.startsWith('(no recent speech')) {
      const script = (lastOverlayPayload.content ?? '').trim()
      if (script) context = script.slice(-600)
    }

    const result = await chatCompletion(
      settings,
      [
        { role: 'system', content: buildPanicSystemPrompt(scene, conversation) },
        { role: 'user', content: buildPanicPrompt(mode, context) }
      ],
      { maxTokens: 120, temperature: 0.7, timeoutMs: panicTimeoutMs() }
    )

    const parsed = result.ok && result.text ? parseRescueResponse(result.text) : null
    if (!parsed) {
      overlayWindow?.webContents.send(IPC.PanicError, result.error ?? 'AI 回應無法解析,已用模板救援')
      deliverRescue(structuredFallback(mode))
      return
    }

    deliverRescue({
      sentence: parsed.sentence,
      points: parsed.points,
      confidence: computeConfidence(parsed.confidence, context, parsed.sentence, parsed.points),
      source: 'ai',
      scene: scene.key
    })
  } catch (err) {
    // AI 層正常會把錯誤轉成 result.ok=false;這裡是 provider 層拋例外的最後防線。
    // 沒有它 panicInFlight 會卡在 true,panic 從此無反應。
    overlayWindow?.webContents.send(IPC.PanicError, err instanceof Error ? err.message : String(err))
    deliverRescue(structuredFallback(mode))
  } finally {
    panicInFlight = false
  }
}

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let lastOverlayPayload: { title?: string; content?: string } = {}

const isDev = !app.isPackaged

// e2e 隔離:測試進程以 AI_TP_E2E=1 啟動時,把 userData 重導到暫存目錄,
// 測試建立的講稿/會議/設定不會汙染真實使用者資料(真實發生過:測試講稿出現在使用者 Dashboard)
if (process.env['AI_TP_E2E'] === '1') {
  app.setPath('userData', join(app.getPath('temp'), `ai-teleprompter-e2e-${Date.now()}`))
}

/** 視窗安全:禁新視窗;僅允許 dev server 或本地檔案內部導航 */
function hardenWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    const devBase = process.env['ELECTRON_RENDERER_URL']
    const allowed = isDev && devBase ? url.startsWith(devBase) : url.startsWith('file://')
    if (!allowed) e.preventDefault()
  })
}

// ---------- 設定 ----------
let settings: AppSettings = loadSettings()

function broadcastSettings(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.OverlaySettingsChanged, settings)
  }
}

function applyOverlayWindowSettings(): void {
  if (!overlayWindow) return
  const o = settings.overlay
  overlayWindow.setContentProtection(o.captureProtected)
  overlayWindow.setIgnoreMouseEvents(o.clickThrough, { forward: true })
  overlayWindow.setAlwaysOnTop(o.alwaysOnTop, 'screen-saver')
  // 玻璃質感:Win11 22H2+ 嘗試視窗後 acrylic 毛玻璃;不支援或失敗則靜默降級(CSS 玻璃仍生效)
  try {
    const win11 = process.platform === 'win32' && Number(os.release().split('.')[0]) >= 10 && Number(os.release().split('.')[2]) >= 22621
    if (o.glass && win11) {
      overlayWindow.setBackgroundMaterial('acrylic')
    } else {
      overlayWindow.setBackgroundMaterial('auto')
    }
  } catch {
    // 忽略:舊版 Electron/OS 不支援
  }
  if (!overlayWindow.isDestroyed()) {
    const [w, h] = overlayWindow.getSize()
    if (w !== o.width || h !== o.height) overlayWindow.setSize(o.width, o.height)
  }
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll()
  const { toggleOverlay, hideOverlay, panicRescue } = settings.hotkeys
  try {
    if (toggleOverlay) {
      globalShortcut.register(toggleOverlay, () => {
        const visible = overlayWindow?.isVisible() ?? false
        setOverlayVisible(!visible)
      })
    }
    if (hideOverlay) {
      globalShortcut.register(hideOverlay, () => setOverlayVisible(false))
    }
    if (panicRescue) {
      globalShortcut.register(panicRescue, () => {
        void handlePanic()
      })
    }
    // 播放/語速熱鍵:浮層可被滑鼠穿透或失焦,全域熱鍵是唯一可靠入口。
    // 廣播給浮層;未顯示時忽略(visibility sync 由 setOverlayVisible 管)
    if (settings.hotkeys.playPause) {
      globalShortcut.register(settings.hotkeys.playPause, () => {
        if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
          overlayWindow.webContents.send(IPC.OverlayPlayPause)
        }
      })
    }
    if (settings.hotkeys.speedUp) {
      globalShortcut.register(settings.hotkeys.speedUp, () => {
        if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
          overlayWindow.webContents.send(IPC.OverlaySpeedStep, 1)
        }
      })
    }
    if (settings.hotkeys.speedDown) {
      globalShortcut.register(settings.hotkeys.speedDown, () => {
        if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
          overlayWindow.webContents.send(IPC.OverlaySpeedStep, -1)
        }
      })
    }
  } catch (err) {
    console.error('熱鍵註冊失敗', err)
  }
}

// ---------- 視窗 ----------
function createMainWindow(): void {
  mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  hardenWebContents(mainWindow)

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createOverlayWindow(): void {
  // 還原上次位置前先驗證還在任一螢幕範圍內:拔掉外接螢幕後舊座標會落於畫面外,
  // 不驗證的話浮層會「消失」,使用者只能刪 settings.json 救回
  const savedPos =
    settings.overlay.x !== null && settings.overlay.y !== null &&
    screen.getAllDisplays().some(
      (d) =>
        settings.overlay.x! >= d.bounds.x - 40 &&
        settings.overlay.x! < d.bounds.x + d.bounds.width &&
        settings.overlay.y! >= d.bounds.y - 40 &&
        settings.overlay.y! < d.bounds.y + d.bounds.height
    )
      ? { x: settings.overlay.x, y: settings.overlay.y }
      : {}
  overlayWindow = new BrowserWindow({
    width: settings.overlay.width,
    height: settings.overlay.height,
    minWidth: 280,
    minHeight: 40,
    ...savedPos,
    frame: false,
    transparent: true,
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
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  applyOverlayWindowSettings()
  hardenWebContents(overlayWindow)

  overlayWindow.on('hide', () => notifyOverlayVisibility(false))
  overlayWindow.on('show', () => notifyOverlayVisibility(true))
  // 記住使用者拖過的位置:防抖 600ms 落盤,拖動中不狂寫 settings.json
  let moveSaveTimer: ReturnType<typeof setTimeout> | null = null
  overlayWindow.on('moved', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const [x, y] = overlayWindow.getPosition()
    settings.overlay.x = x
    settings.overlay.y = y
    if (moveSaveTimer) clearTimeout(moveSaveTimer)
    moveSaveTimer = setTimeout(() => saveSettings(settings), 600)
  })
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/overlay`)
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }
}

function setOverlayVisible(visible: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    if (visible) createOverlayWindow()
    else return
  }
  const win = overlayWindow!
  if (visible) {
    // 點擊穿透是單向門:穿透中浮層收不到任何滑鼠事件,原設計唯一的解除入口在主視窗設定頁。
    // 重新顯示浮層(熱鍵或「提詞」按鈕)時自動解除,工具列恢復可點;要再穿透按一下工具列即可。
    if (settings.overlay.clickThrough) {
      settings.overlay.clickThrough = false
      saveSettings(settings)
      applyOverlayWindowSettings()
      broadcastSettings()
    }
    win.showInactive() // 不搶焦點，避免打斷正在使用的應用
  } else {
    win.hide()
  }
}

function notifyOverlayVisibility(visible: boolean): void {
  mainWindow?.webContents.send(IPC.OverlayVisibilityChanged, visible)
}

/** 主視窗關閉後的浮層續命寬限;到期仍可見則再等一輪,隱藏後退出整個 app */
const QUIT_GRACE_MS = 10_000
function quitWhenOverlayHidden(): void {
  setTimeout(() => {
    const overlayVisible = overlayWindow !== null && !overlayWindow.isDestroyed() && overlayWindow.isVisible()
    if (overlayVisible) quitWhenOverlayHidden()
    else app.quit()
  }, QUIT_GRACE_MS)
}

// ---------- IPC ----------
function registerIpc(): void {
  ipcMain.handle(IPC.SettingsGet, () => settings)

  ipcMain.handle(IPC.SettingsSet, (_e, patch: unknown) => {
    settings = deepMerge(settings, patch)
    saveSettings(settings)
    applyOverlayWindowSettings()
    broadcastSettings()
    registerHotkeys()
    syncCoachingTimer()
    return settings
  })

  ipcMain.handle(IPC.OverlayShow, (_e, payload: { title?: string; content?: string }) => {
    lastOverlayPayload = payload ?? {}
    setOverlayVisible(true)
    overlayWindow?.webContents.send('overlay:load-script', lastOverlayPayload)
  })

  ipcMain.handle(IPC.OverlayGetLastPayload, () => lastOverlayPayload)

  ipcMain.handle(IPC.OverlayHide, () => setOverlayVisible(false))
  ipcMain.handle(IPC.OverlayToggle, () => setOverlayVisible(!(overlayWindow?.isVisible() ?? false)))
  ipcMain.handle(IPC.OverlayIsVisible, () => overlayWindow?.isVisible() ?? false)

  ipcMain.handle(IPC.OverlaySetClickThrough, (_e, v: boolean) => {
    settings.overlay.clickThrough = v
    saveSettings(settings)
    applyOverlayWindowSettings()
    broadcastSettings()
  })

  ipcMain.handle(IPC.OverlaySetCaptureProtection, (_e, v: boolean) => {
    settings.overlay.captureProtected = v
    saveSettings(settings)
    applyOverlayWindowSettings()
    broadcastSettings()
  })

  ipcMain.handle(IPC.OverlaySetSize, (_e, w: number, h: number) => {
    settings.overlay.width = Math.max(240, Math.round(w))
    settings.overlay.height = Math.max(40, Math.round(h))
    saveSettings(settings)
    applyOverlayWindowSettings()
  })

  /** 動畫用即時尺寸:每幀呼叫,只改視窗與記憶體設定,不落盤(結束時由 OverlaySetSize 定案)。
   *  刻意不走 applyOverlayWindowSettings:那裡含 setContentProtection/setIgnoreMouseEvents/
   *  setBackgroundMaterial 與 os.release 解析,每幀 60 次全是浪費,morph 只需要 setSize */
  ipcMain.handle(IPC.OverlaySetSizeLive, (_e, w: number, h: number) => {
    settings.overlay.width = Math.max(240, Math.round(w))
    settings.overlay.height = Math.max(40, Math.round(h))
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setSize(settings.overlay.width, settings.overlay.height)
    }
  })

  ipcMain.handle(IPC.AppInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    userDataPath: app.getPath('userData')
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
      const text = await ollamaChat(req, settings)
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
      const res = await fetch(`${req.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {})
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
      const form = new FormData()
      form.append('file', new Blob([args.audio], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', args.model)
      if (args.language && args.language !== 'auto') form.append('language', args.language)
      const res = await fetch(`${args.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : undefined,
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
    if (!mainWindow) return { ok: false, error: 'no-window' }
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
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
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const { workArea } = screen.getPrimaryDisplay()
    const [w] = overlayWindow.getSize()
    const x = corner === 'tl' ? workArea.x + 8 : corner === 'tr' ? workArea.x + workArea.width - w - 8 : workArea.x + Math.round((workArea.width - w) / 2)
    overlayWindow.setPosition(x, workArea.y + 8)
  })

  // ---- 在檔案總管顯示檔案 ----
  ipcMain.handle(IPC.RevealPath, (_e, path: string) => {
    if (path && typeof path === 'string') shell.showItemInFolder(path)
  })

  // ---- 匯出檔案 ----
  ipcMain.handle(IPC.ExportFile, async (_e, args: { defaultName: string; content: string }) => {
    if (!mainWindow) return { ok: false, error: 'no-window' }
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: args.defaultName
    })
    if (canceled || !filePath) return { ok: false, error: 'canceled' }
    await writeFile(filePath, args.content, 'utf-8')
    return { ok: true, filePath }
  })

  // ---- Phase C:統一 AI / 金鑰 / panic / 場景 ----
  ipcMain.handle(IPC.AiChatCompletion, async (_e, req: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    maxTokens?: number
    temperature?: number
    jsonMode?: boolean
    timeoutMs?: number
  }) => {
    return chatCompletion(settings, req.messages, req)
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

  ipcMain.handle(IPC.ContextPushTranscript, (_e, args: { text: string; speaker?: 'me' | 'them' | 'unknown' }) => {
    const speaker = args.speaker ?? 'unknown'
    pushTranscript(args.text, speaker)
    if (speaker === 'them') {
      conversation.add('them', args.text)
      evaluateTurnYieldForSegment(args.text)
      onThemSegmentForCoaching(args.text)
    } else if (speaker === 'me') {
      conversation.add('self', args.text)
      // 我方發言:取消未發出的提示(你已在回話;顯示中的提示由 UI 層收掉)
      cancelTurnYield()
      onMeSegmentForCoaching(args.text)
    }
    return true
  })

  ipcMain.handle(IPC.PanicTrigger, () => {
    void handlePanic()
    return true
  })

  ipcMain.handle(IPC.ContextReset, () => {
    resetSessionContext()
  })

  ipcMain.handle(IPC.CoachingStatsGet, () => coachingCounts)

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

// ---------- 生命週期 ----------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpc()
    createMainWindow()
    createOverlayWindow()
    registerHotkeys()
    syncCoachingTimer()
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
