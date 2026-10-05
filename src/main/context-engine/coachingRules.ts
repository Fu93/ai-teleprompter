/**
 * coachingRules.ts — 即時教練規則引擎(移植 v3 coachingRules 的精神,
 * 改為 main 端 transcript 到達流純函數版)
 *
 * 訊號(全部以「我方」為教練對象):
 * - fast       語速過快:最近 60s 我方語音單位/分超出基準 × 1.3(未校準用 300)
 * - filler     填充詞偏多:最近 30s 我方 嗯/呃/那個/就是/um… ≥ 4 次
 * - interrupt  搶話:對方段落送達後 2s 內我方就開口(對方可能還沒說完)
 * - dead_air   冷場:全場 8s 無任何語音
 * - monologue  獨白過長:我方連續講 > 75s 且量足(該讓對方說話了)
 *
 * 時間域:arrival 時間戳(ms epoch,= 分段器送出時刻 ≈ 該段結尾)。
 * 我方「發言時長」以相鄰兩段送達間隔扣除靜音/處理餘量估算——保守設計。
 * 估計器本體與瞬時節奏讀數共用(見 speakingPace.ts 的 estimateCpm 與
 * 它檔頭寫的已知限制)。
 */
import { CONTINUATION_GAP_MS, DEFAULT_CPM, estimateCpm } from './speakingPace'

/** 未校準時的語速基準(單一出處在 speakingPace;為了既有 import 點保留 re-export) */
export { DEFAULT_CPM }

/** 語音單位:CJK 字元各 1 + 拉丁詞各 1(與 session-intelligence 同口徑) */
export function speechUnits(text: string): number {
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0
  const latin = text.match(/[A-Za-z]+/g)?.length ?? 0
  return cjk + latin
}

/** 填充詞偵測(繁中口語 + 英文常見)——詞邊界比對,避免「就是說」整詞誤判 */
const FILLER_PATTERNS: RegExp[] = [
  /嗯/g,
  /呃/g,
  /誒/g,
  /那個/g,
  /這個/g,
  /就是說/g,
  /然後然後/g,
  /\bum+\b/gi,
  /\buh+\b/gi,
  /\blike\b/gi,
  /\byou know\b/gi
]

export function countFillers(text: string): number {
  let n = 0
  for (const p of FILLER_PATTERNS) {
    n += text.match(p)?.length ?? 0
  }
  return n
}

export type CoachingKind = 'fast' | 'filler' | 'interrupt' | 'dead_air' | 'monologue'

export interface CoachingSignal {
  kind: CoachingKind
  /** 給使用者的提示文案(繁中) */
  message: string
  /** 觸發時的量化資料(除錯/未來顯示用) */
  detail: Record<string, number | string>
}

export interface CoachingState {
  /** 我方段落 [t, units, fillerCount] */
  me: Array<{ t: number; units: number; fillers: number }>
  /** 對方段落時間戳 */
  them: Array<{ t: number; chars: number }>
  /** 目前我方連續發言起點;0 = 非連續 */
  monologueStart: number
  /** 上一次觸發 per-kind 時間戳 */
  lastFired: Record<CoachingKind, number>
}

export function createCoachingState(): CoachingState {
  return {
    me: [],
    them: [],
    monologueStart: 0,
    lastFired: { fast: 0, filler: 0, interrupt: 0, dead_air: 0, monologue: 0 }
  }
}

export interface CoachingOptions {
  /** 個人語速基準(字/分);0 = 未校準,用 DEFAULT_CPM */
  baselineCpm: number
  /** 各訊號冷卻(ms),避免洗版 */
  cooldownMs?: Partial<Record<CoachingKind, number>>
  /** 冷場判定門檻(ms) */
  deadAirMs?: number
  /** 獨白判定門檻(ms) */
  monologueMs?: number
}

export const COACHING_DEFAULTS = {
  deadAirMs: 8_000,
  monologueMs: 75_000
} as const

/** 各訊號預設冷卻(ms) */
export const DEFAULT_COOLDOWNS: Record<CoachingKind, number> = {
  fast: 120_000,
  filler: 120_000,
  interrupt: 180_000,
  dead_air: 300_000,
  monologue: 300_000
}

const CPM_WINDOW_MS = 60_000
const FILLER_WINDOW_MS = 30_000
/** 搶話:對方段送達後多久內我方開口算搶 */
const INTERRUPT_WINDOW_MS = 2_000

/** 冷卻檢查 */
function cooled(state: CoachingState, kind: CoachingKind, now: number, cooldownMs: number): boolean {
  return now - state.lastFired[kind] >= cooldownMs
}

function markFired(state: CoachingState, kind: CoachingKind, now: number): void {
  state.lastFired[kind] = now
}

