/**
 * semanticChunker.ts — 語義短語切塊引擎(自 flowprompt-v3 v15 移植)
 *
 * - 中英雙語連接詞邊界表
 * - 引號/括號內容保護
 * - 短語合併與長句拆分驗證
 * - SLM 增強介面(無 engine 時優雅降級回規則式)
 */

import { PhraseChunkingRules, PhraseVisuals } from './constants'
import { splitIntoSentences } from './sentenceSplitter'

export type PhraseType =
  | 'short'
  | 'normal'
  | 'quoted'
  | 'punctuated'
  | 'connected'
  | 'mixed'
  | 'fragment'
  | 'slm-chunked'

export interface Phrase {
  text: string
  words: string[]
  type: PhraseType
  breakProbability?: number
  emphasis?: string | null
  sentenceIndex?: number
}

export interface SlmChunk {
  text: string
  words?: string[]
  breakProbability?: number
  emphasis?: string | null
}

export interface SlmEngine {
  chunkWithSLM(text: string, opts: { targetSize: number; minWords: number; maxWords: number }): Promise<SlmChunk[]>
}

export const CONNECTORS_ZH = {
  SEQUENTIAL: ['而且', '並且', '同時', '接著', '然後', '於是', '隨後', '接着'],
  CONTRAST: ['但是', '不過', '然而', '可是', '只是', '倒', '但', '卻'],
  CAUSAL: ['所以', '因此', '由於', '因為', '故而', '緣於', '致使', '導致'],
  CONDITIONAL: ['如果', '假如', '若', '除非', '倘若', '要是', '假設'],
  PROGRESSIVE: ['甚至', '更', '進一步', '尤其', '特別', '格外'],
  SUMMARY: ['總之', '綜上所述', '簡言之', '換句話說', '也就是說'],
  TEMPORAL: ['當', '當時', '此時', '那時', '接下來', '最後'],
  ALL: [] as string[]
}

CONNECTORS_ZH.ALL = [
  ...CONNECTORS_ZH.SEQUENTIAL,
  ...CONNECTORS_ZH.CONTRAST,
  ...CONNECTORS_ZH.CAUSAL,
  ...CONNECTORS_ZH.CONDITIONAL,
  ...CONNECTORS_ZH.PROGRESSIVE,
  ...CONNECTORS_ZH.SUMMARY,
  ...CONNECTORS_ZH.TEMPORAL
]

export const CONNECTORS_EN = {
  COORDINATING: ['for', 'and', 'nor', 'but', 'or', 'yet', 'so', 'plus', 'minus'],
  SUBORDINATING: [
    'because', 'since', 'as', 'although', 'though', 'while',
    'if', 'unless', 'until', 'when', 'where', 'whether',
    'before', 'after', 'once', 'provided that', 'in case',
    'even though', 'in order that', 'so that', 'such that'
  ],
  TRANSITIONAL: [
    'however', 'therefore', 'moreover', 'furthermore',
    'nevertheless', 'nonetheless', 'consequently', 'accordingly',
    'meanwhile', 'otherwise', 'instead', 'likewise',
    'similarly', 'conversely', 'specifically', 'particularly'
  ],
  PREPOSITIONAL: [
    'for', 'with', 'about', 'in terms of', 'regarding', 'concerning',
    'despite', 'except', 'besides', 'unlike', 'versus',
    'according to', 'due to', 'owing to', 'thanks to',
    'in addition to', 'with respect to', 'in light of',
    'on behalf of', 'by means of', 'by way of'
  ],
  ALL: [] as string[]
}

CONNECTORS_EN.ALL = [
  ...CONNECTORS_EN.COORDINATING,
  ...CONNECTORS_EN.SUBORDINATING,
  ...CONNECTORS_EN.TRANSITIONAL,
  ...CONNECTORS_EN.PREPOSITIONAL
]

// Intl.Segmenter 全域單例(實例化需 50-100ms,不可在迴圈內重複建立)
const intlSegmenterSingleton = (() => {
  const hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  if (!hasSegmenter) return null
  try {
    return new Intl.Segmenter('zh-Hans', { granularity: 'word' })
  } catch {
    return null
  }
})()

const CJK_RE = /[\u2E80-\u2EFF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F]/

/** 組合短語文字:相鄰皆為 CJK 詞時不加空格,中英混排時保留空格 */
function joinPhraseWords(words: string[]): string {
  let out = ''
  for (let i = 0; i < words.length; i++) {
    if (i > 0) {
      const prevCjk = CJK_RE.test(words[i - 1])
      const curCjk = CJK_RE.test(words[i])
      if (!(prevCjk && curCjk)) out += ' '
    }
    out += words[i]
  }
  return out
}

