/**
 * modeTransforms.ts — 顯示模式載入的純轉換(自 flowprompt-v3 移植)
 */

import type { Bullet } from './bulletGenerator'

/**
 * 將腳本拆為 Karaoke 的 chunk 與逐詞 chunk。
 * 含 "/" 以 "/" 分塊,否則以換行分塊。
 */
export function buildKaraokeChunks(script: string): { chunks: string[]; wordChunks: string[][] } {
  const chunks = script.includes('/')
    ? script
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean)
    : script
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
  const wordChunks = chunks.map((c) => c.split(' ').filter((w) => w.trim()))
  return { chunks, wordChunks }
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
