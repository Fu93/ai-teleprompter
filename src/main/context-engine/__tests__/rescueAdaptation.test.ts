import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESCUE_CAP_MS,
  RESCUE_KEEP_SAMPLES,
  adaptiveRescueTimeout,
  percentile,
  recordRescueSample
} from '../rescueAdaptation'

describe('percentile', () => {
  it('少樣本時取較慢的那一側(不取樂觀值)', () => {
    expect(percentile([100, 200, 300, 400], 0.75)).toBe(300)
  })
  it('空陣列回 NaN(呼叫端必須自己擋)', () => {
    expect(percentile([], 0.5)).toBeNaN()
  })
})

describe('adaptiveRescueTimeout 救援時間預算', () => {
  it('樣本不足 → 原封不動的 base', () => {
    expect(adaptiveRescueTimeout(900, [])).toBe(900)
    expect(adaptiveRescueTimeout(900, [1_500, 1_600])).toBe(900)
  })

  it('實測延遲一直高於 base → 放寬(p75 × 1.5)', () => {
    // p75 = 1200 → 1800
    expect(adaptiveRescueTimeout(900, [1_000, 1_100, 1_200, 1_300])).toBe(1_800)
  })

  it('只放寬、不收緊:樣本全都比 base 快時維持 base', () => {
    expect(adaptiveRescueTimeout(2_500, [200, 250, 300])).toBe(2_500)
  })

  it('夾在上限:再慢也不會讓救援卡等超過 4 秒', () => {
    expect(adaptiveRescueTimeout(900, [5_000, 6_000, 7_000])).toBe(DEFAULT_RESCUE_CAP_MS)
  })

  it('非數值/負數樣本不參與(污染樣本不得撐大預算)', () => {
    expect(adaptiveRescueTimeout(900, [Number.NaN, -5, 0])).toBe(900)
  })
})

describe('recordRescueSample 樣本累積', () => {
  it('累積並四捨五入', () => {
    const s: number[] = []
    recordRescueSample(s, 1_234.6)
    expect(s).toEqual([1_235])
  })

  it('保留上限:舊樣本出窗', () => {
    const s: number[] = []
    for (let i = 1; i <= RESCUE_KEEP_SAMPLES + 3; i++) recordRescueSample(s, i * 100)
    expect(s.length).toBe(RESCUE_KEEP_SAMPLES)
    expect(s[0]).toBe(400) // 100/200/300 已出窗
  })

  it('垃圾值不進樣本', () => {
    const s: number[] = []
    recordRescueSample(s, Number.NaN)
    recordRescueSample(s, 0)
    recordRescueSample(s, -1)
    expect(s).toEqual([])
  })
})

/**
 * 接線守衛:純函數再正確,沒有被呼叫就等於不存在 ——
 * 這個 repo 對這種失敗有名字(「宣告了,但沒有任何呼叫端」)。
 * 同型守衛見 src/renderer/src/lib/__tests__/domAudit.test.ts 的腳本接線測試。
 */
describe('接線:liveCoaching 真的用了自適應預算並記錄樣本', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const src = readFileSync(join(ROOT, 'src', 'main', 'liveCoaching.ts'), 'utf-8')

  it('panicTimeoutMs 走 adaptiveRescueTimeout(', () => {
    expect(src).toContain('adaptiveRescueTimeout(')
  })

  it('成功的救援會記一筆樣本並節流落盤', () => {
    expect(src).toContain('recordRescueSample(')
    expect(src).toContain('saveSettingsThrottled(state.settings)')
  })

  it('換供應商重新累積(樣本綁 provider id)', () => {
    expect(src).toContain('rescueLatencySamples')
    expect(src).toContain('personal.rescue.providerId')
  })
})
