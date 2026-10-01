import { describe, expect, it } from 'vitest'
import {
  clampIpdMm,
  countReadableChars,
  effectiveEngineRate,
  estimateDistanceCm,
  fontSizeFromDistance,
  isPlausibleRate,
  speedFromRate,
  visualAngleDeg
} from '../calibration'

describe('estimateDistanceCm 瞳距像素 → 觀看距離', () => {
  it('典型情境：63mm 瞳距在 60cm 距離的像素大小，反推回 60cm', () => {
    // 正推：f_px = (640/2)/tan(65°/2) ≈ 477.9；60cm 處 pixelIPD = 477.9×63/600 ≈ 50.2px
    const hfov = 65
    const frameWidth = 640
    const fPx = frameWidth / 2 / Math.tan(((hfov / 2) * Math.PI) / 180)
    const distanceCm = 60
    const pixelIpd = (fPx * 63) / (distanceCm * 10)
    const normalizedIpd = pixelIpd / frameWidth

    const est = estimateDistanceCm({ normalizedIpd, frameWidthPx: frameWidth, ipdMm: 63, hfovDeg: hfov })
    expect(est).toBeCloseTo(distanceCm, 1)
  })

  it('距離越遠、正規化瞳距越小', () => {
    const near = estimateDistanceCm({ normalizedIpd: 0.12, frameWidthPx: 640, ipdMm: 63 })
    const far = estimateDistanceCm({ normalizedIpd: 0.06, frameWidthPx: 640, ipdMm: 63 })
    expect(far).toBeGreaterThan(near)
  })

  it('瞳距為 0 時不除以零', () => {
    expect(estimateDistanceCm({ normalizedIpd: 0, frameWidthPx: 640, ipdMm: 63 })).toBe(0)
  })
})

describe('fontSizeFromDistance 視距 → 字級', () => {
  it('60cm 約 35px（0.58 px/cm）', () => {
    expect(fontSizeFromDistance(60)).toBe(35)
  })
  it('上下限夾擠：太近不低於 16、太遠不高於 72', () => {
    expect(fontSizeFromDistance(10)).toBe(16)
    expect(fontSizeFromDistance(300)).toBe(72)
  })
})

describe('speedFromRate 語速 → 滾動速度', () => {
  it('240 字/分、35px 字級 → 140 px/s', () => {
    expect(speedFromRate(240, 35)).toBe(140)
  })
  it('語速越快速度越快', () => {
    expect(speedFromRate(300, 30)).toBeGreaterThan(speedFromRate(200, 30))
  })
})

describe('visualAngleDeg', () => {
  it('60cm、35px 字級的視角約 0.9°', () => {
    expect(visualAngleDeg(60, 35)).toBeGreaterThan(0.7)
    expect(visualAngleDeg(60, 35)).toBeLessThan(1.1)
  })
})

describe('countReadableChars 可讀字數', () => {
  it('中文逐字計，標點空白不算', () => {
    expect(countReadableChars('大家好，很高興見面！')).toBe(8)
  })
  it('英文單字視為 1 字', () => {
    expect(countReadableChars('hello world 測試')).toBe(4) // 2 英文字 + 2 中文字
  })
  it('空字串為 0', () => {
    expect(countReadableChars('')).toBe(0)
    expect(countReadableChars('。。。？！')).toBe(0)
  })
})

describe('isPlausibleRate 語速合理性', () => {
  it('正常朗讀 160~400 字/分為合理', () => {
    expect(isPlausibleRate(240)).toBe(true)
    expect(isPlausibleRate(180)).toBe(true)
  })
  it('極端值不合理', () => {
    expect(isPlausibleRate(50)).toBe(false)
    expect(isPlausibleRate(600)).toBe(false)
  })
})

describe('effectiveEngineRate 個人語速 → 引擎有效倍率', () => {
  it('未校準時倍率原樣返回', () => {
    expect(effectiveEngineRate(1, null)).toBe(1)
    expect(effectiveEngineRate(1.5, undefined)).toBe(1.5)
  })
  it('個人語速 240 字/分、倍率 1 → 有效 2×（引擎基準 120）', () => {
    expect(effectiveEngineRate(1, 240)).toBe(2)
  })
  it('個人語速 240、倍率 0.5 → 有效 1×（恰好等於引擎原基準）', () => {
    expect(effectiveEngineRate(0.5, 240)).toBe(1)
  })
  it('慢速 60 字/分 → 有效 0.5×', () => {
    expect(effectiveEngineRate(1, 60)).toBe(0.5)
  })
  it('自訂引擎基準', () => {
    expect(effectiveEngineRate(1, 240, 240)).toBe(1)
  })
})

describe('clampIpdMm 瞳距夾限', () => {
  it('範圍內原樣返回（整數）', () => {
    expect(clampIpdMm(63)).toBe(63)
    expect(clampIpdMm(58)).toBe(58)
  })
  it('超過上限/下限被夾進 50–80(type=number 的 min/max 擋不住手打)', () => {
    expect(clampIpdMm(631)).toBe(80)
    expect(clampIpdMm(5)).toBe(50)
  })
  it('非數值(清空)回退成人平均 63', () => {
    expect(clampIpdMm(Number(''))).toBe(63)
    expect(clampIpdMm(NaN)).toBe(63)
  })
  it('小數四捨五入', () => {
    expect(clampIpdMm(62.4)).toBe(62)
    expect(clampIpdMm(62.6)).toBe(63)
  })
})
