/**
 * observability.ts — 產品化的事件與錯誤紀錄契約(跨進程)。
 *
 * ── 為什麼需要這一層 ──
 *   公開發佈後,使用者遇到的問題對開發者來說是看不見的。唯一的回饋來源是
 *   他主動附上的一個資料夾。原始的狀態是:回報者貼上 main.log,而 main.log
 *   只有自由文字 —— 「按了開始練習沒反應」與「摘要一直轉圈」在裡面長得
 *   一模一樣(都是好幾行 `something failed`),而「他用的是哪個引擎、
 *   連線到哪個位址、權限有沒有開」完全不在日誌裡。
 *
 *   也就是說:使用者描述的是**症狀**,日誌記的是**過程**,而兩者之間沒有
 *   一個穩定的識別碼可以對起來。於是每一個回報都要靠人猜。
 *
 * ── 邊界:這是純本機的 ──
 *   沒有任何事件離開這台電腦。README 與設定頁對使用者的承諾是
 *   「資料只在你的電腦」,加一套遙測等於在沒有告知的情況下把那個承諾拿掉。
 *   如果之後真的需要匿名統計,那是**另一個**功能,要自己的同意流程與開關,
 *   不該從這一條偷渡 —— 一個「只是寫在本機」的日誌默默變成上傳,
 *   是最難被發現的一種信任背書。
 *
 * ── 事件名的取捨 ──
 *   刻意收斂成少數幾個可 grep 的名字,而不是讓每個呼叫端自訂字串。
 *   自由字串的缺點很實際:同一件事會出現 `summary-failed`、`ai_summary_error`、
 *   `SummaryError` 三種寫法,而沒有人會在半年後記得是哪一種。
 */
import type { ErrorCode } from './errorCodes'

/**
 * 事件名。
 *
 * 命名規則:`<階段>_<對象>_<結果>`。全部小寫加底線,不要用駝峰 ——
 * 底線讓 grep 的前綴比對不會誤中,駝峰的 `E2E` 與 `e2e` 只差大小寫。
 */
export type EventName =
  /** 啟動階段:視窗建立、除錯能力判定、safeStorage 遷移 */
  | 'startup_main_ready'
  | 'startup_hotkey_conflict'
  /** 轉錄:STT 呼叫本身(引擎、耗時、成功/失敗) */
  | 'transcribe_started'
  | 'transcribe_succeeded'
  | 'transcribe_failed'
  /** 摘要/練習/Panic 共用的 AI 呼叫 */
  | 'ai_request_started'
  | 'ai_request_succeeded'
  | 'ai_request_failed'
  /** 備份:匯出與還原(成功與失敗) */
  | 'backup_exported'
  | 'backup_imported'
  | 'backup_failed'
  /** 教練訊號觸發(用於會後報告與 debug) */
  | 'coaching_fired'
  /** 使用者主動索取診斷報告 */
  | 'diagnostics_report_requested'

/**
 * 事件欄位。
 *
 * `code` 與 `message` 刻意分開:code 給 grep(穩定、可比對),message 給人看
 * (可能會改、可能含路徑)。把兩者混成一個欄位的話,`grep E_MIC` 會同時命中
 * 真正的原因與一個剛好提到「麥克風」的無關事件。
 */
export interface EventPayload {
  name: EventName
  code?: ErrorCode
  message?: string
  /** 數值型指標:耗時(ms)、筆數、大小。都用數字,不要塞字串化過的值。 */
  metrics?: Record<string, number>
  /**
   * 結構化細節。
   *
   * **寫入前必須經過 redactEventFields**。這是唯一保證不把敏感內容寫進
   * 日誌的地方(見該函式的檔內說明):日誌會隨著「回報問題時附上」而離開
   * 這台電腦,所以寫進去的東西必須假設它會被貼到公開的 issue 上。
   */
  fields?: Record<string, string | number | boolean | null>
}

/** 診斷報告(使用者複製後貼給我們的東西)的形狀。 */
export interface DiagnosticsReport {
  appVersion: string
  platform: string
  /** 產生報告的時間(ISO 8601) */
  generatedAt: string
  /**
   * 設定摘要,**已遮蔽**。
   *
   * 只放「會影響診斷」的旗標與端點主機名,不放逐字稿、不放金鑰、不放
   * 講稿內容。見 buildDiagnosticsReport 的遮蔽規則。
   */
  settings: Record<string, string | number | boolean | null>
  /** 近期錯誤碼統計(code → 次數),只含 E_* 的項目 */
  errorCounts: Array<{ code: ErrorCode; count: number; lastAt: string }>
  /**
   * 近期事件(已遮蔽),最新的在前。
   *
   * `metrics` 是**只有數字**的數值指標(耗時、筆數、大小)。它不會經過
   * redactEventFields(那條路徑只處理 fields),所以 events.ts 在存入前
   * 就把非有限數字丟棄了 —— 數字不可能是秘密,這條保證寫在該處的註解與測試裡。
   */
  recentEvents: Array<{
    at: string
    name: EventName
    code?: ErrorCode
    message?: string
    metrics?: Record<string, number>
  }>
}

