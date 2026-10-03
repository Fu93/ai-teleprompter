/**
 * errorCodes.ts — 全專案唯一的錯誤碼表。
 *
 * 為什麼需要這張表(而不是各頁自己寫字串):
 *   兩件事同時需要「這個錯誤是什麼、該怎麼辦」——給使用者看的可行動提示,
 *   與寫進日誌讓人定位的機器可讀代碼。原始的狀態是:前者散落在 8 個檔案的
 *   `describeError` 規則表與 54 處 `toast.error(...)` 字串裡,後者完全不存在
 *   (main.log 只有自由文字)。兩邊各寫一次,遲早會有某一個錯誤「有提示但
 *   沒有代碼」或「有代碼但沒有提示」——而那正是回報問題時最難查的情況:
 *   使用者看得到一句話,日誌裡卻找不到對應的東西。
 *
 *   放在 shared/ 而不是 renderer:錯誤碼是**跨進程的識別碼**(renderer 產生、
 *   main 落盤),放進 renderer 就得靠字串在 IPC 上漂。
 *
 * 設計上刻意不做的事:
 *   - **不收錄所有可能的錯誤**。只收錄「我們真的知道該怎麼處理」的情況。
 *     認不出來的一律落到 `E_UNKNOWN` 並保留原始字串:寧可顯示英文原文(那是真的),
 *     也不要給一個自信但錯誤的診斷(見 describeError.ts 檔頭,以及那個把
 *     「辨識失敗」說成「沒有偵測到語音」的反例)。
 *   - **不把 retryable 當成診斷**。它是給 UI 決定「要不要給重試鈕」的單一旗標;
 *     網路類與權限類可重試,「找不到模型」重試再多次也不會變好 —— 它需要的是
 *     「下載」或「改設定」,不是「再試一次」。
 */

/** 跨進程穩定的錯誤識別碼。**改字串會讓既有日誌失去可比性,所以一旦發布就不再更動。 */
export type ErrorCode =
  | 'E_MIC_PERMISSION_DENIED'
  | 'E_MIC_NOT_FOUND'
  | 'E_MIC_BUSY'
  | 'E_SYSTEM_AUDIO_UNAVAILABLE'
  | 'E_AUTH_INVALID_KEY'
  | 'E_NETWORK_OLLAMA'
  | 'E_NETWORK_AI_API'
  | 'E_NETWORK_CLOUD_STT'
  | 'E_NETWORK_GENERIC'
  | 'E_MODEL_MISSING'
  | 'E_UNKNOWN'

/**
 * 這個請求實際的接收端。
 *
 * 存在的原因是不可省的:不論是 Ollama 沒開還是雲端 API 被防火牆擋,底層
 * (Node undici / Chromium)給的訊息都是同一句 `fetch failed` —— 連 ECONNREFUSED
 * 都只藏在 cause 裡,過了 IPC 就沒了。所以「看錯誤訊息猜供應商」在原理上做不到:
 * 少了這個參數就只能二選一,而選錯就是把「你的網路不通」說成「去啟動 Ollama」。
 */
export type ErrorProvider = 'ollama' | 'openai-compatible' | 'cloud-api'

export interface ErrorContext {
  provider?: ErrorProvider
}

/** 可行動提示裡,使用者可以按的下一個步驟。宣告式(不帶 callback)。 */
export type ErrorActionKind = 'retry' | 'goto' | 'external' | 'docs'

export interface ErrorAction {
  kind: ErrorActionKind
  /** 按鈕上顯示的字。已經用使用者的語言寫好,不是從代碼推出來的。 */
  label: string
  /** kind==='goto' 時的目的頁 */
  page?: 'settings' | 'record' | 'practice' | 'scripts'
  /** kind==='external' 時的目的網址 */
  url?: string
}

