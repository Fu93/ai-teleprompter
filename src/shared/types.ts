// ===== 共用型別與 IPC 通道定義（main / renderer 共用）=====

import type { E2EEnv } from './e2eEnv'

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
  /**
   * 藥丸倍率(0.8×–1.3×,1.00× = 320×48)。
   *
   * 為什麼是設定而不是常數:島的大小是「螢幕大小 / DPI / 視力 / 桌面留白」的問題，
   * 不是美感偏好。只縮放膠囊本體，字級與 28px 觸控目標不變(縮小觸控目標是無障礙問題)。
   * 合法性由 @shared/overlayShapes 的 clampPillScale 把關(設定檔可能被手改)。
   */
  pillScale: number
  /**
   * 玻璃折射:面板邊緣的 Liquid Glass 折射層(useGlassRefraction 的 SVG 位移圖)。
   * 不含系統視窗材質 —— 材質畫在視窗矩形上,會在面板圓角外露出方形補丁,
   * 理由與量測見 windows.ts 的 createOverlayWindow。
   */
  glass: boolean
  /** turn-yield 提示:對方講完問句時浮層顯示「該你說話了」(Phase B) */
  turnYield: boolean
  /** 即時教練:語速過快/填充詞/搶話/冷場/獨白過長時浮層提醒 */
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
  /**
   * 貼鏡凝視錨點(DESIGN_RESEARCH P0-1):一次性拖放校正出的「鏡頭正下方」停靠位置。
   *
   * 流程:進貼鏡 → 把浮層拖到攝影機正下方 → 按工具列「◎ 鎖定」→ 之後每次進貼鏡
   * 自動 moveTo 停靠到這裡(磁吸)。null = 從未校正,此時貼鏡的吸附退回「上中」角落,
   * 而且**完全不自動移動**(沒有錨點的自動位移只會把使用者剛拖好的位置拽走)。
   *
   * x/y 是 DIP 絕對座標(與 overlay.x/y 同一套);displayId 用來偵測「校正後拔了螢幕」
   * (stale → 退回角落吸附並提示重新校正,而不是把浮層停到錯的螢幕上)。
   * cameraLabel 是鎖定當下的攝影機名稱,只做顯示 —— 它讓「這個錨點是校給哪台相機的」
   * 在設定頁可讀,而不是一個沒有出處的座標。
   */
  gazeAnchor: GazeAnchor | null
}

/** 貼鏡凝視錨點(見 OverlaySettings.gazeAnchor) */
export interface GazeAnchor {
  x: number
  y: number
  displayId: number
  cameraLabel: string
}

/**
 * 凝視錨點的量化狀態(OverlayGazeInfo 的回傳;角度在 renderer 端算 ——
 * px→cm 的 96dpi 假設住在 renderer/lib/calibration.ts,main 不 import renderer)。
 *
 * offsetPx = 錨點座標距螢幕物理上緣的距離 + 文字帶頂緣在貼鏡視窗內的偏移
 * (LENS_BAND_TOP_PX)。角度 = atan(實體偏移 ÷ 臉距),「眼神自然」因此是個數字。
 */