export class SemanticChunker {
  readonly targetSize: number
  readonly minWords: number
  readonly maxWords: number
  readonly protectQuoted: boolean

  private readonly connectorSetZH: Set<string>
  private readonly connectorSetEN: Set<string>

  constructor(options: { targetSize?: number; minWords?: number; maxWords?: number; protectQuoted?: boolean } = {}) {
    this.targetSize = options.targetSize || 5
    this.minWords = options.minWords || PhraseChunkingRules.MIN_WORDS_PER_PHRASE
    this.maxWords = options.maxWords || PhraseChunkingRules.MAX_WORDS_PER_PHRASE
    this.protectQuoted = options.protectQuoted !== false

    this.connectorSetZH = new Set(CONNECTORS_ZH.ALL)
    this.connectorSetEN = new Set(CONNECTORS_EN.ALL.map((w) => w.toLowerCase()))
  }

  chunk(sentence: unknown, targetSize?: number | null): Phrase[] {
    const size = targetSize || this.targetSize

    if (!sentence || typeof sentence !== 'string') return []

    const trimmed = sentence.trim()
    if (!trimmed) return []

    const words = this.segmentWords(trimmed)
    if (words.length === 0) return []

    if (words.length <= this.minWords) {
      return [{ text: trimmed, words, type: 'short' }]
    }

    return this.chunkWithSemantics(words, size)
  }

  async chunkWithSLM(sentence: unknown, targetSize?: number | null, slmEngine?: SlmEngine | null): Promise<Phrase[]> {
    const size = targetSize || this.targetSize

    if (!sentence || typeof sentence !== 'string') return []

    const trimmed = sentence.trim()
    if (!trimmed) return []

    if (!slmEngine || typeof slmEngine.chunkWithSLM !== 'function') {
      return this.chunk(sentence, size)
    }

    try {
      const slmChunks = await slmEngine.chunkWithSLM(trimmed, {
        targetSize: size,
        minWords: this.minWords,
        maxWords: this.maxWords
      })

      if (slmChunks && Array.isArray(slmChunks) && slmChunks.length > 0) {
        const validated = slmChunks
          .filter((chunk) => chunk && chunk.text && chunk.text.length > 0)
          .map((chunk) => ({
            text: chunk.text,
            words: chunk.words || chunk.text.split(' '),
            type: 'slm-chunked' as PhraseType,
            breakProbability: chunk.breakProbability || 0.5,
            emphasis: chunk.emphasis || null
          }))
          .filter((chunk) => chunk.words.length >= this.minWords - 1)

        if (validated.length > 0) {
          return this.validateChunks(validated)
        }
      }

      return this.chunk(sentence, size)
    } catch {
      return this.chunk(sentence, size)
    }
  }

  segmentWords(text: string): string[] {
    if (intlSegmenterSingleton) {
      try {
        return Array.from(intlSegmenterSingleton.segment(text), (s) => s.segment).filter(
          (w) => w.trim().length > 0
        )
      } catch {
        // fall through to rule-based
      }
    }
    return this.ruleBasedSegment(text)
  }

  private ruleBasedSegment(text: string): string[] {
    const PUNCT_RE = /[,.，。！!？?；;：:—–\-…」』》】\s]+/
    const segments = text.split(PUNCT_RE)
    const result: string[] = []

    for (const seg of segments) {
      if (!seg || seg.trim().length === 0) continue

      if (CJK_RE.test(seg)) {
        let i = 0
        while (i < seg.length) {
          const remaining = seg.length - i
          if (remaining >= 4) {
            result.push(seg.substring(i, i + 4))
            i += 4
          } else if (remaining >= 2) {
            result.push(seg.substring(i, i + 2))
            i += 2
          } else {
            result.push(seg.charAt(i))
            i += 1
          }
        }
      } else {
        const parts = seg.split(/\s+/).filter((w) => w.length > 0)
        result.push(...parts)
        if (parts.length === 0 && seg.length > 0) {
          result.push(seg)
        }
      }
    }

    return result.filter((w) => w.trim().length > 0)
  }

