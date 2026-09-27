import { describe, it, expect } from 'vitest'
import { generateBullets, extractCues, extractBadges } from '../bulletGenerator'

describe('generateBullets', () => {
  it('回傳空陣列當輸入為空或非字串', () => {
    expect(generateBullets('')).toEqual([])
    expect(generateBullets('   ')).toEqual([])
    expect(generateBullets(null)).toEqual([])
    expect(generateBullets(undefined)).toEqual([])
    expect(generateBullets(123)).toEqual([])
  })

  it('偵測 Markdown 標題並將列表項目歸入 subPoints', () => {
    const script = [
      '## 開場',
      '- 打招呼',
      '- 自我介紹',
      '接下來的重點說明。'
    ].join('\n')

    const bullets = generateBullets(script)
    expect(bullets).toHaveLength(1)
    expect(bullets[0].title).toBe('開場')
    expect(bullets[0].subPoints).toEqual(['打招呼', '自我介紹', '接下來的重點說明。'])
  })

  it('無標題時,獨立列表項目各自成為 bullet', () => {
    const script = ['- 重點一', '* 重點二', '1. 重點三'].join('\n')
    const bullets = generateBullets(script)
    expect(bullets.length).toBeGreaterThanOrEqual(2)
    expect(bullets[0].text).toBe('重點一')
    expect(bullets[0].cues).toEqual([])
  })

  it('跳過空行且不產生 null item', () => {
    const bullets = generateBullets('\n\n- a\n- b\n\n')
    expect(bullets).toHaveLength(2)
    expect(bullets[0].title).toBe('a')
    expect(bullets[1].title).toBe('b')
  })

  it('無 Markdown 結構時按空行分段 fallback', () => {
    const bullets = generateBullets('第一段文字。\n\n第二段文字。')
    expect(bullets).toHaveLength(2)
    expect(bullets[0].text).toContain('第一段文字')
    expect(bullets[0].subPoints).toEqual([])
  })

  it('只有一行時 fallback 到句子切分', () => {
    const bullets = generateBullets('第一句。第二句。第三句。')
    expect(bullets.length).toBeGreaterThanOrEqual(2)
  })

  it('cleanInlineFormatting 移除粗體標記', () => {
    const bullets = generateBullets('- **重點** 說明')
    expect(bullets[0].text).toBe('重點 說明')
  })

  it('尊重 maxBullets 上限', () => {
    const script = Array.from({ length: 20 }, (_, i) => `- 要點 ${i}`).join('\n')
    const bullets = generateBullets(script, { maxBullets: 5 })
    expect(bullets).toHaveLength(5)
  })

  it('maxBullets 預設值(12)', () => {
    const script = Array.from({ length: 20 }, (_, i) => `- 要點 ${i}`).join('\n')
    const bullets = generateBullets(script)
    expect(bullets).toHaveLength(12)
  })
})

describe('extractCues', () => {
  it('提取講者提示', () => {
    expect(extractCues('大家好(提示:看鏡頭)[動作:點頭]')).toEqual(['看鏡頭', '點頭'])
  })

  it('英文 cue 標籤也支援', () => {
    expect(extractCues('(Cue:slow down)(Note:pause)')).toEqual(['slow down', 'pause'])
  })

  it('非字串或無提示回傳空陣列', () => {
    expect(extractCues(null)).toEqual([])
    expect(extractCues('沒有提示')).toEqual([])
  })
})

describe('extractBadges', () => {
  it('提取百分比與單位數字', () => {
    const badges = extractBadges('成長 40%,金流 $500K,約 3.5倍')
    expect(badges).toContain('40%')
    expect(badges).toContain('$500K')
  })

  it('忽略單一數字字元', () => {
    expect(extractBadges('版本 3 與 4')).toEqual([])
  })

  it('非字串回傳空陣列', () => {
    expect(extractBadges(undefined)).toEqual([])
  })
})
