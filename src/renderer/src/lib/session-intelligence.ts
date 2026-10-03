/**
 * session-intelligence.ts — 會話量化分析(以 flowprompt-v3 session-intelligence 為藍本重寫)
 *
 * v3 用 1s 取樣 timeline;本專案的轉錄資料本身帶時間戳(TranscriptSegment),
 * 直接從段落計算,精度更高且無需取樣。
 *
 * 語音量測單位:中日韓字元各記 1,拉丁文每個詞記 1(中英混稿通用)。
 * 語速基準沿用專案校準模組的 charsPerMin 語意(合理範圍約 100–480)。
 */

import type { SessionReport, SessionSuggestion, TranscriptSegment } from '@shared/types'

export type { SessionReport, SessionSuggestion } from '@shared/types'

// ── 練習分析型別 ──

export interface PracticeAnswerAnalysis {
  index: number
  units: number
  durationSec: number
  cpm: number
}

export interface PracticeRunAnalysis {
  perAnswer: PracticeAnswerAnalysis[]
  avgCpm: number
  /** 各題分數趨勢(無反饋的題目不計) */
  scores: number[]
}

// ── 常數 ──

// 只計「表意文字本體」:漢字、假名、諺文;排除 CJK 部首符號(2E80-)與標點符號區(3000-303F)
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/g
const GAP_THRESHOLD_SEC = 5
const LONG_TURN_SEC = 120
/**
 * 沒有個人校準值時的絕對門檻(字/分)。
 *
 * 刻意保持這兩個常數:它們是「沒有校準資料」時的保守預設,不是使用者該被量出的標準。
 */
const CPM_FAST = 320
const CPM_SLOW = 120
/**
 * 有個人校準值時的相對門檻係數。
 *
 * 1.3 是從 main/context-engine/coachingRules.ts 的即時「語速偏快」規則**沿用**的同一個係數,
 * 為的是讓會後報告與會議中浮出的提示講同一件事:同一場會議裡,一邊說不偏、一邊說偏快,
 * 使用者只會覺得這個 App 的數字不可信。
 */
const CPM_FAST_FACTOR = 1.3
const CPM_SLOW_FACTOR = 0.75
/**
 * 沒有校準值時,建議的「舒服目標」。
 *
 * 與觸發門檻(CPM_FAST)分開:門檻是「算快」,目標是「回到舒服的速率」。
 * 兩者混用會出現「已經算偏快,卻叫你壓到同樣快的數字」這種自相矛盾。
 */
const CPM_TARGET = 260
const MAX_SUGGESTIONS = 3

// ── 基礎計算 ──

/** 語音單位數:CJK 字元各 1 + 拉丁詞各 1 */
export function countSpeechUnits(text: string): number {
  if (!text) return 0
  const cjk = (text.match(CJK_RE) ?? []).length
  const latinWords = text
    .replace(CJK_RE, ' ')
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w)).length
  return cjk + latinWords
}

/** 由文字與時長算語速(字/分);時長過短回 0 */
export function cpmForText(text: string, durationSec: number): number {
  if (durationSec < 1) return 0
  const units = countSpeechUnits(text)
  if (units === 0) return 0
  return Math.round((units / durationSec) * 60)
}

function cv(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

function isQuestion(text: string): boolean {
  const t = text.trim()
  return /[?？]\s*$/.test(t) || /(為什麼|什麼|如何|怎麼|哪些|多少|是否|能不能|可不可以|why|how|what|which|when|where|do you|are you|can you)/i.test(t)
}

interface Turn {
  speaker: 'me' | 'them'
  start: number
  end: number
  /** 只累計逐字稿片段覆蓋的語音時間，不把同說者段落間的靜音算成發言 */
  speechSec: number
  /** 同一輪內已覆蓋的最晚片段時間，避免重疊片段重複計時 */
  coveredUntil: number
  text: string
}

/** 相同說者且間隔不超過冷場門檻的段落合併為一輪；長停頓保留為可量測的冷場 */
export function sortTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((a, b) => a.start - b.start || a.end - b.end)
}