/**
 * 敏感欄位名(小寫比對)。
 *
 * 為什麼用**名稱**擋而不是用值的形狀:名稱是有限、可窮舉、可測試的;
 * 值的形狀不是(一個合法的會議標題裡也可能出現 "apiKey" 這四個字)。
 * 漏掉一個新的欄位名,和漏掉一個新的欄位形狀相比,後者無從發現 —— 所以
 * 選擇可窮舉的那一邊。
 */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /key/i,
  /token/i,
  /secret/i,
  /password/i,
  /auth/i,
  /transcript/i,
  /content/i,
  /script/i,
  /text/i,
  /prompt/i
]

/** 是否為敏感欄位。測試會餵真實的欄位名進來,不要靠「讀起來像」來保證。 */
export function isSensitiveField(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key))
}

/** 遮蔽後的固定字串。刻意讓它看起來像真的值 ——
 *  否則「'[redacted]'」在報告裡一眼就被看出是遮蔽,反而成了「這裡有東西」
 *  的提示;而對同一份報告做兩次遮蔽應該產生同樣的檔案大小量級。 */
export const REDACTED = '(已隱藏)'

/**
 * 把欄位表遮蔽掉敏感鍵。
 *
 * 這是**唯一**保證不寫出敏感內容的地方,也是診斷報告與事件紀錄共用同一個
 * 函式的原因:兩條路徑共用同一份遮蔽規則,才不會出現「事件乾淨但報告乾淨
 * 得不夠」的情況。
 */
export function redactEventFields(
  fields: Record<string, string | number | boolean | null> | undefined
): Record<string, string | number | boolean | null> | undefined {
  if (!fields) return undefined
  const out: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = isSensitiveField(k) ? REDACTED : v
  }
  return out
}

/**
 * 轉成可以貼給人看的文字。
 *
 * 刻意不用 JSON:使用者要把它貼在 issue 裡,JSON 的括號與引號會讓人難以閱讀,
 * 而這份報告的讀者首先是人、其次才是 grep。
 *
 * 放在 shared/ 而不是 main/diagnostics.ts:renderer 也要用它(設定頁的
 * 「複製診斷報告」)。而 main/diagnostics.ts 會 import electron 的 `app` ——
 * 讓 renderer 匯入它會把整個 electron 模組拖進前端 bundle。
 */
export function formatDiagnosticsReport(r: DiagnosticsReport): string {
  const lines: string[] = [
    '=== AI 提詞機 診斷報告 ===',
    `版本:${r.appVersion}`,
    `平台:${r.platform}`,
    `產生時間:${r.generatedAt}`,
    '',
    '--- 設定摘要(已遮蔽)---'
  ]
  for (const [k, v] of Object.entries(r.settings)) {
    lines.push(`  ${k} = ${v === null ? '(無)' : v}`)
  }
  lines.push('', '--- 錯誤統計 ---')
  if (r.errorCounts.length === 0) lines.push('  (無)')
  for (const c of r.errorCounts) {
    lines.push(`  ${c.code} × ${c.count}  最後一次 ${c.lastAt}`)
  }
  lines.push('', '--- 近期事件 ---')
  if (r.recentEvents.length === 0) lines.push('  (無)')
  for (const e of r.recentEvents) {
    const m = e.metrics ? ' ' + Object.entries(e.metrics).map(([k, v]) => `${k}=${v}`).join(' ') : ''
    lines.push(`  ${e.at} ${e.name}${e.code ? ` ${e.code}` : ''}${e.message ? ` — ${e.message}` : ''}${m}`)
  }
  lines.push('', '（本報告只含設定旗標與錯誤碼,不含逐字稿、講稿內容與 API 金鑰。）')
  return lines.join('\n')
}

/**
 * 把端點 URL 收斂成主機名。
 *
 * 為什麼不能直接放完整 URL:OpenAI 相容端點常把路徑寫成
 * `https://api.groq.com/openai/v1/v1/...` 之類,有時也會有人在路徑裡塞
 * 專案 ID 或 token。診斷只需要知道「連到哪個服務」,主機名就夠了。
 * 反過來說,`localhost:11434` 這種本機位址必須原樣保留 —— 「他用的是
 * 本機 Ollama 還是雲端」正是最常被問的第一個問題。
 */
export function endpointHost(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    // 不是合法 URL(使用者打了半個字):原樣回傳短字串,不要整段丟進日誌。
    return url.length <= 40 ? url : `${url.slice(0, 40)}…`
  }
}
