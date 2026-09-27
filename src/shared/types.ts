// ===== 共用型別與 IPC 通道定義（main / renderer 共用）=====

/** 浮層顯示模式:scroll=連續捲動 / phrase=逐句短語 / karaoke=逐詞高亮 / bullet=要點 */
export type OverlayDisplayMode = 'scroll' | 'phrase' | 'karaoke' | 'bullet'

export interface OverlaySettings {
  clickThrough: boolean
  captureProtected: boolean
  displayMode: OverlayDisplayMode
  fontSize: number
  lineHeight: number
  speed: number // scroll 模式:px per second
  /** phrase/karaoke 模式速度倍率,1 = 120 WPM 基準 */
  rate: number
  mirror: boolean
  opacity: number // 0.1 - 1.0 (整體視窗內容不透明度)
  width: number
  height: number
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
    fontSize: 30,
    lineHeight: 1.5,
    speed: 60,
    rate: 1,
    mirror: false,
    opacity: 0.92,
    width: 720,
    height: 260,
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
    panicRescue: 'Alt+P'
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
  ExportFile: 'util:export-file',
  // events (main -> renderer)
  OverlayVisibilityChanged: 'overlay:visibility-changed',
  OverlaySettingsChanged: 'overlay:settings-changed',
  OllamaChatChunk: 'ai:ollama-chat-chunk',
  PanicThinking: 'panic:thinking',
  PanicRescue: 'panic:rescue',
  PanicError: 'panic:error'
} as const

// ===== Panic 救援 =====
export interface RescuePayload {
  sentence: string
  /** 以 " / " 分隔的短語要點 */
  points: string
  confidence: number
  source: 'ai' | 'template'
  scene?: string
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
