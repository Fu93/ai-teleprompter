/**
 * corner-scan.test.mjs — 四角幾何斷言的負向驗證。
 *
 * audit:edge 新增的角落斷言抓的是「視窗層把圓角吃掉」那類缺陷
 * (Electron #43075:acrylic backgroundMaterial 讓 frameless 視窗失去圓角)。
 * 這類缺陷在既有的四邊中點掃線下完全隱形 —— 而一條「抓不到它宣稱要抓的東西」
 * 的斷言比沒有斷言更糟:它給人覆蓋的幻覺。
 *
 * 所以這裡用合成 PNG 直接驗 cornerScan 本身(不啟動 Electron):
 *   1. 真圓角(依解析解畫出來的膠囊/面板)→ 必須 pass,而且理論值要對
 *   2. **方角(缺陷形狀本身)** → 必須 fail —— 這是模擬 #43075 的核心案例
 *   3. 半徑對半縮水 → 必須 fail(抓「radius 被外層改寫」的溫和版本)
 *   4. 全畫布同色(量測失效,例如背景設定錯誤)→ 必須 fail,不能假綠
 *
 * 執行:npx vitest run scripts/lib/__tests__/corner-scan.test.mjs
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CORNER_TOL_PX, cornerScan } from '../corner-scan.mjs'

const OUT = mkdtempSync(join(tmpdir(), 'corner-scan-'))

/** 在白底上畫一個深色形狀。corner=[dx,dy] 的角留白(圓角)或填滿(方角)。 */
async function draw({ w, h, radius, dpr = 2, square = false, uniform = false }) {
  const W = w * dpr
  const H = h * dpr
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    ${uniform ? '' : square
      ? `<rect width="${W}" height="${H}" fill="#404450"/>`
      : `<rect width="${W}" height="${H}" rx="${radius * dpr}" ry="${radius * dpr}" fill="#404450"/>`}
  </svg>`
  const file = join(OUT, `shape-${w}x${h}-r${radius}-${square ? 'sq' : 'rd'}-${dpr}.png`)
  await sharp(Buffer.from(svg)).png().toFile(file)
  return file
}

// 藥丸的實際形狀:320×48 CSS、rounded-full(半徑夾到 24)、2× DPI。
// 真實截圖上首材質距離實測 14 device px,理論 14.1 —— 合成圖要落在同一格。
const PILL = { w: 320, h: 48, radius: 24 }
// 面板:720×260、rounded-2xl(16)、2× DPI,實測 9 vs 理論 9.4。
const PANEL = { w: 720, h: 260, radius: 16 }

describe('cornerScan — 正向:真圓角必須過,理論值必須對', () => {
  it('膠囊(rounded-full 夾到 h/2)四角命中解析解', async () => {
    const file = await draw({ ...PILL })
    const r = await cornerScan(file, { w: PILL.w, h: PILL.h }, PILL.radius)
    expect(r.pass).toBe(true)
    // 解析解:24 × (1 − 1/√2) × 2 ≈ 14.1 device px
    expect(r.theory).toBeCloseTo(14.1, 1)
    for (const d of r.firsts) expect(Math.abs(d - r.theory)).toBeLessThanOrEqual(CORNER_TOL_PX)
  })

  it('面板(rounded-2xl)四角命中解析解', async () => {
    const file = await draw({ ...PANEL })
    const r = await cornerScan(file, { w: PANEL.w, h: PANEL.h }, PANEL.radius)
    expect(r.pass).toBe(true)
    expect(r.theory).toBeCloseTo(9.4, 1)
  })

  it('宣告半徑超大(rounded-full 的 9999px)會被夾到 min(w,h)/2,結果與膠囊相同', async () => {
    const file = await draw({ ...PILL })
    const r = await cornerScan(file, { w: PILL.w, h: PILL.h }, 9999)
    expect(r.pass).toBe(true)
    expect(r.theory).toBeCloseTo(14.1, 1)
  })
})

describe('cornerScan — 負向:缺陷形狀必須變紅', () => {
  it('方角(模擬 Electron #43075:acrylic 吃掉圓角)必須 fail', async () => {
    const file = await draw({ ...PILL, square: true })
    const r = await cornerScan(file, { w: PILL.w, h: PILL.h }, PILL.radius)
    // 方角的首材質距離是 0 或 1,遠小於理論 14.1
    expect(r.pass).toBe(false)
    expect(r.matched).toBe(0)
  })

  it('半徑對半縮水(16 → 實際 8)必須 fail', async () => {
    // 宣告 24,但像素只有 12 CSS 半徑(外層改寫/縮放的溫和版)
    const file = await draw({ ...PILL, radius: 12 })
    const r = await cornerScan(file, { w: PILL.w, h: PILL.h }, PILL.radius)
    expect(r.pass).toBe(false)
  })

  it('四角全被填成方形的面板必須 fail', async () => {
    const file = await draw({ ...PANEL, square: true })
    const r = await cornerScan(file, { w: PANEL.w, h: PANEL.h }, PANEL.radius)
    expect(r.pass).toBe(false)
  })
})

describe('cornerScan — 量測失效不能假綠', () => {
  it('全畫布同色(掃不到任何對比)必須 fail,回傳 -1', async () => {
    const file = await draw({ ...PILL, uniform: true })
    const r = await cornerScan(file, { w: PILL.w, h: PILL.h }, PILL.radius)
    expect(r.pass).toBe(false)
    for (const d of r.firsts) expect(d).toBe(-1)
  })
})