  private chunkWithSemantics(words: string[], targetSize: number): Phrase[] {
    const phrases: Phrase[] = []
    let currentPhraseWords: string[] = []
    let inProtectedBlock = false

    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      const lowerWord = word.toLowerCase()

      if (this.protectQuoted) {
        const protectionState = this.checkProtection(word)

        if (protectionState.entered) {
          inProtectedBlock = true
        }

        if (protectionState.exited) {
          inProtectedBlock = false
        }
      }

      if (inProtectedBlock && currentPhraseWords.length < this.maxWords) {
        currentPhraseWords.push(word)
        continue
      }

      const shouldBreak = this.shouldBreakAt(word, lowerWord, currentPhraseWords.length, targetSize)

      if (shouldBreak && currentPhraseWords.length > 0) {
        phrases.push({
          text: joinPhraseWords(currentPhraseWords),
          words: [...currentPhraseWords],
          type: this.classifyPhrase(currentPhraseWords)
        })
        currentPhraseWords = [word]
      } else {
        currentPhraseWords.push(word)
      }

      if (currentPhraseWords.length >= this.maxWords && i < words.length - 1) {
        phrases.push({
          text: joinPhraseWords(currentPhraseWords),
          words: [...currentPhraseWords],
          type: this.classifyPhrase(currentPhraseWords)
        })
        currentPhraseWords = []
      }
    }

    if (currentPhraseWords.length > 0) {
      phrases.push({
        text: joinPhraseWords(currentPhraseWords),
        words: currentPhraseWords,
        type: this.classifyPhrase(currentPhraseWords)
      })
    }

    return this.validateChunks(this.mergeShortPhrases(phrases))
  }

  private shouldBreakAt(word: string, lowerWord: string, currentLength: number, targetSize: number): boolean {
    if (currentLength >= this.maxWords) return true

    if (currentLength >= this.minWords) {
      if (this.isConnector(lowerWord, word)) {
        return true
      }
    }

    if (PhraseChunkingRules.PUNCTUATION_BREAKS.test(word)) {
      return currentLength >= this.minWords - 1
    }

    if (currentLength >= targetSize && this.isNaturalPause(lowerWord, word)) {
      return true
    }

    return false
  }

  isConnector(lowerWord: string, originalWord: string): boolean {
    return this.connectorSetEN.has(lowerWord) || this.connectorSetZH.has(originalWord)
  }

  isNaturalPause(lowerWord: string, originalWord: string): boolean {
    const pauseIndicators = [
      'also', 'then', 'next', 'now', 'well',
      '接下來', '此外', '另外', '再者', '還有'
    ]

    return pauseIndicators.includes(lowerWord) || pauseIndicators.includes(originalWord)
  }

  checkProtection(word: string): { entered: boolean; exited: boolean; type: string | null } {
    const result = { entered: false, exited: false, type: null as string | null }

    const openQuotes = ['"', '"', '\u201C', '\u201D', '\u300C', '\u300E']
    const closeQuotes = ['"', '"', '\u2018', '\u2019', '\u300D', '\u300F']

    if (openQuotes.includes(word)) {
      result.entered = true
      result.type = 'quote'
    }

    if (closeQuotes.includes(word)) {
      result.exited = true
    }

    if (word === '(' || word === '[' || word === '{') {
      result.entered = true
      result.type = word === '(' ? 'paren' : word === '[' ? 'bracket' : 'brace'
    }

    if (word === ')' || word === ']' || word === '}') {
      result.exited = true
    }

    return result
  }

  classifyPhrase(words: string[]): PhraseType {
    const text = joinPhraseWords(words).toLowerCase()

    if (
      text.startsWith('"') ||
      text.startsWith('"') ||
      text.startsWith('\u300C') ||
      text.startsWith('\u300E')
    ) {
      return 'quoted'
    }

    if (words.some((w) => PhraseChunkingRules.PUNCTUATION_BREAKS.test(w))) {
      return 'punctuated'
    }

    if (this.hasConnector(words)) {
      return 'connected'
    }

    return 'normal'
  }

  private hasConnector(words: string[]): boolean {
    return words.some(
      (w) => this.connectorSetEN.has(w.toLowerCase()) || this.connectorSetZH.has(w)
    )
  }

  mergeShortPhrases(phrases: Phrase[]): Phrase[] {
    if (phrases.length <= 1) return phrases

    const merged: Phrase[] = []
    let buffer: Phrase | null = null

    for (const phrase of phrases) {
      if (buffer === null) {
        buffer = { text: phrase.text, words: [...phrase.words], type: phrase.type }
      } else if (buffer.words.length < this.minWords) {
        buffer = {
          text: joinPhraseWords([...buffer.words, ...phrase.words]),
          words: [...buffer.words, ...phrase.words],
          type: buffer.type === phrase.type ? buffer.type : 'mixed'
        }
      } else {
        merged.push({ text: buffer.text, words: [...buffer.words], type: buffer.type })
        buffer = { text: phrase.text, words: [...phrase.words], type: phrase.type }
      }
    }

    if (buffer !== null) {
      merged.push({ text: buffer.text, words: [...buffer.words], type: buffer.type })
    }

    return merged
  }

  validateChunks(phrases: Phrase[]): Phrase[] {
    const MIN_CHUNK_WORDS = 3
    const MAX_CHUNK_WORDS = 25

    if (phrases.length <= 1) return phrases

    const validated: Phrase[] = []

    for (let i = 0; i < phrases.length; i++) {
      const phrase = phrases[i]
      const wordCount = phrase.words.length

      if (wordCount < MIN_CHUNK_WORDS && i > 0) {
        const prev = validated[validated.length - 1]
        if (prev && prev.words.length < MAX_CHUNK_WORDS - wordCount) {
          validated[validated.length - 1] = {
            text: joinPhraseWords([...prev.words, ...phrase.words]),
            words: [...prev.words, ...phrase.words],
            type: prev.type === phrase.type ? prev.type : 'mixed'
          }
          continue
        }
      }

      if (wordCount > MAX_CHUNK_WORDS) {
        const split = this.splitLongPhrase(phrase, MAX_CHUNK_WORDS)
        validated.push(...split)
        continue
      }

      validated.push(phrase)
    }

    return validated
  }

  private splitLongPhrase(phrase: Phrase, maxWords: number): Phrase[] {
    const words = phrase.words
    const chunks: Phrase[] = []
    let start = 0

    while (start < words.length) {
      const end = Math.min(start + maxWords, words.length)
      const chunkWords = words.slice(start, end)
      chunks.push({
        text: joinPhraseWords(chunkWords),
        words: chunkWords,
        type: chunkWords.length >= this.minWords ? this.classifyPhrase(chunkWords) : 'fragment'
      })
      start = end
    }

    return chunks
  }

  splitIntoSentencesOf(script: unknown): string[] {
    return splitIntoSentences(script)
  }

  processScript(script: string): { sentences: string[]; phrases: Phrase[][]; flatPhrases: Phrase[] } {
    const sentences = splitIntoSentences(script)
    const phrasesPerSentence = sentences.map((s) => this.chunk(s))

    const flatPhrases: Phrase[] = []
    phrasesPerSentence.forEach((phrases, idx) => {
      phrases.forEach((phrase) => {
        flatPhrases.push({ ...phrase, sentenceIndex: idx })
      })
    })

    return { sentences, phrases: phrasesPerSentence, flatPhrases }
  }
}

