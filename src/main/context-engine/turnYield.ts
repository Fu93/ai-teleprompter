/**
 * turnYield.ts — turn-yield「該你說話了」偵測器
 *
 * 移植 v3 STT 管線的 TURN_CANDIDATE / SPEAKING_PEER_SILENCE 精神,
 * 改為 transcript 純函數版:VAD 靜音事件以 AudioSegmenter 的分段到達
 * 時間戳取代(段落本身就是「對方講完一段」的事件)。
 *
 * 規則:
 * - 對方新段是問句/邀答語尾 → 'turn'(該你說話了)
 * - 對方新段夠長但非問句 → 'peer_silence'(對方已停頓,資訊性提示)
 * - 同一觸媒句 / 全域冷卻窗內 → 不重複觸發
 * - 刻意不做「我方剛發言就抑制」:對話是輪流的,對方在我回答後追問
 *   才是常態(提示該在追問時出現);我方開口時由 UI 層收掉提示。
 */
import type { TurnYieldPayload } from '@shared/types'

export interface TurnYieldResult {
  /** 'turn' = 該你說話了;'peer_silence' = 對方已停頓(資訊性提示) */
  kind: 'turn' | 'peer_silence'
  /** 觸發的觸媒句 */
  triggerText: string
  /** true = 因問句/邀答語尾觸發 */
  question: boolean
}

/** 問句／邀答語尾偵測:句尾符號 + 對話性語尾助詞/啟動詞/疑問詞 */
const QUESTION_PATTERNS: RegExp[] = [
  /[?？]\s*$/u, // 直接問號
  /(?:嘛|嗎|吧|呢|啊|麼)\s*[。．!！]?\.?\s*$/u, // 繁中語尾助詞
  /^(?:can|could|would|do|does|did|are|is|was|were|have|has|will|should|shall)\b/i, // 英文啟動詞
  /\b(?:right|okay|ok)\s*\?\s*$/i, // 英文 tag question
  // 繁中疑問詞:疑問詞後直接到句尾(不留句號——含句號者多為句中嵌入的陳述);
  // 「哪/幾」用詞組,避免「哪怕/幾乎」誤報
  /(?:如何|怎樣|怎麼|什麼|多少|為什麼|為何|是否|能否|可否|是不是|哪裡|哪個|哪一|哪位|幾個|幾位)[^。！？!?.]*$/u,
  /(?:麻煩|請)\s?[^。！？!?.]{1,12}(?:說明|介紹|分享|談談|講)[^。！？!?.]*$/u // 邀答句式
]

export function isQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return QUESTION_PATTERNS.some((p) => p.test(t))
}

/** 可變狀態袋(每次會話開始建立一次) */
export interface TurnYieldState {
  /** 上一次觸發的觸媒句 */
  lastFiredText: string
  /** 上一次觸發時間戳;0 = 尚未觸發 */
  lastFiredAt: number
  /** 上一次觸發的類別(決定下次套哪個冷卻窗) */
  lastFiredKind: 'turn' | 'peer_silence' | ''
}

export function createTurnYieldState(): TurnYieldState {
  return { lastFiredText: '', lastFiredAt: 0, lastFiredKind: '' }
}

export interface TurnYieldOptions {
  /** 同一觸媒句不重複觸發的時間窗(ms)— 對方重播/來回確認 */
  refireCooldownMs?: number
  /** turn 觸發後的全域冷卻窗(ms)— 避免連續問句洗版 */
  globalCooldownMs?: number
  /** peer_silence 觸發後的冷卻窗(ms)— 對方連續講長段時不能每段都提示 */
  peerSilenceCooldownMs?: number
  /** 非問句但 ≥ 此字元數的對方段落也提示(0 = 停用 peer_silence) */
  peerSilenceMinChars?: number
}

export const TURN_YIELD_DEFAULTS: Required<TurnYieldOptions> = {
  refireCooldownMs: 25_000,
  globalCooldownMs: 15_000,
  peerSilenceCooldownMs: 60_000,
  peerSilenceMinChars: 30
}

/**
 * 以「對方新段 + 我方抑制 + 冷卻」評估是否該提示。
 * 呼叫時機:main 收到 speaker==='them' 的轉錄段落時。
 * 回傳非 null 時,呼叫端應再呼叫 recordTurnYield() 記帳。
 */
export function evaluateTurnYield(
  state: TurnYieldState,
  themText: string,
  now: number,
  opts: TurnYieldOptions = {}
): TurnYieldResult | null {
  const o = { ...TURN_YIELD_DEFAULTS, ...opts }
  const text = themText.trim()
  if (!text) return null

  // 1) 同一觸媒句冷卻(窗比全域長,先查)
  if (
    state.lastFiredAt > 0 &&
    text === state.lastFiredText &&
    now - state.lastFiredAt < o.refireCooldownMs
  ) {
    return null
  }
  // 2) 冷卻:turn 用短窗(問句值得快提示);peer_silence 用長窗(會議中對方
  //    每段長話都提示會洗版)
  if (state.lastFiredAt > 0) {
    const elapsed = now - state.lastFiredAt
    const cooldown =
      state.lastFiredKind === 'peer_silence' ? o.peerSilenceCooldownMs : o.globalCooldownMs
    if (elapsed < cooldown) return null
  }

  // 3) 分類
  if (isQuestion(text)) {
    return { kind: 'turn', triggerText: text, question: true }
  }
  if (o.peerSilenceMinChars > 0 && text.length >= o.peerSilenceMinChars) {
    return { kind: 'peer_silence', triggerText: text, question: false }
  }
  return null
}

