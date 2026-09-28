// ===== 共用型別與 IPC 通道定義（main / renderer 共用）=====

/** 浮層顯示模式:scroll=連續捲動 / phrase=逐句短語 / karaoke=逐詞高亮 / bullet=要點 */
export type OverlayDisplayMode = 'scroll' | 'phrase' | 'karaoke' | 'bullet'

export interface OverlaySettings {
  clickThrough: boolean
  captureProtected: boolean
  displayMode: OverlayDisplayMode
  /** 緊緻藥丸模式(Dynamic Island 式;折疊成小條,展開恢復) */
  compact: boolean
  /** 貼鏡模式:窄條浮層貼近攝影機(<5cm),當前行鎖定鏡頭下方 ~2° 視角,眼神自然 */
  lensMode: boolean
  /** 玻璃質感:Windows 11 嘗試啟用視窗後 acrylic 毛玻璃 */
  glass: boolean
  /** turn-yield 提示:對方講完問句時浮層顯示「該你說話了」(Phase B) */
  turnYield: boolean
  /** 即時教練:語速過快/填充詞/損話/冷場/獨白過長時浮層提醒 */
  coaching: boolean
  fontSize: number
  lineHeight: number
  speed: number // scroll 模式:px per second
  /** phrase/karaoke 模式速度倍率,1 = 120 WPM 基準 */
  rate: number
  mirror: boolean
  opacity: number // 0.1 - 1.0 (整體視窗內容不透明度)
  width: number
  height: number
  /** 最後位置;null = 從未移動過,用系統預設。用 x|null 而非 0 免得 (0,0) 誤判 */
  x: number | null
  y: number | null
  alwaysOnTop: boolean
}

export interface SttSettings {
  engine: 'local' | 'cloud'
  localModel: 'tiny' | 'base' | 'small'
  language: string // 'zh' | 'en' | 'auto'
  cloud: {
    baseUrl: string // OpenAI 相容，例如 https://api.groq.com/openai/v1
    apiKey: string
    model: string // 例如 whisper-large-v3
  }
}

export interface AiSettings {
  provider: 'ollama' | 'openai-compatible'
  ollama: {
    baseUrl: string
    model: string
  }
  openaiCompatible: {
    baseUrl: string
    apiKey: string
    model: string
  }
}

export interface HotkeySettings {
  toggleOverlay: string // e.g. Ctrl+Alt+T
  hideOverlay: string
  panicRescue: string // e.g. Alt+P — 求救熱鍵
  /** 浮層播放/暫停(全域) */
  playPause: string
  /** 語速倍率 +0.1×(全域) */
  speedUp: string
  /** 語速倍率 −0.1×(全域) */
  speedDown: string
}

/** 場景情境設定(Panic 救援 / AI 語氣用) */
export interface ScenarioSettings {
  /** 目前作用場景 key(內建 8 種或 pack:<id>:<scene>) */
  activeScene: string
  /** 是否允許 AI 即時建議/救援(關閉時 panic 走模板) */
  aiModeEnabled: boolean
  /** panic prompt 的 framing */
  panicMode: 'interview' | 'meeting'
}

/** 個人化校準檔案（IPD 眼距 + 語速量測產出） */
export interface PersonalProfile {
  calibratedAt: number
  ipdMm: number // 使用者瞳距（mm）
  viewingDistanceCm: number // 攝影機推估的觀看距離（cm）
  hfovDeg: number // 推估時採用的攝影機水平視場角假設
  charsPerMin: number // 個人語速（中文字/分）
  sampleSeconds: number // 語速樣本時長（秒）
  sampleChars: number // 語速樣本有效字數
  derivedFontSize: number // 由視距推導的字級（px）
  derivedSpeed: number // 由語速推導的滾動速度（px/s）
}

