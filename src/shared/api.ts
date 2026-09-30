import type {
  AppInfo,
  AppSettings,
  RescuePayload,
  TurnYieldPayload,
  CoachingPayload,
  CoachingKind,
  DebugSignalKind,
  DebugOverlayAction,
  DomFinding
} from './types'

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

/** 浮層視窗層級的除錯資訊(main 端可取得的幾何/可見性/DPI) */
export interface DebugOverlayInfo {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  scaleFactor: number
  /** 浮層目前所在螢幕的工作區(判斷是否被工作列或其他螢幕切掉) */
  workArea: { x: number; y: number; width: number; height: number }
  displayBounds: { x: number; y: number; width: number; height: number }
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
  /** 即時教練訊號(main → overlay) */
  onCoaching(cb: (payload: CoachingPayload) => void): Unsubscribe
  /** 會話邊界:清空 main 端語音上下文與即時回饋狀態(新場次開始時呼叫) */
  contextReset(): Promise<void>
  /** 目前 coaching 各訊號觸發次數(會後報告用) */
  coachingStats(): Promise<Partial<Record<CoachingKind, number>>>
  /** 全域熱鍵:浮層播放/暫停 */
  onOverlayPlayPause(cb: () => void): Unsubscribe
  /** 全域熱鍵:語速步進(dir = +1 上/−1 下,各 0.1×) */
  onOverlaySpeedStep(cb: (dir: 1 | -1) => void): Unsubscribe
  onPanicThinking(cb: () => void): Unsubscribe
  onPanicRescue(cb: (payload: RescuePayload) => void): Unsubscribe
  onPanicError(cb: (message: string) => void): Unsubscribe

  // 工具
  appInfo(): Promise<AppInfo>
  exportFile(args: { defaultName: string; content: string }): Promise<{ ok: boolean; filePath?: string; error?: string }>
  /**
   * 彈檔案選擇框讀入一個 JSON(資料備份的還原路徑)。
   * 走選擇框而不是由 renderer 傳路徑:後者等於把「讀整台電腦」交給 web 內容。
   */
  importJsonFile(args?: { defaultName?: string; maxBytes?: number }): Promise<{
    ok: boolean
    filePath?: string
    text?: string
    error?: string
  }>
  /** 錄影存檔:彈出儲存對話框寫入位元組 */
  saveRecording(args: { bytes: Uint8Array; defaultName: string }): Promise<{ ok: boolean; filePath?: string; error?: string }>
  /** 分享前模擬測試:回傳主螢幕擷取縮圖(浮層應為隱形) */
  shareSimulation(): Promise<{ ok: boolean; dataUrl?: string; error?: string }>
  /** 貼鏡模式吸附:把浮層移到螢幕上緣指定角落 */
  snapOverlayCorner(corner: 'tl' | 'tc' | 'tr'): Promise<void>
  /** 浮層置中:掉出畫面(拔螢幕/改解析度)時的保險 */
  recenterOverlay(): Promise<void>

  // ===== 開發者除錯(僅 appInfo().debug 為 true 時有效;否則 main 端一律回 null/false)=====
  /** 開啟指定視窗的 DevTools(浮層是無邊框且常開防擷取,無法右鍵檢查) */
  debugOpenDevTools(target: 'main' | 'overlay'): Promise<boolean>
  /** 直接廣播一個即時回饋訊號到浮層,便於在沒有真實會議的情況下檢視事件 UI */
  debugEmitSignal(args: {
    kind: DebugSignalKind
    /** 訊號內容(教練提示文字 / 救援句 / 'peer_silence') */
    text?: string
    /** kind='coaching' 時要模擬的訊號種類 */
    coachingKind?: CoachingKind
  }): Promise<boolean>
  /** 讀取浮層 renderer 的狀態快照(引擎/跟讀/玻璃/視窗),未啟用或無浮層時為 null */
  debugOverlaySnapshot(): Promise<Record<string, unknown> | null>
  /** 對浮層下除錯控制(藥丸/展開/貼鏡/播放/跟讀/置中),走浮層自己的控制項 */
  debugOverlayCall(action: DebugOverlayAction): Promise<boolean>
  /** 浮層視窗層級資訊(main 端直接量,不依賴 renderer) */
  debugOverlayInfo(): Promise<DebugOverlayInfo | null>
  /** 在浮層裡跑同一套 DOM 稽核規則(見 src/renderer/src/lib/domAudit.ts) */
  debugOverlayAudit(): Promise<DomFinding[] | null>
  /**
   * 關閉視窗守衛:上報「現在關掉會丢東西」的訊息,傳 null 表示解除。
   * main 在 close 事件裡讀這個值決定要不要擋下來。
   */
  setCloseBlocker(text: string | null): Promise<boolean>
  /** 使用者確認放棄變更並關閉 */
  confirmClose(): Promise<boolean>
  /** 使用者在關閉確認對話框按了取消 */
  cancelClose(): Promise<boolean>
  /** main 通知 renderer「有人想關視窗,請顯示確認對話框」 */
  onCloseRequested(cb: (blocker: string) => void): () => void
  /** 在檔案總管中顯示檔案 */
  revealPath(path: string): Promise<void>
  /** renderer 錯誤落盤到 main 日誌(產品化:崩潰回報的最低可行形式) */
  logFromRenderer(level: 'ERROR' | 'WARN' | 'INFO', message: string): Promise<void>
  /** 開啟記錄資料夾(設定頁用) */
  openLogDir(): Promise<void>
}