export interface GazeInfo {
  /** false = 從未鎖定(其餘欄位為 null) */
  anchored: boolean
  /** true = 錨點所在螢幕已不在(拔螢幕/換桌機),需要重新校正 */
  stale: boolean
  /** 螢幕物理上緣 → 文字帶頂緣的垂直距離(px,未校正或 stale 時 null) */
  offsetPx: number | null
  /** 鎖定當下的攝影機名稱 */
  cameraLabel: string | null
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
    /**
     * 救援時間預算的自適應樣本(見 main/context-engine/rescueAdaptation.ts)。
     *
     * 為什麼放在 personal 而不是 PersonalProfile:profile 是**校準**的產物,
     * 沒校準的人也會按救援熱鍵 —— 樣本不該跟著「有沒有量過語速」一起缺席。
     * 只記成功的延遲;換供應商就重新累積(分佈不同)。舊設定檔沒有這個欄位。
     */
    rescue?: { providerId: string; samples: number[] }
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  overlay: {
    clickThrough: false,
    captureProtected: true,
    displayMode: 'scroll',
    compact: false,
    lensMode: false,
    pillScale: 1,
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
    alwaysOnTop: true,
    gazeAnchor: null
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
  /**
   * renderer → main:主視窗改了正在提詞的那一份稿,請浮層換稿。
   * 與 OverlayShow 的差別是不會把浮層叫出來(規則見 shared/overlayScript.ts)。
   */
  OverlaySync: 'overlay:sync',
  OverlayHide: 'overlay:hide',
  OverlayToggle: 'overlay:toggle',
  OverlayIsVisible: 'overlay:is-visible',
  OverlaySetClickThrough: 'overlay:set-click-through',
  OverlaySetCaptureProtection: 'overlay:set-capture-protection',
  OverlaySetSize: 'overlay:set-size',
  /** 動畫用即時尺寸(每幀呼叫):只改視窗與記憶體設定,不落盤 */
  OverlaySetSizeLive: 'overlay:set-size-live',
  AppInfo: 'app:info',
  // Phase 5+
  OllamaListModels: 'ai:ollama-list-models',
  OllamaChat: 'ai:ollama-chat',
  OllamaAbort: 'ai:ollama-abort',
  OpenAiChat: 'ai:openai-chat',
  // ── 刪除的三個幽靈通道(2026-10-03)──
  // 這三個常數曾經宣告在這裡,而全專案(preload / ipc.ts / renderer / e2e)
  // **零引用** —— 沒有 handler、沒有 preload 轉接、沒有呼叫端。它們的形狀是
  // 「宣告過所以看起來存在」,而那比沒有這個通道更糟:下一個人會照著它假設
  // 功能已經通了。特別是 OllamaChatChunk —— 它暗示有串流,但 ollamaChat()
  // 只回傳完整字串。
  //
  // 記在這裡而不是只留在 commit:未來若真的要做串流,應該是一起設計
  // requestId + 分塊協定 + 取消,而不是先放一個常數在這裡。
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
  /**
   * 錄影分片落盤(見 src/main/videoRecording.ts)。
   *
   * 為什麼不是沿用 SaveRecording 一次把整段丟過來:那條路要把整段錄影
   * 攢在 renderer 記憶體、一次性過 IPC。任何一環失敗就是整段沒了,而且
   * 視窗被銷毀時 onstop 根本不會跑 —— 分片先寫到磁碟才是 OS 關機 / crash
   * 之後還找得回來的唯一原因。
   */
  VideoRecordingBegin: 'util:video-recording-begin',
  VideoRecordingChunk: 'util:video-recording-chunk',
  VideoRecordingFinish: 'util:video-recording-finish',
  VideoRecordingSave: 'util:video-recording-save',
  VideoRecordingAbort: 'util:video-recording-abort',
  /** 啟動時找回上次錄影中斷留下的暫存檔 */
  VideoRecordingOrphans: 'util:video-recording-orphans',
  VideoRecordingResolveOrphans: 'util:video-recording-resolve-orphans',
  ShareSimulation: 'system:share-simulation',
  OverlaySnapCorner: 'overlay:snap-corner',
  OverlayRecenter: 'overlay:recenter',
  /** 貼鏡「◎ 鎖定」:把浮層目前位置存成凝視錨點 */
  OverlaySetGazeAnchor: 'overlay:set-gaze-anchor',
  /** 貼鏡「◉ 鏡頭」/ 進貼鏡自動停靠:moveTo 錨點(無錨點或 stale 退回上中角落) */
  OverlaySnapGaze: 'overlay:snap-gaze',
  /** 設定頁凝視錨點狀態列(偏移角量化) */
  OverlayGazeInfo: 'overlay:gaze-info',
  RevealPath: 'util:reveal-path',
  /**
   * 用系統瀏覽器開一個外部連結。
   *
   * 為什麼需要:setWindowOpenHandler 一律 deny(見 windows.ts 的 hardenWebContents),
   * 所以 renderer 沒有任何方式讓使用者點到一張下載頁。而「第一次使用要裝 Ollama」
   * 這件事不可能不給連結 —— 沒有連結,使用者只能自己猜網址或放棄。
   *
   * 只准 http/https:renderer 傳 file:// 或 javascript: 進來時,
   * 等於讓 web 內容開啟本機檔案或注入腳本,那不是「開連結」。
   */
  OpenExternal: 'util:open-external',
  ExportFile: 'util:export-file',
  /**
   * 讀入一個 JSON 檔(資料備份的還原路徑)。
   *
   * 為什麼需要一個新通道:`util:export-file` 有了,但沒有任何一條能讀檔。
   * 沒有它,使用者只能匯出、不能帶著資料換機 —— 而「能產出資料、卻不給人
   * 帶走」的工具會定期吃掉自己的產品(見 renderer/src/lib/backup.ts 檔頭)。
   *
   * 主動彈檔案選擇框,不接受任意路徑:renderer 傳字串過來讓 main 讀檔,
   * 等於把「讀整台電腦」的能力交給 web 內容。選擇框讓使用者自己指定檔案,
   * 這是 Electron 在這種情境下的標準做法。
   */
  ImportJsonFile: 'util:import-json-file',
  LogFromRenderer: 'util:log-from-renderer',
  /**
   * 記一筆結構化事件(純本機,見 shared/observability.ts 檔頭的邊界說明)。
   *
   * 為什麼不直接沿用 LogFromRenderer:那條通道的 message 是自由文字,而診斷
   * 報告要統計的是**錯誤碼**。讓事件帶自己的代碼,「使用者貼上報告」才連得
   * 上「這台機器上發生過什麼」。同一件事寫兩次(一次自由文字、一次事件)
   * 會產生兩套沒有共同識別碼的紀錄,而那正是這一層要消滅的問題。
   */
  LogEvent: 'util:log-event',
  /** 產生診斷報告(設定頁「複製診斷報告」) */
  DiagnosticsReport: 'util:diagnostics-report',
  OpenLogDir: 'util:open-log-dir',
  // events (main -> renderer)
  OverlayVisibilityChanged: 'overlay:visibility-changed',
  OverlaySettingsChanged: 'overlay:settings-changed',
  /** main → overlay:帶著講稿內容顯示浮層(與 OverlayShow 同 payload,見 preload 的 onOverlayLoadScript) */
  OverlayLoadScript: 'overlay:load-script',
  PanicThinking: 'panic:thinking',  PanicRescue: 'panic:rescue',
  PanicError: 'panic:error',
  /** turn-yield:對方講完問句 → 該你說話了(main → overlay) */
  TurnYieldSignal: 'context:turn-yield',
  /** 即時教練訊號(main → overlay) */
  CoachingSignal: 'context:coaching',
  /** 瞬時節奏讀數(main → overlay;P4。持續更新,沒有冷卻) */
  CoachingPace: 'context:coaching-pace',
  /** 會話邊界:清空 liveContext / turnYield / coaching 狀態 */
  ContextReset: 'context:reset',
  /** 取用目前 coaching 觸發計數(供會後報告) */
  CoachingStatsGet: 'context:coaching-stats',
  /** 全域熱鍵:浮層播放/暫停(main → overlay) */
  OverlayPlayPause: 'overlay:play-pause',
  /** 全域熱鍵:語速步進 ±0.1×(main → overlay) */
  OverlaySpeedStep: 'overlay:speed-step',
  // ===== 開發者除錯(UI/UX debug 支援;僅 src/main/debug.ts 的 gate 成立時才有作用)=====
  /** 開啟指定視窗的 DevTools(浮層是無邊框視窗,無法右鍵檢查) */
  DebugOpenDevTools: 'debug:open-devtools',
  /** 直接廣播即時回饋訊號(該你了/教練/救援),便於在沒有真實會議時檢視浮層 UI */
  DebugEmitSignal: 'debug:emit-signal',
  /** 讀取浮層 renderer 的狀態快照(window.__debugSnapshot) */
  DebugOverlaySnapshot: 'debug:overlay-snapshot',
  /** 對浮層下除錯控制(藥丸/展開/貼鏡/播放),走浮層自己的控制項 */
  DebugOverlayCall: 'debug:overlay-call',
  DebugOverlayAudit: 'debug:overlay-audit',
  /** 浮層視窗層級資訊(幾何/可見/DPI/螢幕) */
  DebugOverlayInfo: 'debug:overlay-info',

  // 關閉視窗守衛:renderer 主動宣告「現在關掉會丢東西」,main 在 close 事件裡擋下來
  AppSetCloseBlocker: 'app:set-close-blocker',
  /**
   * 「現在正在錄音」的事實通知。
   *
   * 為什麼需要獨立的一個 channel 而不是去讀 closeBlocker 的字串:closeBlocker
   * 是給人看的訊息,而且同時涵蓋「講稿沒存」與「正在錄音」兩種情況。退出前存檔
   * 只該在後者發生 —— 拿字串去做 substring 比對,等於把安全行為綁在一句可能
   * 被改寫的文案上。
   */
  AppSetRecording: 'app:set-recording',
  AppCloseRequested: 'app:close-requested',
  AppConfirmClose: 'app:confirm-close',
  AppCancelClose: 'app:cancel-close',
  /** 錄音/轉錄期間阻止系統睡眠(見 ipc.ts 的 powerSaveBlocker 說明) */
  PowerSaveStart: 'app:powersave-start',
  PowerSaveStop: 'app:powersave-stop',
  /** 設定頁「重新啟動以套用更新」:relaunch 後以 exit 結束目前實例 */
  AppRelaunch: 'app:relaunch',
  /**
   * 叫回主視窗(浮層工具列 / 浮層空狀態)。
   *
   * 為什麼需要一條自己的 IPC:主視窗關閉之後沒有 tray、沒有工作列圖示,
   * 而浮層的空狀態還在指示「到主視窗按開始提詞」—— 那扇窗唯一的重建路徑
   * 本來是「再啟動一次 App」(second-instance)。沒有這條路,那句指示就是死路,
   * 而「關閉主視窗」正是簡報中常見的操作。
   */
  AppShowMain: 'app:show-main',
  /**
   * 錄音/錄影進行中的環境指示:主視窗標題 + 工作列閃爍(P2 附錄 #1 的縮小版)。
   * renderer 上報 active/label,main 負責 setTitle 與 flashFrame(平台降級自然:
   * macOS 的 flashFrame 是 dock 退避一次)。tray 圖示是獨立一輪,見 UX_FINDINGS。
   */
  WindowCaptureIndicator: 'app:capture-indicator'
} as const

// ===== main → renderer 事件(不走 ipcMain.handle 的一類)=====
/**
 * 更新已下載完成,等使用者重啟安裝。
 *
 * 為什麼要是具名常數而不是兩端各寫一次魔法字串:updater.ts 送、preload 收,
 * 字串各寫一次的話改一邊就靜默斷線(與 'overlay:load-script' 同一個教訓)。
 */
export const APP_UPDATE_DOWNLOADED = 'app:update-downloaded'

export interface UpdateDownloadedInfo {
  version: string
  /** release notes(已截斷,見 updater.ts) */
  releaseNotes: string
}

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

/**
 * 瞬時節奏讀數(main → overlay)。
 *
 * 與 CoachingPayload 的差別:那個是**事件**(會出聲、有冷卻、8 秒淡出);
 * 這個是**讀數**(10 秒窗、±10% 三色、不出聲、持續更新)。兩者共用同一個
 * 估計器(見 main/context-engine/speakingPace.ts)。
 */
export interface CoachingPacePayload {
  /** 中位數濾波後的瞬時語速(字/分);null = 窗內語音不足,UI 應收起 */
  cpm: number | null
  /** 三色判定;cpm 為 null 時同為 null */
  verdict: 'ahead' | 'on_track' | 'behind' | null
  /** 顯示用基準(個人校準值,未校準為 DEFAULT_CPM) */
  baseline: number
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
  /** 我方發言佔比 0–1；若音訊來源無法觀察雙方，值僅供內部佔位 */
  talkRatio: number
  /** 是否同時擷取我方與對方；缺少來源資訊的舊紀錄視為可用以維持相容 */
  talkRatioAvailable?: boolean
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
  /** 實際高於 VAD 門檻的發聲時長；舊資料缺少時以 end - start 估算 */
  speechDurationSec?: number
}

export interface MeetingSession {
  id?: number
  title: string
  startedAt: number
  endedAt?: number
  segments: TranscriptSegment[]
  summary?: MeetingSummary
  report?: SessionReport
  /**
   * 這場會議的逐字稿已存成講稿時,對應的 Script.id(2026-10-03)。
   *
   * 為什麼要落在 session 上而不是 component state:「存成講稿」原本用
   * Set<number> 防重複,而它活不過切頁與重啟 —— 使用者回來再按一次,
   * 就會得到兩份一模一樣的講稿(與「連按兩次」是同一族缺陷,只是觸發的
   * 組合是跨頁/重啟)。存在 session 上,「已存成講稿」才是一個**事實**,
   * 不是一個只活在畫面上的記憶。備份/還原隨 session 自動流通。
   */
  savedAsScriptId?: number
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
  /**
   * 逐字稿不完整(語音辨識逾時或失敗)。
   *
   * 為什麼要存這個旗標:逾時時流程會繼續「用目前收到的逐字稿評分」,而分數、
   * 逐字稿、語速全部照算 —— 但沒有任何地方記得「這份逐字稿少了一段」。
   * 事後回看歷史只看得到一個分數,使用者會以為那就是自己的表現,
   * 而不是「麥克風/模型當時出狀況」。同一場裡不同題的完整度也不一樣,
   * 所以旗標掛在單題而不是整場。
   */
  partial?: boolean
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

/** 除錯:可直接模擬的即時回饋訊號種類(對應浮層的三種事件 UI) */
export type DebugSignalKind = 'turn' | 'coaching' | 'panic'

/** 浮層除錯控制的動作(實作為點擊浮層自己的控制項,走真實路徑) */
export type DebugOverlayAction =
  | 'compact'
  | 'expand'
  | 'lens'
  | 'exit-lens'
  | 'play'
  | 'pause'
  | 'follow'
  | 'recenter'

/**
 * 單筆 DOM 稽核結果的形狀。
 *
 * 定義在這裡而不是 src/renderer/src/lib/domAudit.ts 的原因:同一個形狀要跨越
 * 三個地方 —— renderer 的規則實作、除錯面板的顯示、以及 main 端轉手
 * executeJavaScript 回傳值時的型別。規則實作以 `import type` 取用,
 * 型別匯入會被完全抹除,所以不會破壞「DOM 稽核函式必須能序列化」的契約。
 */
export interface DomFinding {
  kind: string
  text: string
  /**
   * 這一筆是「問題」。同一份回傳陣列的最後一項會是 kind = '__tally',
   * text 放著每條規則的**評估次數**(JSON)。
   *
   * 為什麼需要它:`thin-slider` 曾經存在三輪、註解寫得很完整、看起來在工作,
   * 但它**一次都沒有觸發過** —— 因為它量的東西根本量不到。沒有計數,
   * 「從不觸發的規則」與「很有用的規則」在報告裡長得一模一樣(都是 0 筆問題)。
   *
   * 為什麼塞在陣列裡而不是另開一個回傳值:`page.evaluate(fn)` 只能序列化
   * 回傳值,而改變回傳型別會讓所有既有呼叫端(包括 e2e spec 與稽核腳本)
   * 一起壞掉。附加最後一項是唯一不破壞既有契約的做法。
   */
}

export interface AppInfo {
  version: string
  platform: string
  userDataPath: string
  /** 除錯能力是否啟用(判斷邏輯見 src/main/debug.ts —— 刻意排除 e2e,避免污染稽核量測) */
  debug: boolean
  /**
   * 稽核能力是否啟用(AI_TP_AUDIT=1 且未打包)。
   * 只拿來決定要不要掛「狀態強制橋」window.__auditForce,不影響任何可見 UI。
   */
  audit: boolean
  /**
   * 註冊失敗的全域熱鍵(已被其他程式佔用或無效)。
   *
   * 為什麼走 AppInfo 而不是只在 main 端留著:這份清單是「熱鍵沒反應」唯一的
   * 可查答案,而 e2e 需要在**測試失敗當下**讀到它 —— 否則每次只能猜。
   * DebugPanel 的診斷快照與 e2e 的失敗訊息共用同一個來源。
   */
  hotkeyConflicts: string[]
  /**
   * 已下載、待重啟安裝的更新。null = 沒有待安裝的更新。
   *
   * 為什麼要掛在 AppInfo 上而不只靠 APP_UPDATE_DOWNLOADED 廣播:那個事件是
   * **一次性**的 —— 送到時沒人在訂(更新通常在啟動 30 秒後下載完,那時
   * 使用者多半在總覽頁,而訂閱原本長在設定頁 mount 時),晚一點進設定頁
   * 就永遠看不到了。有了這個欄位,任何時候掛載的畫面都能補問回來。
   */
  updateInfo: { version: string; releaseNotes: string } | null
  /**
   * e2e 的環境情境(麥克風、Ollama),由 main 讀環境變數決定。
   *
   * 存在的理由:「麥克風權限被拒」與「Ollama 沒開」是使用者最常撞到的兩面牆,
   * 而它們在 CI 上測不到(沒有麥克風、沒有模型)。renderer 靠這個值在
   * getUserMedia / fetch 的邊界注入故障,產品程式碼不需要知道有這件事。
   *
   * 打包版裡兩個欄位一定都是 'ok'(見 src/main/debug.ts 的 E2E_ENV)。
   */
  e2eEnv: E2EEnv
}