/** 評估結果非 null 後呼叫:記帳(冷卻起算點) */
export function recordTurnYield(state: TurnYieldState, result: TurnYieldResult, now: number): void {
  state.lastFiredAt = now
  state.lastFiredText = result.triggerText
  state.lastFiredKind = result.kind
}

/** 會話邊界重置(新場次開始時呼叫):清冷卻與觸媒記憶 */
export function resetTurnYieldState(state: TurnYieldState): void {
  state.lastFiredAt = 0
  state.lastFiredText = ''
  state.lastFiredKind = ''
}

// ---- 防抖 → 送出的薄殼 ----

/** 防抖窗:等可能接續的後半句(純函數層常數,測試可讀) */
export const TURN_YIELD_DEBOUNCE_MS = 1200

/** gate 內部的 pending:比送出的 payload 多帶觸媒句,冷卻要靠它認同句 */
interface TurnYieldPending extends TurnYieldPayload {
  triggerText: string
}

export interface TurnYieldGateDeps {
  /**
   * 送出訊號。回傳 true 代表**真的送達**(浮層視窗存在且未銷毀)。
   *
   * 收 false 是這顆 gate 存在的理由:送達失敗就**不記冷卻**,
   * 同一句話可以立刻重推,不會被自己的冷卻吃掉。
   */
  deliver: (p: TurnYieldPayload) => boolean
  /** 時鐘(測試可注入假時鐘) */
  now?: () => number
  /** 排防抖用的 setTimeout(測試可注入)。回傳值由 clearTimer 收。 */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** 清防抖用的 clearTimeout(測試可注入;接收 setTimer 的回傳值) */
  clearTimer?: (handle: unknown) => void
}

export interface TurnYieldGate {
  /** 對方新段落 → 評估;可能觸發時掛防抖。不記冷卻。 */
  push(text: string): void
  /** 取消未送出的提示(我方已開口) */
  cancel(): void
  /** 會話邊界:清 pending 與冷卻 */
  reset(): void
  /** 只讀檢視,測試用 */
  readonly state: TurnYieldState
}

/**
 * 「評估 → 1.2s 防抖 → 送出 → **送出成功才記冷卻**」這條流程的純函式版。
 *
 * 為什麼要把這件事抽出來,以及為什麼冷卻必須等送出成功才記:
 *
 * 舊版在**排防抖時**就呼叫 recordTurnYield()。於是只要浮層視窗那一刻不在
 * (已收掉/被銷毀 → deliver 早退),或 renderer 還沒訂閱
 * (useTurnYield 在 turnYield=false 時走 `if (!enabled) return`,不註冊 listener),
 * 訊號就送不出去 —— 但 25 秒同句冷卻與 15 秒全域冷卻**已經記下**。
 *
 * 使用者看到的情境:對方問了一句話,你剛好按下快捷鍵把浮層收掉(或設定還在套用中),
 * 提示憑空消失,而且那句話接下來 25 秒內**永遠不會再提示**。這不是量測問題,
 * 是真的產品缺陷 —— 「沒送達」不該和「送到了但要防洗版」共用同一種冷卻語意。
 *
 * 冷卻起算點也順帶改成**送出時刻**而非評估時刻:語意上更正確
 * (使用者看到的是提示出現的那一刻),且防抖期間送達失敗的重推不會
 * 因為「早就記過帳」而被自己的冷卻擋掉。
 *
 * 防抖合併行為與舊版等價:pending 只留一個、turn 優先於 peer_silence 不降級、
 * 每次 push 重置計時器,所以防抖窗內連推多句仍只送出一發。
 */
export function createTurnYieldGate(deps: TurnYieldGateDeps): TurnYieldGate {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as never))

  const state = createTurnYieldState()
  let timer: unknown = null
  let pending: TurnYieldPending | null = null

  function cancel(): void {
    pending = null
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  function push(text: string): void {
    const result = evaluateTurnYield(state, text, now())
    if (!result) return
    // turn 優先於 peer_silence:已有 pending 是 turn 時,長段不覆蓋它(被問倒
    // 比「對方停頓」更值得提示)。
    if (pending?.kind === 'turn' && result.kind === 'peer_silence') return
    pending = {
      kind: result.kind,
      question: result.question,
      at: now(),
      triggerText: result.triggerText
    }
    if (timer !== null) clearTimer(timer)
    const armed = (): void => {
      timer = null
      const p = pending
      if (!p) return
      pending = null
      const sentAt = now()
      // **送達才記冷卻。** 送不出去就當作沒發生過:同一句話可以立刻重推。
      if (!deps.deliver({ kind: p.kind, question: p.question, at: sentAt })) return
      recordTurnYield(
        state,
        { kind: p.kind, question: p.question, triggerText: p.triggerText },
        sentAt
      )
    }
    timer = setTimer(armed, TURN_YIELD_DEBOUNCE_MS)
  }

  function reset(): void {
    cancel()
    resetTurnYieldState(state)
  }

  return {
    push,
    cancel,
    reset,
    get state() {
      return state
    }
  }
}