export interface ErrorCodeInfo {
  code: ErrorCode
  /** 一行標題。toast 的第一行、或日誌的人類可讀摘要。 */
  title: string
  /** 完整說明:發生了什麼 + 接下來該去哪裡改。兩件事都要回答。 */
  message: string
  /**
   * 允許的動作集合。
   *
   * 刻意**不含** `retry`:能不能重試是使用者動作之後的判斷(同一個連線錯誤,
   * 已經失敗三次之後按「重試」是合理的,第一次失敗時就給重試鈕是)。
   * 這一欄只宣告「什麼是對的下一步」。
   */
  actions: ErrorAction[]
  /** 直接按下去會不會成功。不為 true 時 UI 不應該主動提供重試鈕。 */
  retryable: boolean
}

/** 可以直接跳到「教學」的兩個地方。
 *
 *  只有兩處,不是因為懶得寫第三處:連結必須是**真的存在且不會壞**的頁面。
 *  放一堆沒人維護的錨點,結果是使用者點進去看見 404 —— 那比沒有教學更糟,
 *  因為它會讓他對這份指引失去信心。
 *
 *  這兩個常數是**全專案唯一的**出處:`preflight.ts` 原本自己定義了一份
 *  OLLAMA_DOWNLOAD_URL,兩份網址可以各自漂移,而漂移之後使用者按「下載」
 *  會被帶到一個跟這裡描述的不一樣的地方 —— 那屬於「承諾與行為不一致」,
 *  是這個專案反覆記載的失敗模式。 */
export const DOCS_URL = 'https://github.com/Fu93/ai-teleprompter#常見問題'
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download/windows'

const SETTINGS_PAGE = { kind: 'goto', label: '前往設定', page: 'settings' } as const

/**
 * 錯誤碼表。順序即比對順序不重要的證明(對應的判斷在 describeError.ts),
 * 這裡的順序是照「使用者最常撞的」排,方便日誌檢視時眼睛先落在上面。
 */
