import { describe, it, expect } from 'vitest'
import { normalizeForMatch, buildChunks, bestMatchPosition, chunkAtPosition } from '../follow'

const script = '大家好今天要介紹新產品。\n首先說明市場痛點。\n接著展示解決方案。\n最後總結願景。'
const norm = normalizeForMatch(script)

describe('bestMatchPosition 向後搜尋(跳回關鍵詞)', () => {
  it('正常跟隨:當前位置附近匹配', () => {
    const pos = norm.indexOf('首先') // 第二段開頭
    const spoken = normalizeForMatch('首先說明市場痛點')
    const end = bestMatchPosition(norm, spoken, pos)
    expect(end).toBeGreaterThan(pos)
  })

  it('預設向後視窗小:重複唸第一段時在 from 附近找不到', () => {
    const pos = norm.indexOf('接著') // 已推進到第三段
    const spoken = normalizeForMatch('大家好今天要介紹新產品') // 重頭唸
    const strict = bestMatchPosition(norm, spoken, pos)
    expect(strict).toBe(-1)
  })

  it('放寬 backward:重複唸第一段可跳回', () => {
    const pos = norm.indexOf('接著')
    const spoken = normalizeForMatch('大家好今天要介紹新產品')
    const end = bestMatchPosition(norm, spoken, pos, { backward: 160 })
    expect(end).toBeGreaterThan(0)
    expect(end).toBeLessThan(pos)
    expect(chunkAtPosition(buildChunks(script), end - 1)).toBe(0)
  })

  it('胡亂內容回 -1', () => {
    expect(bestMatchPosition(norm, normalizeForMatch('完全無關的內容xyzabc'), 0)).toBe(-1)
  })
})

describe('buildChunks', () => {
  it('換行切段且位置對應正規化座標', () => {
    const chunks = buildChunks(script)
    expect(chunks.length).toBe(4)
    expect(chunks[0].start).toBe(0)
    expect(chunks[1].start).toBe(chunks[0].end)
  })
})
