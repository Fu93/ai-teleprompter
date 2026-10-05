import { describe, expect, it } from 'vitest'
import { DENSITY_FAST_CPM, DENSITY_SLOW_CPM, suggestDisplayMode } from '../densityAdvice'

const profile = (charsPerMin: number, sampleSeconds = 30): { charsPerMin: number; sampleSeconds: number } => ({
  charsPerMin,
  sampleSeconds
})

describe('suggestDisplayMode 提詞密度建議', () => {
  it('未校準 → 不建議(沒有量測就不猜)', () => {
    expect(suggestDisplayMode(null, 'scroll')).toBeNull()
    expect(suggestDisplayMode(undefined, 'scroll')).toBeNull()
  })

  it('校準樣本太短(<6s)→ 不建議:數字本身就不穩', () => {
    expect(suggestDisplayMode(profile(350, 3), 'scroll')).toBeNull()
  })

  it('快讀者 → 重點要點,理由含量到的數字', () => {
    const a = suggestDisplayMode(profile(DENSITY_FAST_CPM), 'scroll')
    expect(a?.mode).toBe('bullet')
    expect(a?.reason).toContain(`${DENSITY_FAST_CPM} 字/分`)
  })

  it('慢讀者 → 連續捲動', () => {
    expect(suggestDisplayMode(profile(DENSITY_SLOW_CPM), 'bullet')?.mode).toBe('scroll')
  })

  it('中間帶 → 不建議(現有選擇多半合適,不製造無謂的切換)', () => {
    expect(suggestDisplayMode(profile(DENSITY_SLOW_CPM + 1), 'bullet')).toBeNull()
    expect(suggestDisplayMode(profile(DENSITY_FAST_CPM - 1), 'scroll')).toBeNull()
  })

  it('已經在建議的模式上 → 不回同一句話(讀者已經照做了)', () => {
    expect(suggestDisplayMode(profile(350), 'bullet')).toBeNull()
    expect(suggestDisplayMode(profile(150), 'scroll')).toBeNull()
  })

  it('非數值/零語速 → 不建議', () => {
    expect(suggestDisplayMode(profile(Number.NaN), 'scroll')).toBeNull()
    expect(suggestDisplayMode(profile(0), 'scroll')).toBeNull()
  })
})