function toTurns(segments: TranscriptSegment[]): Turn[] {
  const sorted = sortTranscriptSegments(segments)
  const turns: Turn[] = []
  for (const seg of sorted) {
    const start = Math.min(seg.start, seg.end)
    const end = Math.max(seg.start, seg.end)
    const last = turns[turns.length - 1]
    const gap = last ? start - last.end : Number.POSITIVE_INFINITY
    const intervalSec = Math.max(0, end - start)
    const activeSpeechSec = Math.min(intervalSec, Math.max(0, seg.speechDurationSec ?? intervalSec))
    if (last && last.speaker === seg.speaker && gap <= GAP_THRESHOLD_SEC) {
      const uniqueIntervalSec = Math.max(0, end - Math.max(start, last.coveredUntil))
      // Keep VAD-measured voiced duration (excluding silence), while avoiding double-counting
      // the portion of overlapping same-speaker audio already covered by the previous segment.
      last.speechSec += intervalSec > 0 ? (activeSpeechSec * uniqueIntervalSec) / intervalSec : 0
      last.end = Math.max(last.end, end)
      last.text += ` ${seg.text}`
      last.coveredUntil = Math.max(last.coveredUntil, end)
    } else {
      turns.push({
        speaker: seg.speaker,
        start,
        end,
        speechSec: activeSpeechSec,
        coveredUntil: end,
        text: seg.text
      })
    }
  }
  return turns
}

// ── 會議報告 ──

