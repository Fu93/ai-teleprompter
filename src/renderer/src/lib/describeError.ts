/**
 * describeError.ts — 把技術錯誤翻成使用者看得懂的 actionable 指引。
 *
 * 為什麼需要這層:
 *   使用者撞到最常見的第一個牆是「麥克風權限被拒」,而 getUserMedia 丟出來的是
 *   Chromium 的英文 NotAllowedError。全專案原本有 8 處直接
 *   `toast.error(err.message)`,等於把 "Permission denied" 直接丟給中文介面,
 *   4 秒後消失,使用者既不知道發生什麼事,也不知道要去哪裡改。
 *
 *   同一個專案裡 AI 那條路徑卻寫得很好(「請先在設定頁填入 Base URL 與模型」),
 *   所以問題從來不是能力不足,而是**沒有共用層**:各頁各自決定要不要翻譯,
 *   結果好壞參半、同一個錯誤在不同頁面說法不一致。
 *
 * 設計原則:只翻譯「我們真的知道該怎麼處理」的情況,其餘一律回退到原始訊息。
 *   寧可顯示英文原文(至少是真實的),也不要給一個自信但錯誤的診斷。
 *   呼應 Record 停止時那個反例:把「辨識失敗」說成「沒有偵測到語音」,
 *   會讓使用者跑去查麥克風硬體,浪費的是他的時間。
 *
 * ── 這一輪的形狀變更 ──
 *   規則表原本**同時**負責「比對」與「寫文案」,所以每條規則自己帶一段中文。
 *   現在文案搬到 `src/shared/errorCodes.ts`,這裡只留比對。
 *
 *   為什麼要拆:錯誤碼是跨進程的識別碼(renderer 產生、main 落盤、日誌裡 grep),
 *   而文案是給人看的。兩者綁在一起時,想給同一個錯誤加一句更好的話,
 *   就得順手發一個新代碼;想讓日誌有代碼,就得順手決定文案。拆開之後
 *   「同一個診斷、三種供應商目的地」這種情況(連線失敗)可以用**一個** match
 *   表達,而不是三條各自重寫的 regex。
 *
 *   `describeError()`(字串版)保留,是給不需要按鈕的地方用的包裝 ——
 *   8 個既有呼叫點與 11 條既有測試都不需要改。
 */
import { errorCodeInfo, type ErrorAction, type ErrorCode, type ErrorContext } from '@shared/errorCodes'

export type { ErrorContext, ErrorProvider, ErrorAction } from '@shared/errorCodes'

/**
 * 從「不是本 realm 的 Error」的物件裡挖出可讀文字。
 *
 * ## 為什麼需要這一層(這是實測出來的,不是想像的)
 *
 * Electron 的 renderer 有多個 JS realm:preload 跑在 isolated world,頁面跑在
 * main world。兩邊的 `Error` 是**不同的建構子**,所以從那邊丟過來的錯誤
 * 在這邊 `err instanceof Error` 是 false。原本的寫法於是掉進
 * `JSON.stringify(err)` —— 而 Error/DOMException 的 `name`、`message`、`stack`
 * 都是 prototype 上的 getter,不是 own property,`JSON.stringify` 只會得到
 * `{}`。使用者看到的就是:
 *
 *     攝影機不可用（{"isTrusted":true}）。
 *
 * 一句沒有任何資訊的錯。它出現在**最常見的第一個牆**(麥克風/攝影機權限)上,
 * 而這個模組存在的全部理由就是讓那句話變得可行動。
 *
 * ## 為什麼不能改成「不要用 instanceof」
 *
 * 因為跨 realm 的 Error 仍然有可讀的 `name`/`message` —— 只需要**用屬性去讀**,
 * 而不是問原型鏈。所以這裡讀 name/message/type 這幾個**字串屬性**。
 *
 * 仍然保留「認不出來就回退到原始字串」的原則:寧可顯示英文原文
 * (至少是真實的),也不要給一個自信但錯誤的診斷(見檔頭)。
 */
function structuredText(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const o = err as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

  const parts: string[] = []
  const name = str(o['name'])
  const message = str(o['message'])
  // DOMException: name=NotAllowedError,message=Permission denied → 兩個都要,
  // 因為比對規則認的是 name,而使用者看得懂的是 message。
  if (name != null) parts.push(name)
  if (message != null && message !== name) parts.push(message)
  // Event / ErrorEvent: 沒有 message,但 type 是它唯一像樣的識別。
  const type = str(o['type'])
  if (type != null && !parts.includes(type)) parts.push(type)

  if (parts.length > 0) return parts.join(' ')
  // 連一個可讀欄位都沒有 → 讓它繼續往 JSON.stringify 走(原行為)。
  return null
}

/** 取得錯誤的可比對文字:Error 用 name+message,字串直接用本身。 */
function textOf(err: unknown): string {
  if (err instanceof Error) return `${err.name} ${err.message}`
  if (typeof err === 'string') return err
  const structured = structuredText(err)
  if (structured !== null) return structured
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** 從原始錯誤取不含堆疊的使用者可見字串(認不出來時用它)。 */
function rawMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return textOf(err)
}

/**
 * 比對規則。**只負責「是哪一種」,不負責說什麼話。**
 *
 * 順序有意義:先比對具體的 HTTP/網路錯誤,最後才是泛用的名稱比對,
 * 避免「連線失敗」被後面的規則蓋掉。
 *
 * `code` 是一個函式而非一個值,因為連線類必須看 ctx.provider 才決定
 * 診斷(code 不同)。若把它寫成靜態值,`fetch failed` 在三種情境下會被
 * 硬編成同一個碼 —— 那正是本檔案自己說不可以犯的錯。
 */
