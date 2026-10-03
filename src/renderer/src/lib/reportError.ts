/**
 * reportError.ts — 「一件事發生錯了」的**單一入口**。
 *
 * 為什麼需要這支:
 *   這一輪之前,一個錯誤要經過三個各自獨立的決定才能出現在使用者面前:
 *     1. 這個錯誤認不認識?(describeError 的規則表)
 *     2. 要不要寫進日誌?(各頁自己決定要不要呼叫 logFromRenderer)
 *     3. 用什麼形式告訴使用者?toast / confirm / 靜默
 *   結果是 54 處 `toast.error(...)` 裡,**沒有任何一處**會留下可 grep 的錯誤碼。
 *   使用者回報「摘要一直失敗」時,開發者拿到的是一句沒有上下文的字串。
 *
 *   這支函式把三件事綁在一起:分類 → 記事件 → 顯示帶按鈕的提示。
 *   呼叫端只需要寫 `reportError('AI 摘要失敗', err, { provider })`。
 *
 * ── 為什麼不回傳東西、也不 throw ──
 *   它是給 catch 區塊用的**收尾**。回傳值或例外都會誘發「要不要再處理一次」
 *   的分支,而那些分支正是這個專案記載過的 bug 來源(同一個錯誤被翻譯兩次、
 *   或一半路徑靜默)。所以:它做完三件事就結束。
 *
 * ── 不靜默的部分 ──
 *   `silent: true` 只給兩種情況用:使用者自己取消(例如關掉檔案選擇框)、
 *   以及「同一件事正在重試中,這只是其中一次」。取消不該被寫成錯誤 ——
 *   否則診斷報告裡會有一堆使用者根本沒感覺的失敗。
 */
import { describeErrorAction, type ErrorContext } from './describeError'
import { toast, type ToastAction } from './toast'
import { errorCodeInfo, type ErrorCode } from '@shared/errorCodes'
import type { EventName } from '@shared/observability'

/** 一個 action 轉成 toast 能吃的形狀。不能吃多個:卡片只放一顆,免得變成選單。 */
function firstActionToToast(
  actions: ReturnType<typeof describeErrorAction>['actions']
): ToastAction | undefined {
  const a = actions[0]
  if (!a) return undefined
  const out: ToastAction = { label: a.label, kind: a.kind }
  if (a.page) out.page = a.page
  if (a.url) out.url = a.url
  return out
}

export interface ReportErrorOptions extends ErrorContext {
  /**
   * 事件名(寫進日誌)。必填。
   *
   * 為什麼必填:如果留空等呼叫端忘了,那個位置就會回到「只有字串」的狀態,
   * 而我們無法從程式碼看出那是不是遺漏 —— 這正是這個專案反覆記載的
   * 「量測層說謊」的同型問題(這裡是「記錄層說謊」)。必填讓它變成編譯期錯誤。
   */
  event: EventName
  /**
   * toast 的前綴。預設用事件語意較寬的話。
   * 例:「AI 摘要失敗」+ 「無法連線到 Ollama…」讀起來是完整的兩段。
   */
  prefix?: string
  /** 純本機事件紀錄的結構化細節(遮蔽在 main 端做,這裡不負責任) */
  fields?: Record<string, string | number | boolean | null>
  metrics?: Record<string, number>
  /** 使用者自己取消 —— 顯示成 info、不寫事件 */
  silent?: boolean
  /** 只寫事件,不顯示提示(給背景重試迴圈用:它每一輪都會再報一次) */
  quiet?: boolean
}

/**
 * 分類 → 記事件 → 顯示可行動提示。
 *
 * @param prefix 事件之前的人話,例:「AI 摘要失敗」。會成為 toast 的第一行。
 */
