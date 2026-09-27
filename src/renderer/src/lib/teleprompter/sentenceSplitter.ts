/**
 * sentenceSplitter.ts — 語義斷句純函數(自 flowprompt-v3 移植)
 *
 * - 以換行切分後逐 segment 斷句
 * - 英文縮寫(Mr. / Dr. / U.S.A. / J.)與單字母大寫縮寫不誤判為句末
 * - 千分位 / 小數點由 token 化保留
 */

const SENTENCE_SPLIT_REGEX = /(\s+|[.!?。！？\n]+)/g

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt',
  'vs', 'etc', 'no', 'vol', 'inc', 'ltd', 'co', 'cf',
  'eg', 'ie', 'usa', 'uk', 'un', 'p', 'pp', 'ch', 'fig'
])

function isAbbrev(word: string): boolean {
  if (!word) return false
  return ABBREVIATIONS.has(word.toLowerCase().replace(/\.$/, ''))
}

function splitSegmentWithAbbreviations(segment: string): string[] {
  const sentences: string[] = []
  let buf = ''

  const tokens = segment.split(SENTENCE_SPLIT_REGEX)

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === undefined || tok === '') continue

    buf += tok

    if (!/[.!?。！？]/.test(tok)) continue

    const next = tokens[i + 1]
    const lastWordMatch = buf.match(/(\S+)$/)
    const lastWord = lastWordMatch ? lastWordMatch[1] : ''
    const isAbrev = isAbbrev(lastWord)
    const isInitial = /^[A-Z]\.$/.test(lastWord)

    let isBoundary = false
    if (next === undefined || next === '') {
      isBoundary = true
    } else if (/^\s+$/.test(next)) {
      const wordAfter = tokens[i + 2]
      if (wordAfter && /^[A-Z\u4E00-\u9FFF]/.test(wordAfter)) {
        isBoundary = true
      }
    }

    if (isBoundary && !isAbrev && !isInitial) {
      sentences.push(buf.trim())
      buf = ''
    }
  }

  if (buf.trim()) sentences.push(buf.trim())
  return sentences
}

/**
 * 將講稿切為句子;換行視為句界,英文縮寫與單字母縮寫不切。
 */
export function splitIntoSentences(script: unknown): string[] {
  if (!script || typeof script !== 'string') return []

  const trimmed = script.trim()
  if (!trimmed) return []

  const lines = trimmed
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  const result: string[] = []
  for (const segment of lines) {
    result.push(...splitSegmentWithAbbreviations(segment))
  }
  return result
}
