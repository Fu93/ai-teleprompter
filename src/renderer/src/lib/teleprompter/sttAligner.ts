/**
 * sttAligner.ts — 語音轉錄文字與稿件的模糊對齊(自 flowprompt-v3 移植)
 *
 * 使用 Levenshtein 距離計算相似度,找到最匹配的段落位置。
 * Phase B 接上 STT 後用於「轉錄跟隨捲動」。
 */

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  const maxLen = Math.max(a.length, b.length)
  const distance = levenshteinDistance(a, b)
  return 1 - distance / maxLen
}

/** 標準化文字(去除標點、空白、轉小寫) */
function normalize(text: string): string {
  return text
    .toLowerCase()
    // 這個 regex 裡有全形空白與標點,但那不需要靠 disable 過關:
    // no-irregular-whitespace 管的是「原始碼裡的空白字元」,不是 regex 字面值。
    .replace(/[\uFF0C\u3002\uFF01\uFF1F\u3001\uFF1B\uFF1A\u201C\u201D\u2018\u2019\u3010\u3011\u300A\u300B\s.,!?;:'"()[\]{}]/g, '')
    .trim()
}

const MATCH_THRESHOLD = 0.6
const SEARCH_RANGE = 5

/**
 * 找到最佳匹配的段落索引。
 * @param transcript STT 轉錄文字
 * @param sentences 稿件句子陣列
 * @param currentIndex 當前段落索引(優先匹配附近段落,避免跳躍)
 */
export function findBestMatch(transcript: unknown, sentences: unknown, currentIndex = 0): number {
  if (!transcript || !sentences || !Array.isArray(sentences) || sentences.length === 0) {
    return currentIndex
  }

  if (typeof transcript !== 'string') return currentIndex

  const normalizedTranscript = normalize(transcript)
  if (normalizedTranscript.length < 3) {
    return currentIndex
  }

  let bestIndex = currentIndex
  let bestScore = 0

  const startIdx = Math.max(0, currentIndex - SEARCH_RANGE)
  const endIdx = Math.min(sentences.length - 1, currentIndex + SEARCH_RANGE)

  for (let i = startIdx; i <= endIdx; i++) {
    const raw = sentences[i]
    if (typeof raw !== 'string') continue
    const sentence = normalize(raw)
    if (sentence.length === 0) continue

    const score = similarity(normalizedTranscript, sentence)
    const distanceBonus = 1 / (1 + Math.abs(i - currentIndex) * 0.1)
    const adjustedScore = score * distanceBonus

    if (adjustedScore > bestScore) {
      bestScore = adjustedScore
      bestIndex = i
    }
  }

  if (bestScore >= MATCH_THRESHOLD) {
    return bestIndex
  }

  return currentIndex
}