export const ERROR_CODES: Record<ErrorCode, ErrorCodeInfo> = {
  // ---- 麥克風:全新使用者最常撞到的三面牆 ----
  E_MIC_PERMISSION_DENIED: {
    code: 'E_MIC_PERMISSION_DENIED',
    title: '麥克風權限被拒',
    message:
      '麥克風或攝影機權限被拒絕。請到「設定 → 隱私權與安全性 → 麥克風」允許這個 App,再重新錄音。',
    actions: [
      SETTINGS_PAGE,
      { kind: 'docs', label: '查看教學', url: DOCS_URL }
    ],
    retryable: true
  },
  E_MIC_NOT_FOUND: {
    code: 'E_MIC_NOT_FOUND',
    title: '找不到麥克風',
    message: '找不到可用的麥克風。請確認麥克風已接上並在「錄音轉錄」頁勾選「我的麥克風」。',
    actions: [{ kind: 'goto', label: '前往錄音設定', page: 'record' }, SETTINGS_PAGE],
    retryable: true
  },
  E_MIC_BUSY: {
    code: 'E_MIC_BUSY',
    title: '麥克風被其他程式占用',
    message: '麥克風正被其他程式占用。請關閉其他使用麥克風的程式(例如視訊會議、錄音軟體)後再試。',
    actions: [{ kind: 'docs', label: '查看教學', url: DOCS_URL }],
    retryable: true
  },
  /**
   * 系統音訊擷取失敗**不是**麥克風問題。
   *
   * 為什麼要獨立一個碼:main 的 setDisplayMediaRequestHandler 核准不到來源時,
   * Chromium 丟出來的也是 `NotAllowedError`,與麥克風權限被拒**同一個錯誤名**。
   * 原本它會被第一條規則接走,於是使用者被導去「Windows 設定 → 麥克風」——
   * 而他真正要改的是螢幕擷取授權。診斷錯了,代價是他的時間。
   */
  E_SYSTEM_AUDIO_UNAVAILABLE: {
    code: 'E_SYSTEM_AUDIO_UNAVAILABLE',
    title: '無法擷取系統音訊',
    message:
      '無法擷取系統音訊。請確認有可擷取的螢幕與音訊輸出,或先只用「我的麥克風」開始。',
    actions: [{ kind: 'docs', label: '查看教學', url: DOCS_URL }],
    retryable: true
  },

  // ---- 認證 ----
  E_AUTH_INVALID_KEY: {
    code: 'E_AUTH_INVALID_KEY',
    title: 'API 金鑰無效或過期',
    message: 'API 金鑰無效或過期。請到「設定」頁重新填寫 API Key 後再試。',
    actions: [SETTINGS_PAGE],
    // 重試有意義:金鑰換好之後,同一個請求本來就會成功。但按下去之前要先修金鑰,
    // 所以 UI 應該把「前往設定」排在「重試」之前(順序由 actions 決定)。
    retryable: true
  },

  // ---- 連線:同一句 fetch failed,三種不同診斷 ----
  E_NETWORK_OLLAMA: {
    code: 'E_NETWORK_OLLAMA',
    title: '無法連線到 Ollama',
    message:
      '無法連線到 Ollama。請確認已安裝並啟動(終端機執行 ollama serve,或直接開啟 Ollama 應用程式)。',
    actions: [
      { kind: 'external', label: '下載 Ollama', url: OLLAMA_DOWNLOAD_URL },
      SETTINGS_PAGE
    ],
    retryable: true
  },
  E_NETWORK_AI_API: {
    code: 'E_NETWORK_AI_API',
    title: '無法連線到 AI API',
    message: '無法連線到設定的 AI API。請確認網路可用,並檢查「設定 → AI 助理」的 Base URL 是否正確。',
    actions: [SETTINGS_PAGE],
    retryable: true
  },
  E_NETWORK_CLOUD_STT: {
    code: 'E_NETWORK_CLOUD_STT',
    title: '無法連線到雲端語音 API',
    message: '無法連線到雲端語音 API。請確認網路可用,並檢查「設定 → 語音辨識」的 Base URL 是否正確。',
    actions: [SETTINGS_PAGE],
    retryable: true
  },
  E_NETWORK_GENERIC: {
    code: 'E_NETWORK_GENERIC',
    title: '網路連線失敗',
    message: '網路連線失敗。請確認網路可用後再試。',
    // 沒有 provider 就不臆測目的地,所以連「前往設定」都不給:那會讓人
    // 懷疑是自己設錯了,而事實上他什麼都沒設錯。
    actions: [],
    retryable: true
  },

  // ---- 模型 ----
  E_MODEL_MISSING: {
    code: 'E_MODEL_MISSING',
    title: '找不到本地模型',
    message: '找不到對應的本地模型。請先下載模型(或執行 ollama pull qwen2.5:7b)後再試。',
    actions: [SETTINGS_PAGE],
    // 刻意 false:重試再多次也不會讓模型出現。要的是「下載」,而下載發生在
    // 設定頁/第一次錄音,不是按一次重試。
    retryable: false
  },

  /**
   * 認不出來的錯誤。
   *
   * `message` 刻意不寫死在這裡,由 describeError 帶入原始字串 —— 因為原文
   * 才是這個情況下唯一真實的資訊。寫死一句「發生未預期的錯誤」會讓使用者
   * 看不到任何線索,而那句話對他完全沒有下一步可言。
   */
  E_UNKNOWN: {
    code: 'E_UNKNOWN',
    title: '發生未預期的錯誤',
    message: '',
    actions: [],
    retryable: true
  }
}

/** 依代碼取資訊。給日誌與除錯面板用,避免到處寫 switch。 */
export function errorCodeInfo(code: ErrorCode): ErrorCodeInfo {
  return ERROR_CODES[code] ?? ERROR_CODES.E_UNKNOWN
}

/** 診斷報告用的可讀標籤:「E_MIC_PERMISSION_DENIED」比「麥克風權限被拒」好 grep。 */
export function errorCodeLabel(code: ErrorCode): string {
  return errorCodeInfo(code).title
}
