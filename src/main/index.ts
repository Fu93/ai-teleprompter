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
import { pushTranscript, getRecentContext } from './liveContext'
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

function deliverRescue(payload: RescuePayload): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) setOverlayVisible(true)
  overlayWindow?.webContents.send(IPC.PanicRescue, payload)
}

async function handlePanic(): Promise<void> {
  if (panicInFlight) return
  panicInFlight = true
  try {
    const scene = getScene(settings.scenario.activeScene)
    const mode = settings.scenario.panicMode

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
  } finally {
    panicInFlight = false
  }
}

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let lastOverlayPayload: { title?: string; content?: string } = {}

const isDev = !app.isPackaged

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
  overlayWindow = new BrowserWindow({
    width: settings.overlay.width,
    height: settings.overlay.height,
    minWidth: 280,
    minHeight: 140,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
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
    win.showInactive() // 不搶焦點，避免打斷正在使用的應用
  } else {
    win.hide()
  }
}

function notifyOverlayVisibility(visible: boolean): void {
  mainWindow?.webContents.send(IPC.OverlayVisibilityChanged, visible)
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
    if (speaker === 'them') conversation.add('them', args.text)
    else if (speaker === 'me') conversation.add('self', args.text)
    return true
  })

  ipcMain.handle(IPC.PanicTrigger, () => {
    void handlePanic()
    return true
  })

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
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