let defaultInstance: SemanticChunker | null = null

function getDefaultInstance(): SemanticChunker {
  if (!defaultInstance) {
    defaultInstance = new SemanticChunker()
  }
  return defaultInstance
}

export function createSemanticChunker(options?: {
  targetSize?: number
  minWords?: number
  maxWords?: number
  protectQuoted?: boolean
}): SemanticChunker {
  return new SemanticChunker(options)
}

export function chunkSentence(sentence: unknown, targetSize = 5): Phrase[] {
  return getDefaultInstance().chunk(sentence, targetSize)
}

export function chunkSentenceWithSLM(
  sentence: unknown,
  targetSize = 5,
  slmEngine?: SlmEngine | null
): Promise<Phrase[]> {
  return getDefaultInstance().chunkWithSLM(sentence, targetSize, slmEngine)
}

export function processScriptWithSemantic(script: string): {
  sentences: string[]
  phrases: Phrase[][]
  flatPhrases: Phrase[]
} {
  return getDefaultInstance().processScript(script)
}

export async function processScriptWithSemanticSLM(
  script: string,
  slmEngine?: SlmEngine | null
): Promise<{ sentences: string[]; phrases: Phrase[][]; flatPhrases: Phrase[] }> {
  const instance = getDefaultInstance()
  const sentences = instance.splitIntoSentencesOf(script)
  const phrasesPerSentence: Phrase[][] = []

  for (const sentence of sentences) {
    if (slmEngine && typeof slmEngine.chunkWithSLM === 'function') {
      try {
        const chunks = await instance.chunkWithSLM(sentence, null, slmEngine)
        phrasesPerSentence.push(chunks)
      } catch {
        phrasesPerSentence.push(instance.chunk(sentence))
      }
    } else {
      phrasesPerSentence.push(instance.chunk(sentence))
    }
  }

  const flatPhrases: Phrase[] = []
  phrasesPerSentence.forEach((phrases, idx) => {
    phrases.forEach((phrase) => {
      flatPhrases.push({ ...phrase, sentenceIndex: idx })
    })
  })

  return { sentences, phrases: phrasesPerSentence, flatPhrases }
}

/** 計算短語的建議持續時間(毫秒) */
export function calculatePhraseDuration(wordCount: number, wpm: number = PhraseVisuals.DEFAULT_WPM): number {
  const baseDuration = (wordCount / wpm) * 60 * 1000
  return Math.max(PhraseVisuals.MIN_PHRASE_DURATION_MS, baseDuration)
}
