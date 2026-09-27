/**
 * panicAi.ts — Panic 救援的 prompt 組裝與回應解析(自 flowprompt-v3 ai.js 移植,純函數)
 *
 * 3 段式解析:直接 JSON.parse → 抽出混合文字中的 JSON 物件 → 純 regex 抽取。
 * 全部失敗時使用場景 fallback 模板,confidence 0.15。
 */

export type PanicMode = 'interview' | 'meeting'

export interface RescuePayload {
  sentence: string
  points: string
  confidence: number
  source: 'ai' | 'template'
  scene?: string
  mode?: PanicMode
}

const FALLBACKS: Record<PanicMode, { sentence: string; points: string }> = {
  interview: {
    sentence: 'That is a great question — let me address it directly.',
    points: 'Show experience / Quantify impact'
  },
  meeting: {
    sentence: 'Let me think about how to put this clearly.',
    points: 'Core idea / Supporting detail'
  }
}

const SCENE_SENTENCE: Record<PanicMode, string> = {
  interview: 'You are helping someone during a live job interview who just got stumped by a question.',
  meeting:
    'You are helping someone during a live meeting or presentation who got interrupted or lost their train of thought.'
}

const OUTPUT_SPEC: Record<PanicMode, string> = {
  interview: 'a confident 1-sentence answer to the question, plus 2 short supporting points the candidate can mention',
  meeting: 'a graceful bridge sentence to recover and continue, plus 2 short talking points'
}

/** v3 buildPanicPrompt 全文對應 */
export function buildPanicPrompt(mode: PanicMode, context: string): string {
  return `${SCENE_SENTENCE[mode]}

Recent conversation (last 30s):
"""
${context.slice(0, 600)}
"""

Generate ${OUTPUT_SPEC[mode]}.

Respond ONLY with a JSON object using this exact schema:
{"sentence": "<one complete ready-to-say sentence, ≤ 18 words>", "points": "<point 1, ≤ 8 words> / <point 2, ≤ 8 words>", "confidence": <float 0.0-1.0>}

Rules:
- sentence must be immediately speakable, no "I think" or filler
- points are short phrases the user can glance at, NOT full sentences
- confidence reflects how certain you are the sentence fits the context (0.0 = guessing, 1.0 = perfect fit)
- if context is too short to understand the topic, return {"sentence": "Let me think about that for a moment.", "points": "Take a breath / Buy time", "confidence": 0.2}`
}

export interface ParsedRescue {
  sentence: string
  points: string
  confidence: number | null
}

/**
 * 3 段式解析:
 * 1. 直接 JSON.parse
 * 2. 抽出「含 sentence 與 points 的第一個 JSON 物件」再 parse
 * 3. 分別 regex 抽 sentence / points
 */
export function parseRescueResponse(raw: string): ParsedRescue | null {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null

  // 1. 直接解析
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof obj['sentence'] === 'string' && typeof obj['points'] === 'string') {
      return {
        sentence: obj['sentence'],
        points: obj['points'],
        confidence: typeof obj['confidence'] === 'number' ? obj['confidence'] : null
      }
    }
  } catch {
    // fall through
  }

  // 2. 從混合文字抽出 JSON 物件
  const jsonMatch = trimmed.match(/\{[^{}]*"sentence"[^{}]*"points"[^{}]*\}/s)
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>
      if (typeof obj['sentence'] === 'string' && typeof obj['points'] === 'string') {
        return {
          sentence: obj['sentence'],
          points: obj['points'],
          confidence: typeof obj['confidence'] === 'number' ? obj['confidence'] : null
        }
      }
    } catch {
      // fall through
    }
  }

  // 3. 純 regex 抽取
  const sentenceMatch = trimmed.match(/"sentence"\s*:\s*"([^"]+)"/)
  const pointsMatch = trimmed.match(/"points"\s*:\s*"([^"]+)"/)
  if (sentenceMatch && pointsMatch) {
    const confMatch = trimmed.match(/"confidence"\s*:\s*([\d.]+)/)
    return {
      sentence: sentenceMatch[1],
      points: pointsMatch[1],
      confidence: confMatch ? Number(confMatch[1]) : null
    }
  }

  return null
}

const NO_CONTEXT_PREFIX = '(no recent speech'

/** v3 computeConfidence:模型信心 > 內容啟發式 */
export function computeConfidence(
  modelConfidence: number | null,
  context: string,
  sentence: string,
  points: string
): number {
  if (modelConfidence !== null && Number.isFinite(modelConfidence)) {
    return Math.min(1, Math.max(0, modelConfidence))
  }

  let confidence = 0.6
  if (!context || context.startsWith(NO_CONTEXT_PREFIX)) confidence -= 0.4
  if (sentence && points) confidence += 0.2
  const words = sentence.trim().split(/\s+/).length
  if (words >= 1 && words <= 18) confidence += 0.1
  return Math.min(1, Math.max(0, confidence))
}

/** AI 失敗時的結構化 fallback(與模板並存:模板來自場景,此為無場景底的固定救援) */
export function structuredFallback(mode: PanicMode): RescuePayload {
  const fb = FALLBACKS[mode]
  return { sentence: fb.sentence, points: fb.points, confidence: 0.15, source: 'template' }
}
