import { app, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } from 'electron'
import { writeFile } from 'fs/promises'
import { AppInfo, IPC, type AppSettings } from '@shared/types'
import { deepMerge, saveSettings } from './settings'
import { abortOllamaChat, ollamaChat, ollamaListModels, ollamaVersion } from './ollama'
import { chatCompletion, testConnection, getUserKeys, setUserKeys } from './ai/aiProvider'
import { listAllScenes } from './packs'
import { broadcastSettings, state } from './state'
import { applyOverlayWindowSettings, setOverlayVisible } from './windows'
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
  try {
    if (toggleOverlay) {
      globalShortcut.register(toggleOverlay, () => {
        const visible = state.overlayWindow?.isVisible() ?? false
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
    if (state.settings.hotkeys.playPause) {
      globalShortcut.register(state.settings.hotkeys.playPause, () => {
        if (state.overlayWindow && !state.overlayWindow.isDestroyed() && state.overlayWindow.isVisible()) {
          state.overlayWindow.webContents.send(IPC.OverlayPlayPause)
        }
      })
    }
    if (state.settings.hotkeys.speedUp) {
      globalShortcut.register(state.settings.hotkeys.speedUp, () => {
        if (state.overlayWindow && !state.overlayWindow.isDestroyed() && state.overlayWindow.isVisible()) {
          state.overlayWindow.webContents.send(IPC.OverlaySpeedStep, 1)
        }
      })
    }
    if (state.settings.hotkeys.speedDown) {
      globalShortcut.register(state.settings.hotkeys.speedDown, () => {
        if (state.overlayWindow && !state.overlayWindow.isDestroyed() && state.overlayWindow.isVisible()) {
          state.overlayWindow.webContents.send(IPC.OverlaySpeedStep, -1)
        }
      })
    }
  } catch (err) {
    console.error('熱鍵註冊失敗', err)
  }
}

export function registerIpc(): void {
  const settings = (): AppSettings => state.settings

  ipcMain.handle(IPC.SettingsGet, () => settings())

  ipcMain.handle(IPC.SettingsSet, (_e, patch: unknown) => {
    state.settings = deepMerge(state.settings, patch)
    saveSettings(state.settings)
    applyOverlayWindowSettings()
    broadcastSettings()
    registerHotkeys()
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

  ipcMain.handle(IPC.OverlaySetSize, (_e, w: number, h: number) => {
    state.settings.overlay.width = Math.max(240, Math.round(w))
    state.settings.overlay.height = Math.max(40, Math.round(h))
    saveSettings(state.settings)
    applyOverlayWindowSettings()
  })

  /** 動畫用即時尺寸:每幀呼叫,只改視窗與記憶體設定,不落盤(結束時由 OverlaySetSize 定案)。
   *  刻意不走 applyOverlayWindowSettings:那裡含 setContentProtection/setIgnoreMouseEvents/
   *  setBackgroundMaterial 與 os.release 解析,每幀 60 次全是浪費,morph 只需要 setSize */
  ipcMain.handle(IPC.OverlaySetSizeLive, (_e, w: number, h: number) => {
    state.settings.overlay.width = Math.max(240, Math.round(w))
    state.settings.overlay.height = Math.max(40, Math.round(h))
    if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
      state.overlayWindow.setSize(state.settings.overlay.width, state.settings.overlay.height)
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

  // ---- 在檔案總管顯示檔案 ----
  ipcMain.handle(IPC.RevealPath, (_e, path: string) => {
    if (path && typeof path === 'string') shell.showItemInFolder(path)
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