/** 我方新段落到達:更新統計並評估 fast / filler / monologue */
export function onMeSegment(
  state: CoachingState,
  text: string,
  now: number,
  opts: CoachingOptions
): CoachingSignal | null {
  const units = speechUnits(text)
  const fillers = countFillers(text)
  const cooldowns: Record<CoachingKind, number> = { ...DEFAULT_COOLDOWNS, ...opts.cooldownMs }

  // monologue 連續性:與上段間隔小於 CONTINUATION_GAP_MS 視為同一次發言
  const last = state.me[state.me.length - 1]
  if (last && now - last.t <= CONTINUATION_GAP_MS && state.monologueStart > 0) {
    // 連續中,不動 monologueStart
  } else {
    state.monologueStart = now
  }

  state.me.push({ t: now, units, fillers })
  // 統計窗只留 90s
  while (state.me.length > 0 && now - state.me[0].t > 90_000) state.me.shift()

  // ---- monologue:連續發言超過門檻 ----
  const monologueMs = opts.monologueMs ?? COACHING_DEFAULTS.monologueMs
  const monologueSec = state.monologueStart > 0 ? (now - state.monologueStart) / 1000 : 0
  if (
    state.monologueStart > 0 &&
    monologueSec * 1000 >= monologueMs &&
    units >= 4 &&
    cooled(state, 'monologue', now, cooldowns.monologue)
  ) {
    markFired(state, 'monologue', now)
    state.monologueStart = 0 // 觸發後重新計數,避免每次到達都觸發
    return {
      kind: 'monologue',
      message: '你連續講很久了 — 停一下,把話語權交給對方',
      detail: { monologueSec: Math.round(monologueSec) }
    }
  }

  // ---- filler:近 30s 填充詞次數(嚴格小於:「30s 前」的舊樣本必須出窗)----
  const recentFiller = state.me.filter((m) => now - m.t < FILLER_WINDOW_MS)
  const fillerCount = recentFiller.reduce((a, b) => a + b.fillers, 0)
  if (fillerCount >= 4 && cooled(state, 'filler', now, cooldowns.filler)) {
    markFired(state, 'filler', now)
    return {
      kind: 'filler',
      message: '填充詞有點多 — 放慢,想好再說',
      detail: { fillers: fillerCount, windowSec: FILLER_WINDOW_MS / 1000 }
    }
  }

  // ---- fast:近 60s 語速(估計器與瞬時讀數共用,見 speakingPace.ts)----
  // 舊版把「兩段、間隔 4s」算成 20 單位 ÷ 1.5s = 800 字/分,對一個實際
  // 約 150 字/分的慢速講者報「語速偏快」。低下限(3s 發聲時間、6 單位)
  // 是那個假陽性的修正處,而它同時是瞬時讀數的入場條件。
  const cpm = estimateCpm(state.me, now, CPM_WINDOW_MS)
  if (cpm !== null) {
    const baseline = opts.baselineCpm > 0 ? opts.baselineCpm : DEFAULT_CPM
    if (cpm > baseline * 1.3 && cooled(state, 'fast', now, cooldowns.fast)) {
      markFired(state, 'fast', now)
      return {
        kind: 'fast',
        message: `語速偏快(${Math.round(cpm)} 字/分)— 深呼吸,慢下來`,
        detail: { cpm: Math.round(cpm), baseline }
      }
    }
  }

  return null
}

/** 對方新段落到達:更新統計,並判定剛才的 dead_air 是否值得報 */
export function onThemSegment(state: CoachingState, text: string, now: number, opts: CoachingOptions): void {
  state.them.push({ t: now, chars: text.length })
  while (state.them.length > 0 && now - state.them[0].t > 90_000) state.them.shift()
  // 對方開口 = 獨白結束
  state.monologueStart = 0
  void opts
}

/** 會話邊界重置(新場次開始時呼叫):清統計窗、獨白計時與所有冷卻 */
export function resetCoachingState(state: CoachingState): void {
  state.me.length = 0
  state.them.length = 0
  state.monologueStart = 0
  for (const k of Object.keys(state.lastFired) as CoachingKind[]) {
    state.lastFired[k] = 0
  }
}

/** 搶話判定:對方段送達後 INTERRUPT_WINDOW_MS 內我方就開口 */
export function checkInterrupt(state: CoachingState, now: number, opts: CoachingOptions): CoachingSignal | null {
  const cooldowns: Record<CoachingKind, number> = { ...DEFAULT_COOLDOWNS, ...opts.cooldownMs }
  const lastThem = state.them[state.them.length - 1]
  if (!lastThem) return null
  const sinceThem = now - lastThem.t
  if (sinceThem <= INTERRUPT_WINDOW_MS && cooled(state, 'interrupt', now, cooldowns.interrupt)) {
    // 對方段夠短(剛開始講)或我方段極短(插半句)都算——保守:只看時間
    markFired(state, 'interrupt', now)
    return {
      kind: 'interrupt',
      message: '剛打斷對方 — 讓對方把話說完',
      detail: { sinceThemMs: sinceThem }
    }
  }
  return null
}

/** 冷場判定(由 main 的週期 timer 呼叫):全場 deadAirMs 無任何語音 */
export function checkDeadAir(
  state: CoachingState,
  now: number,
  opts: CoachingOptions
): CoachingSignal | null {
  const cooldowns: Record<CoachingKind, number> = { ...DEFAULT_COOLDOWNS, ...opts.cooldownMs }
  const deadAirMs = opts.deadAirMs ?? COACHING_DEFAULTS.deadAirMs
  const lastMe = state.me[state.me.length - 1]
  const lastThem = state.them[state.them.length - 1]
  const lastAny = Math.max(lastMe?.t ?? 0, lastThem?.t ?? 0)
  // 開場(尚無任何語音)不報冷場
  if (lastAny === 0) return null
  if (now - lastAny >= deadAirMs && cooled(state, 'dead_air', now, cooldowns.dead_air)) {
    markFired(state, 'dead_air', now)
    return {
      kind: 'dead_air',
      message: '冷場中 — 問個問題,或確認一下剛才的重點',
      detail: { silenceSec: Math.round((now - lastAny) / 1000) }
    }
  }
  return null
}
