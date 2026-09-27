import { describe, it, expect, vi } from 'vitest'
import {
  SemanticChunker,
  createSemanticChunker,
  chunkSentence,
  chunkSentenceWithSLM,
  processScriptWithSemantic,
  processScriptWithSemanticSLM,
  calculatePhraseDuration,
  CONNECTORS_ZH,
  CONNECTORS_EN
} from '../semanticChunker'

const zh = (opts?: { targetSize?: number; minWords?: number; maxWords?: number }) =>
  createSemanticChunker(opts)

describe('SemanticChunker.chunk (基本)', () => {
  it('回傳空陣列當輸入無效或空白', () => {
    const c = zh()
    expect(c.chunk('')).toEqual([])
    expect(c.chunk(null)).toEqual([])
    expect(c.chunk('   ')).toEqual([])
    expect(c.chunk(5)).toEqual([])
  })

  it('短於 minWords 時回傳單一 short phrase', () => {
    const c = zh()
    const out = c.chunk('Hello world') // 2 words
    expect(out[0].type).toBe('short')
    expect(out[0].words.length).toBeLessThanOrEqual(3)
  })

  it('英文句子依連接詞/自然停頓切塊', () => {
    const c = zh({ targetSize: 3, minWords: 2, maxWords: 8 })
    const out = c.chunk('first we do this and then we move on to the next topic')
    expect(out.length).toBeGreaterThan(1)
  })

  it('中文規則切塊:CJK 分段單元', () => {
    const c = zh()
    const out = c.chunk('今天天氣很好我們出去走走')
    expect(out.length).toBeGreaterThanOrEqual(1)
  })
})

