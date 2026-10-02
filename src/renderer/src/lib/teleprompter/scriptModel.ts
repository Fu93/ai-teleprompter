/**
 * scriptModel.ts — 把講稿一次性加工成四種顯示模式所需的資料
 *
 * phrase 模式:語義切塊後的句子/短語樹(semanticChunker)
 * karaoke 模式:chunk + 逐詞(modeTransforms.buildKaraokeChunks)
 * bullet 模式:Markdown 大綱或段落要點(bulletGenerator,空結果退 fallback)
 * scroll 模式:原始內容
 */

import { createSemanticChunker } from './semanticChunker'
import type { Phrase } from './semanticChunker'
import { generateBullets } from './bulletGenerator'
import { buildKaraokeChunks, buildBulletFallback } from './modeTransforms'

export interface OverlayBullet {
  title: string
  subPoints: string[]
}

export interface ScriptModel {
  content: string
  sentences: string[]
  /** 每句切出的短語陣列,phrases[sentenceIndex][phraseIndex] */
  phrases: Phrase[][]
  karaokeChunks: string[]
  karaokeWordChunks: string[][]
  /** 與 karaokeWordChunks 對齊:true = 該詞之前在原文裡有空白(渲染層的詞距來源) */
  karaokeTokenSpacing: boolean[][]
  bullets: OverlayBullet[]
}

const chunker = createSemanticChunker()

export function buildScriptModel(content: string): ScriptModel {
  const processed = chunker.processScript(content ?? '')
  const { chunks, wordChunks, spacing } = buildKaraokeChunks(content ?? '')
  const generated = generateBullets(content ?? '')
  const bullets: OverlayBullet[] =
    generated.length > 0
      ? generated.map((b) => ({ title: b.title || b.text, subPoints: b.subPoints }))
      : buildBulletFallback(content ?? '').map((b) => ({ title: b.text, subPoints: [] }))

  return {
    content: content ?? '',
    sentences: processed.sentences,
    phrases: processed.phrases,
    karaokeChunks: chunks,
    karaokeWordChunks: wordChunks,
    karaokeTokenSpacing: spacing,
    bullets
  }
}
