import { describe, it, expect } from 'vitest'
import { squircleSurface, rayDisplacement } from '../glassRefraction'

describe('squircleSurface', () => {
  it('0=外緣、1=平面開始,單調遞增', () => {
    expect(squircleSurface(0)).toBe(0)
    expect(squircleSurface(1)).toBe(1)
    for (let x = 0.05; x < 1; x += 0.05) {
      expect(squircleSurface(x)).toBeGreaterThan(squircleSurface(x - 0.05))
    }
  })
  it('比圓弧更早趨近平面(squircle 特性)', () => {
    // x=0.7 時 squircle 已 >0.95,圓弧約 0.84
    expect(squircleSurface(0.7)).toBeGreaterThan(0.95)
  })
})

describe('rayDisplacement', () => {
  it('邊緣與平面交點位移為 0,中段有峰值', () => {
    expect(rayDisplacement(0)).toBe(0)
    expect(rayDisplacement(1)).toBeCloseTo(0, 5)
    let peak = 0
    for (let x = 0.05; x < 1; x += 0.05) {
      peak = Math.max(peak, rayDisplacement(x))
    }
    expect(peak).toBeGreaterThan(0.2)
    expect(peak).toBeLessThanOrEqual(1)
  })
  it('輸出夾在 [0,1],任何輸入不爆(NaN 防護)', () => {
    for (const x of [-1, 0, 0.5, 2, NaN]) {
      const v = rayDisplacement(x)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