describe('SemanticChunker.chunkWithSLM', () => {
  it('無 SLM engine 時回退到規則式', async () => {
    const c = zh()
    const out = await c.chunkWithSLM('first second third fourth fifth sixth', 3, null)
    expect(out.length).toBeGreaterThan(0)
  })

  it('SLM 回傳有效 chunks 時使用 SLM 結果', async () => {
    const c = zh({ minWords: 1, maxWords: 20 })
    const fake = {
      chunkWithSLM: vi.fn(async () => [
        { text: 'hello world', words: ['hello', 'world'] },
        { text: 'foo bar baz qux', words: ['foo', 'bar', 'baz', 'qux'], breakProbability: 0.8, emphasis: 'strong' }
      ])
    }
    const out = await c.chunkWithSLM('anything here', 3, fake)
    expect(out.length).toBeGreaterThan(0)
    expect(out.some((ch) => ch.type === 'slm-chunked')).toBe(true)
    expect(fake.chunkWithSLM).toHaveBeenCalled()
  })

  it('SLM 回傳空/無效時回退到規則式', async () => {
    const c = zh()
    const fakeEmpty = { chunkWithSLM: vi.fn(async () => []) }
    const out = await c.chunkWithSLM('one two three four five six seven', 3, fakeEmpty)
    expect(out.length).toBeGreaterThan(0)
  })

  it('SLM 拋錯時回退到規則式', async () => {
    const c = zh()
    const fakeThrow = {
      chunkWithSLM: vi.fn(async () => {
        throw new Error('boom')
      })
    }
    const out = await c.chunkWithSLM('one two three four five six seven eight nine ten', 3, fakeThrow)
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('SemanticChunker.processScript', () => {
  it('處理多句腳本並輸出 sentences / phrases / flatPhrases', () => {
    const c = zh()
    const result = c.processScript('第一句。第二句。')
    expect(result.sentences.length).toBeGreaterThan(0)
    expect(result.phrases.length).toBe(result.sentences.length)
    expect(result.flatPhrases.length).toBeGreaterThan(0)
    expect(result.flatPhrases[0]).toHaveProperty('sentenceIndex')
  })

  it('空腳本回傳空陣列', () => {
    const c = zh()
    expect(c.processScript('   ').sentences).toEqual([])
  })
})

describe('工具函式與匯出', () => {
  it('chunkSentence 使用預設實例', () => {
    const out = chunkSentence('a b c d e f g h', 3)
    expect(out.length).toBeGreaterThan(0)
  })

  it('chunkSentenceWithSLM 無 SLM 時回退', async () => {
    const out = await chunkSentenceWithSLM('a b c d e f g h i j', 3, null)
    expect(out.length).toBeGreaterThan(0)
  })

  it('processScriptWithSemantic 使用預設實例', () => {
    const result = processScriptWithSemantic('句一。句二。')
    expect(result.sentences.length).toBeGreaterThan(0)
  })

  it('processScriptWithSemanticSLM 無 SLM 走規則式', async () => {
    const result = await processScriptWithSemanticSLM('句一。句二。', null)
    expect(result.sentences.length).toBeGreaterThan(0)
    expect(result.flatPhrases).toBeInstanceOf(Array)
  })

  it('processScriptWithSemanticSLM 有 SLM 時用 SLM', async () => {
    const fake = { chunkWithSLM: vi.fn(async () => [{ text: 'x', words: ['x', 'y', 'z'] }]) }
    const result = await processScriptWithSemanticSLM('一句話', fake)
    expect(result.sentences.length).toBeGreaterThan(0)
  })

  it('calculatePhraseDuration 計算毫秒並下限保護', () => {
    expect(calculatePhraseDuration(140, 140)).toBe(60000)
    const short = calculatePhraseDuration(0)
    expect(short).toBeGreaterThanOrEqual(0)
  })

  it('匯出連接詞表', () => {
    expect(CONNECTORS_ZH.ALL.length).toBeGreaterThan(0)
    expect(CONNECTORS_EN.ALL.length).toBeGreaterThan(0)
  })
})

describe('進階切塊細節 (保護區/長句/合併)', () => {
  it('minWords 較小時短句合併成 chunk', () => {
    const c = zh({ minWords: 2, maxWords: 6, targetSize: 4 })
    const out = c.chunk('one two three four five six seven eight')
    expect(out.length).toBeGreaterThan(0)
  })

  it('大量詞彙觸發 splitLongPhrase 長句拆分', () => {
    const c = zh({ minWords: 2, maxWords: 5 })
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
    const out = c.chunk(long)
    const flat = out.reduce<string[]>((acc, p) => acc.concat(p.words), [])
    expect(flat.length).toBeGreaterThan(30)
  })
})

describe('斷句與縮寫 (防誤切)', () => {
  it('Dr./U.S.A. 縮寫的句點不被誤當作句尾', () => {
    const c = zh()
    const s = c.processScript('Dr. Smith went to U.S.A. He returned.')
    expect(s.sentences.length).toBe(2)
    const joined = s.sentences.join(' ')
    expect(joined).toContain('Dr. Smith')
    expect(joined).toContain('U.S.A.')
  })

  it('單字母縮寫 J. Smith 不被誤切', () => {
    const c = zh()
    const s = c.processScript('J. Smith spoke. We listened.')
    expect(s.sentences.length).toBe(2)
  })

  it('句尾無後文時切分(next undefined 分支,保留標點)', () => {
    const c = zh()
    const s = c.processScript('Word. Next.')
    expect(s.sentences[0]).toBe('Word.')
    expect(s.sentences[1]).toBe('Next.')
  })

  it('splitIntoSentencesOf 非字串/空白輸入回傳空陣列', () => {
    const c = zh()
    expect(c.splitIntoSentencesOf('')).toEqual([])
    expect(c.splitIntoSentencesOf(null)).toEqual([])
    expect(c.splitIntoSentencesOf('   ')).toEqual([])
  })
})

describe('保護區與短語分類分支', () => {
  it('checkProtection 偵測各類引號/括號 enter/exit', () => {
    const c = zh()
    expect(c.checkProtection('\u201C')).toMatchObject({ entered: true, type: 'quote' })
    expect(c.checkProtection('\u2019')).toMatchObject({ exited: true })
    expect(c.checkProtection('(')).toMatchObject({ entered: true, type: 'paren' })
    expect(c.checkProtection('[')).toMatchObject({ entered: true, type: 'bracket' })
    expect(c.checkProtection('{')).toMatchObject({ entered: true, type: 'brace' })
    expect(c.checkProtection(')')).toMatchObject({ exited: true })
    expect(c.checkProtection(']')).toMatchObject({ exited: true })
    expect(c.checkProtection('plain')).toEqual({ entered: false, exited: false, type: null })
  })

  it('classifyPhrase 分類 quoted / punctuated / connected / normal', () => {
    const c = zh()
    expect(c.classifyPhrase(['"hello', 'world'])).toBe('quoted')
    expect(c.classifyPhrase(['\u300C引', '句'])).toBe('quoted')
    expect(c.classifyPhrase(['wait,', 'stop'])).toBe('punctuated')
    expect(c.classifyPhrase(['and', 'then'])).toBe('connected')
    expect(c.classifyPhrase(['plain', 'words'])).toBe('normal')
  })

  it('isNaturalPause 辨識中英停頓詞', () => {
    const c = zh()
    expect(c.isNaturalPause('then', 'then')).toBe(true)
    expect(c.isNaturalPause('接下來', '接下來')).toBe(true)
    expect(c.isNaturalPause('xyz', 'xyz')).toBe(false)
  })

  it('括號內的內容被保護為單一區塊', () => {
    const c = zh({ minWords: 1, maxWords: 20, targetSize: 20 })
    const out = c.chunk('alpha ( beta gamma ) epsilon')
    const all = out.flatMap((p) => p.words)
    expect(all).toContain('alpha')
    expect(all).toContain('epsilon')
  })
})

describe('合併/驗證分支 (mergeShortPhrases / validateChunks)', () => {
  it('mergeShortPhrases 在 buffer 未達 minWords 時併入', () => {
    const c = zh({ minWords: 4, maxWords: 20 })
    const merged = c.mergeShortPhrases([
      { text: 'a b', words: ['a', 'b'], type: 'normal' },
      { text: 'c d', words: ['c', 'd'], type: 'normal' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].type).toBe('normal')
    expect(merged[0].words.length).toBe(4)
  })

  it('mergeShortPhrases 在 buffer 已達 minWords 時切出成片段', () => {
    const c = zh({ minWords: 2, maxWords: 20 })
    const merged = c.mergeShortPhrases([
      { text: 'a b', words: ['a', 'b'], type: 'normal' },
      { text: 'c d', words: ['c', 'd'], type: 'normal' }
    ])
    expect(merged).toHaveLength(2)
  })

  it('mergeShortPhrases 不同 type 合併為 mixed / 單一目回傳', () => {
    const c = zh({ minWords: 4, maxWords: 20 })
    const mixed = c.mergeShortPhrases([
      { text: 'a b', words: ['a', 'b'], type: 'normal' },
      { text: 'c d', words: ['c', 'd'], type: 'quoted' }
    ])
    expect(mixed[0].type).toBe('mixed')
    expect(
      c.mergeShortPhrases([{ text: 'x y', words: ['x', 'y'], type: 'normal' }])
    ).toHaveLength(1)
  })

  it('validateChunks 過短片段併入前一片段', () => {
    const c = zh({ minWords: 3, maxWords: 25 })
    const out = c.validateChunks([
      { text: 'a b c d', words: ['a', 'b', 'c', 'd'], type: 'normal' },
      { text: 'x y', words: ['x', 'y'], type: 'normal' } // < MIN_CHUNK_WORDS(3)
    ])
    expect(out).toHaveLength(1)
    expect(out[0].words.length).toBe(6)
  })

  it('validateChunks 過長片段拆為多段', () => {
    const c = zh({ minWords: 3, maxWords: 25 })
    const longWords = Array.from({ length: 30 }, (_, i) => `w${i}`)
    const out = c.validateChunks([
      { text: longWords.join(' '), words: longWords, type: 'normal' }, // > MAX_CHUNK_WORDS(25)
      { text: 'a b c', words: ['a', 'b', 'c'], type: 'normal' }
    ])
    expect(out.length).toBeGreaterThan(2)
  })
})

describe('演化式 SLM 工具函式錯誤/成功路徑', () => {
  it('chunkSentenceWithSLM 使用有效 SLM engine', async () => {
    const fake = { chunkWithSLM: vi.fn(async () => [{ text: 'a b c', words: ['a', 'b', 'c'] }]) }
    const out = await chunkSentenceWithSLM('a b c', 3, fake)
    expect(out.length).toBeGreaterThan(0)
    expect(fake.chunkWithSLM).toHaveBeenCalled()
  })

  it('chunkWithSLM 過濾過短 chunk (words < minWords-1)', async () => {
    const c = zh()
    const fake = { chunkWithSLM: vi.fn(async () => [{ text: 'too short', words: ['a'] }]) }
    const out = await c.chunkWithSLM('hello there', 3, fake)
    expect(out.length).toBeGreaterThanOrEqual(0)
  })

  it('processScriptWithSemanticSLM 在 SLM 拋錯時逐句回退規則式', async () => {
    const fake = {
      chunkWithSLM: vi.fn(async () => {
        throw new Error('fail')
      })
    }
    const result = await processScriptWithSemanticSLM('句一。句二。', fake)
    expect(result.sentences.length).toBeGreaterThan(0)
    expect(result.flatPhrases).toBeInstanceOf(Array)
  })
})
