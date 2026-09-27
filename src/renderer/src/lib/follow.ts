// 語音跟讀：把「聽到的逐字稿」對位到講稿中的位置
// 演算法：正規化（去標點空白）後，以滑動窗口在講稿中尋找與口語內容最相似的區段

/** 正規化：移除標點、空白、符號；英數轉小寫 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .normalize('NFKC')
}

export interface FollowChunk {
  text: string // 原文片段
  start: number // 在正規化字串中的起始 index
  end: number // 正規化結束 index（不含）
}

/**
 * 把講稿切成片段：有換行依段落，無換行的長文每 ~40 字切一段。
 * 每個片段記錄其在正規化字串中的範圍，供比對後定位捲動。
 */
export function buildChunks(content: string): FollowChunk[] {
  const chunks: FollowChunk[] = []
  const lines = content.split(/\n+/)
  let normOffset = 0
  const MAX = 40

  const pushNorm = (text: string): void => {
    const norm = normalizeForMatch(text)
    if (!norm) return
    if (norm.length <= MAX) {
      chunks.push({ text, start: normOffset, end: normOffset + norm.length })
      normOffset += norm.length
    } else {
      // 長段再細切：把原文按正規化長度比例切
      let consumed = 0 // 已處理的正規化長度
      let rawIdx = 0
      while (consumed < norm.length) {
        const take = Math.min(MAX, norm.length - consumed)
        // 找 rawIdx 讓 raw 部分的正規化長度 ≈ take
        let rawEnd = rawIdx
        let acc = 0
        while (rawEnd < text.length && acc < take) {
          const ch = normalizeForMatch(text[rawEnd])
          acc += ch.length
          rawEnd++
        }
        const piece = text.slice(rawIdx, rawEnd)
        chunks.push({ text: piece, start: normOffset + consumed, end: normOffset + consumed + acc })
        consumed += acc
        rawIdx = rawEnd
      }
      normOffset += norm.length
    }
  }

  for (const line of lines) pushNorm(line)
  return chunks
}

/**
 * 在 scriptNorm[from..] 中尋找 spokenNorm 最相似的視窗位置。
 * 回傳匹配視窗的結束位置（正規化座標）；品質太低回傳 -1。
 */
export function bestMatchPosition(
  scriptNorm: string,
  spokenNorm: string,
  from: number,
  opts?: { window?: number; minScore?: number }
): number {
  const win = Math.min(opts?.window ?? 24, spokenNorm.length)
  if (win < 4) return -1
  const probe = spokenNorm.slice(0, win)
  const minScore = opts?.minScore ?? 0.5

  let bestScore = 0
  let bestEnd = -1
  const searchFrom = Math.max(0, from - 10) // 容許一點回溯
  const limit = scriptNorm.length - win
  for (let p = searchFrom; p <= limit; p++) {
    let score = 0
    for (let i = 0; i < win; i++) {
      if (scriptNorm[p + i] === probe[i]) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestEnd = p + win
    }
    // 早停：接近滿分
    if (bestScore >= win * 0.95) break
  }
  if (bestScore / win < minScore) return -1
  return bestEnd
}

/** 找出包含正規化位置 pos 的片段 index */
export function chunkAtPosition(chunks: FollowChunk[], pos: number): number {
  for (let i = 0; i < chunks.length; i++) {
    if (pos >= chunks[i].start && pos < chunks[i].end) return i
  }
  return chunks.length - 1
}