export function reportError(prefix: string, err: unknown, opts: ReportErrorOptions): void {
  const described = describeErrorAction(err, opts)

  if (!opts.silent && !opts.quiet) {
    // 有 action 的錯誤 toast 停駐不消失(見 toast.ts 的 NO_EXPIRY),
    // 所以按鈕的存在時間等於使用者自己關掉它的時間。
    const action = described.known ? firstActionToToast(described.actions) : undefined
    if (action) toast.error(`${prefix}。${described.body}`, action)
    else toast.error(`${prefix}。${described.body}`)
  }

  if (opts.silent) return

  // 事件在 UI 之後寫:使用者先看到提示,日誌再跟上。反過來的話,若
  // logEvent 拋出(它不會,整支包在 try 裡,但萬一),使用者就什麼都沒看到。
  const payload: Parameters<NonNullable<Window['api']>['logEvent']>[0] = { name: opts.event }
  // **包括 E_UNKNOWN 在內都寫進去**。認不出來本身就是一個有價值的訊號:
  // 它告訴我們規則表該補哪一條。若把 E_UNKNOWN 省略,診斷報告裡就會出現
  // 「有失敗事件但沒有任何代碼」的情形 —— 而那看起來與「事件紀錄壞了」
  // 完全一樣,正是這個專案記載過最貴的失敗模式。
  payload.code = described.code
  // message 只帶 prefix 與錯誤原文,**不帶中文指引**:
  // 中文指引會隨文案改動而變,而它的版本無意義。要看診斷的人要的是
  // 「發生了什麼」(事件名)與「錯誤原文」(可與使用者描述對照)。
  payload.message = `${prefix}: ${err instanceof Error ? `${err.name} ${err.message}` : String(err)}`
  if (opts.metrics) payload.metrics = opts.metrics
  if (opts.fields) payload.fields = opts.fields
  void window.api?.logEvent?.(payload)
}

/**
 * **直接**用一個錯誤碼報錯,跳過比對。
 *
 * 存在的理由:有些路徑的成因是**已知**的,不需要(也不應該)從錯誤字串去猜。
 * 最好的例子是螢幕擷取:`setDisplayMediaRequestHandler` 核准不到來源時,
 * Chromium 丟出來的也是 `NotAllowedError`,與麥克風權限被拒**同一個名稱**。
 * 讓規則比對去處理它,結果就是使用者被導去「Windows 設定 → 麥克風」,
 * 而他真正要改的是螢��擷取授權。診斷錯了,代價是他的時間。
 *
 * 用法前提:**你比規則表更清楚這個錯誤是什麼**。若只是「我猜是這個」,
 * 應該用 `reportError` 讓規則去比對 —— 否則就是把臆測寫成權威,
 * 而這支專案反對的正是那件事。
 */
export function reportCode(
  code: ErrorCode,
  err: unknown,
  opts: { event: EventName; metrics?: Record<string, number>; fields?: Record<string, string | number | boolean | null> }
): void {
  const info = errorCodeInfo(code)
  const action = firstActionToToast(info.actions)
  if (action) toast.error(info.message, action)
  else toast.error(info.message)

  const payload: Parameters<NonNullable<Window['api']>['logEvent']>[0] = { name: opts.event, code }
  payload.message = `${info.title}: ${err instanceof Error ? `${err.name} ${err.message}` : String(err)}`
  if (opts.metrics) payload.metrics = opts.metrics
  if (opts.fields) payload.fields = opts.fields
  void window.api?.logEvent?.(payload)
}

/**
 * 成功事件的輕量版。
 *
 * 存在的理由:只有失敗有紀錄時,「這個功能從來沒被嘗試過」與「它成功了」
 * 在診斷報告裡長得一樣 —— 而那正是回報者最常提供的資訊(他說他按了,
 * 沒反應;而日誌裡沒有任何一次嘗試)。
 */
export function reportEvent(
  event: EventName,
  opts: { metrics?: Record<string, number>; fields?: Record<string, string | number | boolean | null> } = {}
): void {
  const payload: Parameters<NonNullable<Window['api']>['logEvent']>[0] = { name: event }
  if (opts.metrics) payload.metrics = opts.metrics
  if (opts.fields) payload.fields = opts.fields
  void window.api?.logEvent?.(payload)
}