export function buildSessionReport(
  segments: TranscriptSegment[],
  opts: {
    durationSec?: number
    speakerAvailability?: { me: boolean; them: boolean }
    /**
     * 使用者的個人語速基準(字/分)。有值時,「偏快/偏慢」改用它當基準 ——
     * 花了一整頁校準出來的數字,報告卻不採用,那是承諾與行為不一致。
     */
    personalCpm?: number | null
  } = {}
): SessionReport {
  const turns = toTurns(segments ?? [])
  const now = Date.now()

  if (turns.length === 0) {
    return {
      durationSec: opts.durationSec ?? 0,
      mySec: 0,
      theirSec: 0,
      talkRatio: 0,
      talkRatioAvailable: opts.speakerAvailability ? opts.speakerAvailability.me && opts.speakerAvailability.them : true,
      myUnits: 0,
      myCpm: 0,
      turnCount: 0,
      avgMyTurnSec: 0,
      longestMyTurnSec: 0,
      gapCount: 0,
      gapTotalSec: 0,
      theirQuestionCount: 0,
      steadiness: 100,suggestions: [],
      generatedAt: now
    }
  }

  const durationSec = opts.durationSec ?? Math.max(...turns.map((t) => t.end))

  const myTurns = turns.filter((t) => t.speaker === 'me')
  const theirTurns = turns.filter((t) => t.speaker === 'them')
  const mySec = myTurns.reduce((a, t) => a + t.speechSec, 0)
  const theirSec = theirTurns.reduce((a, t) => a + t.speechSec, 0)
  const talkRatio = mySec + theirSec > 0 ? mySec / (mySec + theirSec) : 0
  // A single audio source cannot establish who spoke for what share of a conversation.
  // Legacy callers/data without availability metadata retain the original behavior.
  const talkRatioAvailable = opts.speakerAvailability
    ? opts.speakerAvailability.me && opts.speakerAvailability.them
    : true

  const myUnits = myTurns.reduce((a, t) => a + countSpeechUnits(t.text), 0)
  const myCpm = mySec >= 1 ? Math.round((myUnits / mySec) * 60) : 0

  // 冷場:相鄰輪次之間的間隙
  let gapCount = 0
  let gapTotalSec = 0
  for (let i = 1; i < turns.length; i++) {
    const gap = turns[i].start - turns[i - 1].end
    if (gap > GAP_THRESHOLD_SEC) {
      gapCount++
      gapTotalSec += gap
    }
  }

  const myTurnCpms = myTurns
    .filter((t) => t.speechSec >= 2)
    .map((t) => countSpeechUnits(t.text) / (t.speechSec / 60))
    .filter((v) => v > 0)
  const steadiness = myTurnCpms.length < 2 ? 100 : Math.round(100 * Math.max(0, 1 - cv(myTurnCpms)))

  const report: SessionReport = {
    durationSec: Math.round(durationSec),
    mySec: Math.round(mySec),
    theirSec: Math.round(theirSec),
    talkRatio,
    talkRatioAvailable,
    myUnits,
    myCpm,
    turnCount: turns.length,
    avgMyTurnSec: myTurns.length ? Math.round(mySec / myTurns.length) : 0,
    longestMyTurnSec: myTurns.length ? Math.round(Math.max(...myTurns.map((t) => t.speechSec))) : 0,
    gapCount,
    gapTotalSec: Math.round(gapTotalSec),
    theirQuestionCount: theirTurns.filter((t) => isQuestion(t.text)).length,
    steadiness,
    suggestions: [],
    generatedAt: now
  }

  report.suggestions = buildSuggestions(report, { personalCpm: opts.personalCpm })
  return report
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const

/**
 * 建議的產生。
 *
 * 語速那兩條的基準:有個人校準值就用它(相對門檻),沒有才退回絕對門檻 —
 * 這個取捨的理由見 CPM_FAST_FACTOR 的註解。訊息裡會把用到的基準寫出來,
 * 因為「340 字/分算不算快」只有相對於某個人的常態才有意義。
 */
export function buildSuggestions(
  r: SessionReport,
  opts: { personalCpm?: number | null } = {}
): SessionSuggestion[] {
  const out: SessionSuggestion[] = []
  const pct = Math.round(r.talkRatio * 100)
  const personal =
    opts.personalCpm != null && Number.isFinite(opts.personalCpm) && opts.personalCpm > 0
      ? Math.round(opts.personalCpm)
      : null
  const fastAt = personal != null ? personal * CPM_FAST_FACTOR : CPM_FAST
  const slowAt = personal != null ? personal * CPM_SLOW_FACTOR : CPM_SLOW
  // 目標是「回到自己的常態」,不是「壓到觸發門檻」—— 有基準就用基準,沒有才用絕對值。
  const targetAt = personal != null ? personal : CPM_TARGET
  const baselineNote = personal != null ? `,你的基準 ${personal} 字/分` : ''

  if (r.talkRatioAvailable !== false && r.theirSec > 10 && r.talkRatio > 0.75) {
    out.push({ severity: 'high', message: `你說了 ${pct}% 的時間——試著把發言壓到六成以下,多留空間給對方` })
  }
  if (r.talkRatioAvailable !== false && r.theirSec > 10 && r.talkRatio < 0.25) {
    out.push({ severity: 'low', message: `你只說了 ${pct}% 的時間,對方可能需要更多你的觀點` })
  }
  if (r.longestMyTurnSec > LONG_TURN_SEC) {
    out.push({ severity: 'medium', message: `最長連續發言 ${r.longestMyTurnSec} 秒,長獨白容易失焦,試著拆段確認對方跟上` })
  }
  if (r.gapCount >= 3) {
    out.push({ severity: 'low', message: `有 ${r.gapCount} 次超過 5 秒的冷場(共 ${r.gapTotalSec} 秒),可準備幾個承接話題` })
  }
  if (r.myCpm > fastAt) {
    out.push({
      severity: 'medium',
      message: `語速偏快(${r.myCpm} 字/分${baselineNote}),建議控制在 ${targetAt} 字/分以下讓人跟得上`
    })
  } else if (r.myCpm > 0 && r.myCpm < slowAt) {
    out.push({
      severity: 'low',
      message: `語速偏慢(${r.myCpm} 字/分${baselineNote}),重點句可加快節奏`
    })
  }
  if (r.talkRatioAvailable !== false && r.theirQuestionCount >= 3 && r.talkRatio < 0.5) {
    out.push({ severity: 'medium', message: `對方問了 ${r.theirQuestionCount} 個問題,確認每題都有正面回應` })
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]).slice(0, MAX_SUGGESTIONS)
}

// ── 面試練習分析 ──

export function analyzePracticeRun(
  answers: Array<{ answerTranscript: string; durationSec: number; feedback?: { score?: number } }>
): PracticeRunAnalysis {
  const perAnswer: PracticeAnswerAnalysis[] = []
  const scores: number[] = []

  answers.forEach((a, i) => {
    const units = countSpeechUnits(a.answerTranscript ?? '')
    const dur = a.durationSec ?? 0
    if (dur >= 3 && units > 0) {
      perAnswer.push({ index: i, units, durationSec: Math.round(dur), cpm: cpmForText(a.answerTranscript ?? '', dur) })
    }
    const score = a.feedback?.score
    if (typeof score === 'number' && Number.isFinite(score)) {
      scores.push(score)
    }
  })

  const avgCpm =
    perAnswer.length > 0 ? Math.round(perAnswer.reduce((a, b) => a + b.cpm, 0) / perAnswer.length) : 0

  return { perAnswer, avgCpm, scores }
}