interface MatchRule {
  test: RegExp
  code: ErrorCode | ((ctx: ErrorContext) => ErrorCode)
}

const MATCH_RULES: MatchRule[] = [
  {
    // 麥克風/攝影機權限被拒 —— 全新使用者最常撞到的第一個牆
    test: /NotAllowedError|Permission denied|permission.*denied|denied.*permission/i,
    code: 'E_MIC_PERMISSION_DENIED'
  },
  {
    test: /NotFoundError|Requested device not found|找不到.*裝置|找不到.*麥克風/i,
    code: 'E_MIC_NOT_FOUND'
  },
  {
    test: /NotReadableError|Could not start audio source|device.*(busy|in use)|裝置.*(忙碌|被占用)/i,
    code: 'E_MIC_BUSY'
  },
  {
    // 雲端 STT / AI 的金鑰問題
    test: /\b401\b|\b403\b|invalid[_ -]?api[_ -]?key|incorrect api key|unauthorized|authentication/i,
    code: 'E_AUTH_INVALID_KEY'
  },
  {
    // 連線失敗:訊息本身分不出供應商,靠 ctx.provider 決定要說「啟動 Ollama」
    // 還是「檢查 Base URL」。沒有 ctx 就不猜(見 ErrorContext 的註解)。
    test: /ECONNREFUSED|ECONNRESET|fetch failed|Failed to fetch|NetworkError|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network.*error|連線.*(失敗|被拒|拒絕|中斷)|無法連線|網路/i,
    code: (ctx) => {
      switch (ctx.provider) {
        case 'ollama':
          return 'E_NETWORK_OLLAMA'
        case 'openai-compatible':
          return 'E_NETWORK_AI_API'
        case 'cloud-api':
          return 'E_NETWORK_CLOUD_STT'
        default:
          return 'E_NETWORK_GENERIC'
      }
    }
  },
  {
    // 本地模型沒下載 —— 第一次使用 Whisper/Ollama 都會撞到
    test: /model.*not found|404.*model|尚未下載|模型未下載|not found.*model/i,
    code: 'E_MODEL_MISSING'
  }
]

/**
 * 判斷這個錯誤屬於哪一類。
 *
 * 這是本模組唯一的真相來源:`describeError`、`describeErrorAction` 與
 * `isActionable` 全部走它。三個函式各自寫一份比對表的那個年代,已經有過
 * 「錯誤提示認得、但日誌沒有代碼」的落差 —— 因為當時根本沒有代碼這回事。
 */
export function classifyError(err: unknown, ctx: ErrorContext = {}): ErrorCode {
  const text = textOf(err)
  for (const r of MATCH_RULES) {
    if (!r.test.test(text)) continue
    return typeof r.code === 'function' ? r.code(ctx) : r.code
  }
  return 'E_UNKNOWN'
}

/** 可行動的錯誤描述:給「有按鈕」的介面用。 */
export interface ActionableError {
  /** 跨進程穩定碼,寫進日誌 */
  code: ErrorCode
  /** 一行標題 */
  title: string
  /** 完整說明 */
  body: string
  /** 使用者可以按的下一步 */
  actions: ErrorAction[]
  /** 按下去會不會成功;false 時 UI 不該主動給重試鈕 */
  retryable: boolean
  /**
   * 認得嗎?
   *
   * 存在的唯一理由:「認得的錯誤」才配給按鈕與標題,不認得的只給原文 ——
   * 對一個我們不知道成因的錯誤說「請到設定頁」,是給一個自信的假診斷。
   */
  known: boolean
}

/**
 * 把任意錯誤轉成帶按鈕的可行動描述。
 *
 * 認得的錯誤回傳中文指引 + 該按的鈕;不認得的回退到原始字串且 `actions` 為空 ——
 * 寧可顯示真實的英文原文,也不要給一個自信但錯誤的診斷。
 */
export function describeErrorAction(err: unknown, ctx: ErrorContext = {}): ActionableError {
  const code = classifyError(err, ctx)
  const info = errorCodeInfo(code)
  if (code === 'E_UNKNOWN') {
    const raw = rawMessage(err)
    return {
      code,
      title: info.title,
      // 空字串的錯誤訊息不能拿來當提示:那會產生一個沒有內容的 toast。
      body: raw || info.title,
      actions: [],
      retryable: info.retryable,
      known: false
    }
  }
  return {
    code,
    title: info.title,
    body: info.message,
    actions: info.actions,
    retryable: info.retryable,
    known: true
  }
}

/**
 * 把任意錯誤轉成給使用者看的訊息(純文字)。
 *
 * 這是 `describeErrorAction().body` 的包裝:只需要一句話的地方(例如寫進
 * 檔案的匯出結果)不必知道有沒有按鈕。認得的錯誤回傳中文指引;不認得的回退
 * 到原始字串。
 */
export function describeError(err: unknown, ctx: ErrorContext = {}): string {
  return describeErrorAction(err, ctx).body
}

/** 是否為「使用者可以自己修」的錯誤(用於決定要不要顯示詳細原文) */
export function isActionable(err: unknown): boolean {
  return classifyError(err) !== 'E_UNKNOWN'
}
