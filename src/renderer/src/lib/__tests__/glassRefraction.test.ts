import { describe, it, expect } from 'vitest'
import { squircleSurface, rayDisplacement, shapeInset } from '../glassRefraction'

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

/**
 * 折射幾何。這一組測試的存在理由:「藥丸看起來是一個有白邊的長方形」的那個 bug,
 * 用舊模型(到四條直邊的最近距離 + 角落覆寫)是不可能靠單元測試抓到的 ——
 * 而它其實是幾何錯誤,完全可以離線驗證。這裡鎖住三個性質:
 *  1. 膠囊的圓端法線是徑向(所以折射環是橢圓環,不是沿直邊堆出來的亮帶)
 *  2. 直邊段法線垂直
 *  3. 兩者交界連續(圓與直線相切 → 無接縫)
 */
describe('shapeInset(圓角矩形/膠囊的 SDF)', () => {
  const W = 320
  const H = 48
  const R = H / 2 // 真膠囊

  it('內部 depth 為正、外部為負,邊界約為 0', () => {
    expect(shapeInset(160, 24, W, H, R).depth).toBeGreaterThan(20)
    expect(shapeInset(-10, 24, W, H, R).depth).toBeLessThan(0)
    // 上緣中點:像素中心 1.5px → 約 1.5px 深
    expect(shapeInset(160, 1, W, H, R).depth).toBeCloseTo(1.5, 1)
  })

  it('膠囊:直邊段的內向法線垂直向下', () => {
    for (const x of [60, 100, 160, 220, 260]) {
      const { nx, ny } = shapeInset(x, 1, W, H, R)
      expect(Math.abs(nx)).toBeLessThan(0.02)
      expect(ny).toBeGreaterThan(0.98)
    }
  })

  it('膠囊:圓端的內向法線是徑向的(橢圓環,不是直邊框)', () => {
    const cx = R
    const cy = H / 2
    const inner = R - 1.5
    for (let deg = 100; deg <= 260; deg += 20) {
      const rad = (deg * Math.PI) / 180
      const x = cx + inner * Math.cos(rad)
      const y = cy + inner * Math.sin(rad)
      const { nx, ny } = shapeInset(x, y, W, H, R)
      // 外向方向 = 由圓端中心指向該點;內向法線是它的反向(把背景往形狀裡拉)
      expect(nx).toBeCloseTo(-Math.cos(rad), 1)
      expect(ny).toBeCloseTo(-Math.sin(rad), 1)
    }
  })

  it('膠囊:圓端與直邊相切,沿周長沒有接縫(相鄰法線夾角很小)', () => {
    // 沿上緣由右往左走進左側圓端,取 1.5px 深的點
    let prev: number | null = null
    for (let x = 200; x >= 1; x -= 2) {
      const { ny } = shapeInset(x, 1, W, H, R)
      const angle = Math.acos(Math.max(-1, Math.min(1, ny))) // 與向下的夾角
      if (prev !== null) expect(Math.abs(angle - prev)).toBeLessThan(0.12) // < ~7°
      prev = angle
    }
    // 確保全段真的從「垂直」轉到「水平」,不是一路都垂直(那就沒測到圓端)
    const end = shapeInset(1, H / 2, W, H, R)
    expect(Math.abs(end.nx)).toBeGreaterThan(0.9)
  })

  it('radius 大於高的一半時退化為體育場形(夾住不爆)', () => {
    const huge = shapeInset(160, 1, W, H, 999)
    const capsule = shapeInset(160, 1, W, H, R)
    expect(huge.depth).toBeCloseTo(capsule.depth, 5)
    expect(huge.ny).toBeCloseTo(capsule.ny, 5)
  })
})
