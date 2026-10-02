/**
 * modeTransforms.ts — 顯示模式載入的純轉換(自 flowprompt-v3 移植)
 */

import type { Bullet } from './bulletGenerator'

/**
 * 將腳本拆為 Karaoke 的 chunk 與逐詞 chunk。
 * 含 "/" 以 "/" 分塊,否則以換行分塊。
 */
export interface KaraokeTokenization {
  tokens: string[]
  /** tokens[i] 之前在原文裡是否隔着空白。渲染層只在這些邊界留詞距,
   *  逐字切出來的中文序列因此不會被 gap 拉開字距。 */
  spaceBefore: boolean[]
}

export function buildKaraokeChunks(script: string): {
  chunks: string[]
  wordChunks: string[][]
  spacing: boolean[][]
} {
  const chunks = script.includes('/')
    ? script
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean)
    : script
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
  const tokenized = chunks.map(tokenizeKaraokeChunk)
  return {
    chunks,
    wordChunks: tokenized.map((t) => t.tokens),
    spacing: tokenized.map((t) => t.spaceBefore)
  }
}

/** 連續中日韓「字」(不含標點):標點要能自己成界,才能掛到前/後一塊 */
const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u3005\u3007]/
/** 拉丁字母/數字的連續串 = 一個詞(英文照舊) */
const WORD_CHAR = /[A-Za-z0-9]/
/** 收尾標點:掛在**前一塊尾巴** —— 高亮停在標點上就是一次換氣,
 *  而不是「符號自己亮一下」。繁中主力的全形 ，！？：； 一定要在表裡。 */
const TRAILING_PUNCT = /[。，、；：！？…‥—–,;:!?)\]}%》】」』）］｝’”]/
/** 開頭符號:掛在**下一塊開頭**,否則「(」自己吃一個 280ms 的 tick */
const LEADING_PUNCT = /[「『（《【［｛([{$+=#@\*&"“‘]/

/**
 * 逐「詞」切分 —— **空白優先**:
 *   1. 空白 = 詞邊界:'第一 行' 切成 ['第一','行'],英數整串一詞照舊。
 *      (沒這條,中文裡夾的空白會被忽略,短詞被拆成單字、節奏全變。)
 *   2. 空白分不出邊界的**連續 3 字以上**中文片段才逐字一塊:中文沒有空白,
 *      整段會變成一個詞,280ms/詞對三十個字的一行等於整行閃一下就過 ——
 *      逐詞高亮對主要使用者(繁中)實際失效。雙字詞以內保持完整。
 *   3. 標點掛前一塊尾巴 / 開引號掛下一塊開頭(全形半形都算)。
 */
export function tokenizeForKaraoke(chunk: string): string[] {
  return tokenizeKaraokeChunk(chunk).tokens
}

export function tokenizeKaraokeChunk(chunk: string): KaraokeTokenization {
  const tokens: string[] = []
  const spaceBefore: boolean[] = []
  /** 待掛到下一塊開頭的開引號(可跨詞:word 全是開引號時) */
  let leading = ''

  for (const word of chunk.split(/\s+/).filter(Boolean)) {
    let firstInWord = true
    const emit = (text: string): void => {
      if (!text && !leading) return
      const space = firstInWord
      firstInWord = false
      tokens.push(leading + text)
      spaceBefore.push(space)
      leading = ''
    }
    let i = 0
    while (i < word.length) {
      const ch = word[i]
      if (WORD_CHAR.test(ch)) {
        let j = i
        while (j < word.length && WORD_CHAR.test(word[j])) j++
        emit(word.slice(i, j))
        i = j
        continue
      }
      if (CJK_RUN.test(ch)) {
        let j = i
        while (j < word.length && CJK_RUN.test(word[j])) j++
        const run = word.slice(i, j)
        if (run.length > 2) {
          // 逐字:只有該片段的第一字可能是詞邊界,後面的字與前字相連
          for (const c of run) {
            const space = firstInWord
            firstInWord = false
            tokens.push(leading + c)
            spaceBefore.push(space)
            leading = ''
          }
        } else {
          emit(run)
        }
        i = j
        continue
      }
      // 收尾標點一律掛到「前面已經切出來的塊」的尾巴。
      // 比較對象是整條 chunk 的長度而不是本詞的起點:像「你好 世界。」這種
      // 標點落在第二個詞開頭的情形,掛到前一詞的尾巴才對得起換氣的語意。
      // 前面一塊都還沒有(標點在句首)時,它與開引號同命運 —— 掛到下一塊開頭,
      // 否則「,」會自己吃一格 280ms 的 tick(這是修掉的缺陷)。
      if (TRAILING_PUNCT.test(ch) && tokens.length > 0) {
        tokens[tokens.length - 1] += ch
      } else if (LEADING_PUNCT.test(ch) || TRAILING_PUNCT.test(ch)) {
        leading += ch
      } else {
        emit(ch)
      }
      i++
    }
  }
  // 只有開引號、後面沒東西的孤例:自己成一塊,別把它丟掉
  if (leading) {
    tokens.push(leading)
    spaceBefore.push(true)
    leading = ''
  }
  return { tokens, spaceBefore }
}

/**
 * 渲染層的詞距判斷:token `index` 之前要不要留空白。
 *
 * 為什麼要一個函式而不是直接在 JSX 裡 `spacing[i + 1] ? ... : undefined`:
 * 舊的渲染語意是「每個詞之間都有詞距」,而 `?? []` 這種寫法在資料缺漏時
 * 會讓**每一個**邊界都變成「沒有詞距」—— 英文逐詞高亮整串黏在一起、
 * 看不到分隔,而且沒有任何錯誤訊息。那是靜默降級,比明顯壞掉更難察覺。
 * 這裡把降級方向釘死:缺資料時回到舊語意(多一點詞距,只是醜),不退回不可讀。
 *
 * 索引 0 一律 false:那裡沒有「前一塊」,詞距由前一個 token 的右側承擔。
 */
export function tokenGapAt(spacing: readonly boolean[] | undefined, index: number): boolean {
  if (index <= 0) return false
  if (!spacing || index >= spacing.length) return true
  return spacing[index] !== false
}

/** Bullet 載入 fallback:以換行切分 */
export function buildBulletFallback(script: string): Bullet[] {
  return script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((text) => ({ text, detail: '', title: '', subPoints: [] }))
}

/**
 * 將單個過長 bullet 依句點拆分為多個 bullet。
 * 僅在拆分出至少 2 句時回傳新陣列,否則回傳 null。
 */
export function splitSingleBullet(text: string): Bullet[] | null {
  const subSentences = text
    .split(/[.!?。！?;；]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)

  if (subSentences.length < 2) return null

  return subSentences.slice(0, 12).map((t) => ({
    text: t,
    detail: '',
    title: '',
    subPoints: []
  }))
}
