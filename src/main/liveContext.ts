/**
 * liveContext.ts — 最近語音上下文環形緩衝(對應 v3 stt.js 的 recentTranscripts)
 *
 * 任何轉錄來源(語音跟讀、會議轉錄)經 IPC 推入;panic 觸發時取
 * 最近時間窗內的最後 10 段作為 AI 上下文。
 */

const RING_SOFT_LIMIT = 500
const RING_TRIM_TO = 200
const CONTEXT_WINDOW_MS = 120_000
const CONTEXT_MAX_SEGMENTS = 10

interface ContextSegment {
  text: string
  speaker: 'me' | 'them' | 'unknown'
  t: number
}

let segments: ContextSegment[] = []

export function pushTranscript(text: string, speaker: 'me' | 'them' | 'unknown' = 'unknown', now = Date.now()): void {
  const cleaned = text.trim()
  if (!cleaned) return
  segments.push({ text: cleaned, speaker, t: now })
  if (segments.length > RING_SOFT_LIMIT) {
    segments = segments.slice(-RING_TRIM_TO)
  }
}

/** 對方(t)的話優先——panic 通常在回應對方的問題 */
export function getRecentContext(now = Date.now()): string {
  const windowed = segments.filter((s) => now - s.t <= CONTEXT_WINDOW_MS)
  const pool = windowed.length > 0 ? windowed : segments.slice(-CONTEXT_MAX_SEGMENTS)
  const them = pool.filter((s) => s.speaker === 'them')
  const me = pool.filter((s) => s.speaker !== 'them')
  const picked = [...them.slice(-6), ...me.slice(-4)]
  if (picked.length === 0) return '(no recent speech detected — user likely silent or mic muted)'
  return picked.map((s) => s.text).join(' ')
}

export function clearContext(): void {
  segments = []
}

export function contextSize(): number {
  return segments.length
}
