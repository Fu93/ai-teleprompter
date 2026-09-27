import type { AppInfo, AppSettings, RescuePayload, TurnYieldPayload } from './types'

export interface OverlayShowPayload {
  title?: string
  content?: string
}

export interface OllamaChatApiRequest {
  requestId: string
  baseUrl: string
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
}

export interface OllamaModelsResult {
  installed: boolean
  version: string | null
  models: string[]
}

export interface CloudTranscribeArgs {
  baseUrl: string
  apiKey: string
  model: string
  /** WAV 編碼的 16kHz 單聲道音訊 */
  audio: Uint8Array
  language?: string
}

export type Unsubscribe = () => void

export interface ChatCompletionApiRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens?: number
  temperature?: number
  jsonMode?: boolean
  timeoutMs?: number
}

export interface ChatCompletionApiResponse {
  ok: boolean
  text?: string
  error?: string
  meta?: { provider: string; model: string; latencyMs: number }
}

export interface SceneSummary {
  key: string
  label: string
  tone: string
  tempo: string
  lengthBudget: number
  riskLevel: string
  turns: number
  source: string
}

export interface Api {
  // 設定
  getSettings(): Promise<AppSettings>
  setSettings(patch: Record<string, unknown>): Promise<AppSettings>
  onSettingsChanged(cb: (s: AppSettings) => void): Unsubscribe

  // 浮層
  overlayShow(payload: OverlayShowPayload): Promise<void>
  overlayGetLastPayload(): Promise<OverlayShowPayload>
  overlayHide(): Promise<void>
  overlayToggle(): Promise<void>
  overlayIsVisible(): Promise<boolean>
  overlaySetClickThrough(v: boolean): Promise<void>
  overlaySetCaptureProtection(v: boolean): Promise<void>
  overlaySetSize(w: number, h: number): Promise<void>
  /** 動畫用即時尺寸:每幀呼叫,只改視窗不落盤(結束時用 overlaySetSize 定案) */
  overlaySetSizeLive(w: number, h: number): Promise<void>
  onOverlayVisibility(cb: (visible: boolean) => void): Unsubscribe
  onOverlayLoadScript(cb: (payload: OverlayShowPayload) => void): Unsubscribe

  // AI
  ollamaListModels(baseUrl: string): Promise<OllamaModelsResult>
  ollamaChat(req: OllamaChatApiRequest): Promise<{ ok: boolean; text?: string; error?: string }>
  ollamaAbort(requestId: string): Promise<void>
  openAiChat(req: {
    baseUrl: string
    apiKey: string
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    temperature?: number
  }): Promise<{ ok: boolean; text?: string; error?: string }>

  // 雲端語音辨識（經 main 代理，key 不留在 renderer）
  cloudTranscribe(args: CloudTranscribeArgs): Promise<{ ok: boolean; text?: string; error?: string }>

  // 統一 AI(panic / 場景引擎 / 未來功能共用)
  chatCompletion(req: ChatCompletionApiRequest): Promise<ChatCompletionApiResponse>
  testConnection(args: { provider: string; apiKey?: string; endpoint?: string; model?: string }): Promise<{ ok: boolean; error?: string }>
  keysGet(): Promise<Record<string, unknown> | null>
  keysSet(keys: Record<string, unknown>): Promise<boolean>
  sceneList(): Promise<SceneSummary[]>
  pushTranscript(args: { text: string; speaker?: 'me' | 'them' | 'unknown' }): Promise<boolean>
  panicTrigger(script?: string): Promise<boolean>
  /** turn-yield:對方講完問句/長段(main → overlay) */
  onTurnYield(cb: (payload: TurnYieldPayload) => void): Unsubscribe
  onPanicThinking(cb: () => void): Unsubscribe
  onPanicRescue(cb: (payload: RescuePayload) => void): Unsubscribe
  onPanicError(cb: (message: string) => void): Unsubscribe

  // 工具
  appInfo(): Promise<AppInfo>
  exportFile(args: { defaultName: string; content: string }): Promise<{ ok: boolean; filePath?: string; error?: string }>
  /** 錄影存檔:彈出儲存對話框寫入位元組 */
  saveRecording(args: { bytes: Uint8Array; defaultName: string }): Promise<{ ok: boolean; filePath?: string; error?: string }>
  /** 分享前模擬測試:回傳主螢幕擷取縮圖(浮層應為隱形) */
  shareSimulation(): Promise<{ ok: boolean; dataUrl?: string; error?: string }>
  /** 貼鏡模式吸附:把浮層移到螢幕上緣指定角落 */
  snapOverlayCorner(corner: 'tl' | 'tc' | 'tr'): Promise<void>
  /** 在檔案總管中顯示檔案 */
  revealPath(path: string): Promise<void>
}