export interface AppSettings {
  overlay: OverlaySettings
  stt: SttSettings
  ai: AiSettings
  hotkeys: HotkeySettings
  scenario: ScenarioSettings
  personal: {
    profile: PersonalProfile | null
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  overlay: {
    clickThrough: false,
    captureProtected: true,
    displayMode: 'scroll',
    compact: false,
    lensMode: false,
    glass: true,
    turnYield: true,
    coaching: true,
    fontSize: 30,
    lineHeight: 1.5,
    speed: 60,
    rate: 1,
    mirror: false,
    opacity: 0.92,
    width: 720,
    height: 260,
    x: null,
    y: null,
    alwaysOnTop: true
  },
  stt: {
    engine: 'local',
    localModel: 'base',
    language: 'zh',
    cloud: {
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: '',
      model: 'whisper-large-v3'
    }
  },
  ai: {
    provider: 'ollama',
    ollama: {
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5:7b'
    },
    openaiCompatible: {
      baseUrl: '',
      apiKey: '',
      model: ''
    }
  },
  hotkeys: {
    toggleOverlay: 'Control+Alt+T',
    hideOverlay: 'Control+Alt+H',
    panicRescue: 'Alt+P',
    playPause: 'Alt+K',
    speedUp: 'Alt+Up',
    speedDown: 'Alt+Down'
  },
  scenario: {
    activeScene: 'interview',
    aiModeEnabled: true,
    panicMode: 'interview'
  },
  personal: {
    profile: null
  }
}

// ===== IPC 通道 =====
export const IPC = {
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  OverlayShow: 'overlay:show',
  OverlayGetLastPayload: 'overlay:get-last-payload',
  OverlayHide: 'overlay:hide',
  OverlayToggle: 'overlay:toggle',
  OverlayIsVisible: 'overlay:is-visible',
  OverlaySetClickThrough: 'overlay:set-click-through',
  OverlaySetCaptureProtection: 'overlay:set-capture-protection',
  OverlaySetSize: 'overlay:set-size',
  /** 動畫用即時尺寸(每幀呼叫):只改視窗與記憶體設定,不落盤 */
  OverlaySetSizeLive: 'overlay:set-size-live',
  OverlayApplySettings: 'overlay:apply-settings',
  AppInfo: 'app:info',
  // Phase 5+
  SystemAudioStart: 'system-audio:start-approval',
  OllamaListModels: 'ai:ollama-list-models',
  OllamaChat: 'ai:ollama-chat',
  OllamaAbort: 'ai:ollama-abort',
  OpenAiChat: 'ai:openai-chat',
  // Phase C:統一 AI / 金鑰 / panic / 場景
  AiChatCompletion: 'ai:chat-completion',
  AiTestConnection: 'ai:test-connection',
  KeysGet: 'ai:keys-get',
  KeysSet: 'ai:keys-set',
  PanicTrigger: 'panic:trigger',
  ContextPushTranscript: 'context:push-transcript',
  SceneList: 'scene:list',
  CloudTranscribe: 'stt:cloud-transcribe',
  SaveRecording: 'util:save-recording',
  ShareSimulation: 'system:share-simulation',
  OverlaySnapCorner: 'overlay:snap-corner',
  RevealPath: 'util:reveal-path',
  ExportFile: 'util:export-file',
  // events (main -> renderer)
  OverlayVisibilityChanged: 'overlay:visibility-changed',
  OverlaySettingsChanged: 'overlay:settings-changed',
  OllamaChatChunk: 'ai:ollama-chat-chunk',
  PanicThinking: 'panic:thinking',
  PanicRescue: 'panic:rescue',
  PanicError: 'panic:error',
  /** turn-yield:對方講完問句 → 該你說話了(main → overlay) */
  TurnYieldSignal: 'context:turn-yield',
  /** 即時教練訊號(main → overlay) */
  CoachingSignal: 'context:coaching',
  /** 會話邊界:清空 liveContext / turnYield / coaching 狀態 */
  ContextReset: 'context:reset',
  /** 取用目前 coaching 觸發計數(供會後報告) */
  CoachingStatsGet: 'context:coaching-stats',
  /** 全域熱鍵:浮層播放/暫停(main → overlay) */
  OverlayPlayPause: 'overlay:play-pause',
  /** 全域熱鍵:語速步進 ±0.1×(main → overlay) */
  OverlaySpeedStep: 'overlay:speed-step'
} as const

// ===== turn-yield 提示(Phase B)=====
export interface TurnYieldPayload {
  /** 'turn' = 該你說話了;'peer_silence' = 對方已停頓 */
  kind: 'turn' | 'peer_silence'
  /** 觸媒句是否為問句/邀答語尾 */
  question: boolean
  /** 觸發時間戳(ms epoch),供 renderer 防抖 */
  at: number
}

// ===== 即時教練(Phase B+)=====
export type CoachingKind = 'fast' | 'filler' | 'interrupt' | 'dead_air' | 'monologue'

export interface CoachingPayload {
  kind: CoachingKind
  /** 給使用者的提示文案(main 端已含量化數字) */
  message: string
  /** 觸發時間戳(ms epoch),供 renderer 防抖 */
  at: number
}

// ===== Panic 救援 =====
export interface RescuePayload {
  sentence: string
  /** 以 " / " 分隔的短語要點 */
  points: string
  confidence: number
  source: 'ai' | 'template'
  scene?: string
}

// ===== 會話量化報告(session intelligence)=====
export interface SessionSuggestion {
  severity: 'high' | 'medium' | 'low'
  message: string
}

/** 由逐字稿段落計算的會後量化報告 */
export interface SessionReport {
  durationSec: number
  mySec: number
  theirSec: number
  /** 我方發言佔比 0–1 */
  talkRatio: number
  /** 語音單位:CJK 字元各 1 + 拉丁詞各 1 */
  myUnits: number
  /** 我方語速:單位 / 我方實際發言分鐘 */
  myCpm: number
  turnCount: number
  avgMyTurnSec: number
  longestMyTurnSec: number
  /** 超過 5 秒的冷場次數與總秒數 */
  gapCount: number
  gapTotalSec: number
  theirQuestionCount: number
  /** 0–100,語速穩定度 */
  steadiness: number
  suggestions: SessionSuggestion[]
  /** 會議期間各 coaching 訊號的觸發次數(main 端計數,未觸發者不列) */
  coachingCounts?: Partial<Record<CoachingKind, number>>
  generatedAt: number
}

// ===== 資料模型 =====
export interface Script {
  id?: number
  title: string
  content: string
  tags?: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface TranscriptSegment {
  speaker: 'me' | 'them'
  text: string
  start: number // 秒
  end: number
}

export interface MeetingSession {
  id?: number
  title: string
  startedAt: number
  endedAt?: number
  segments: TranscriptSegment[]
  summary?: MeetingSummary
  report?: SessionReport
}

export interface MeetingSummary {
  abstract: string
  keyPoints: string[]
  todos: string[]
  followUps: string[]
  generatedAt: number
  model: string
}

export interface PracticeAnswer {
  question: string
  answerTranscript: string
  durationSec: number
  feedback?: PracticeFeedback
}

export interface PracticeFeedback {
  score: number // 0-100
  content: string // 內容面反饋
  structure: string // 結構面反饋
  delivery: string // 表達/語速/填充詞反饋
  betterAnswer: string // 改寫示範
}

export interface PracticeRun {
  id?: number
  position: string // 應徵職位/情境
  type: string // 行為面試 / 技術面試 / 自我介紹...
  questions: string[]
  answers: PracticeAnswer[]
  createdAt: number
  overallFeedback?: string
}

export interface AppInfo {
  version: string
  platform: string
  userDataPath: string
}
