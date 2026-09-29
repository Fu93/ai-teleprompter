// 一次性驗證:設定頁滑桿的幾何與實際繪製。
//
// 改了 input[type=range] 的 height 之後不能只看 computed style 就收工 ——
// 軌道 4px 與滑塊 18px 現在畫在不同層,萬一 margin 沒對齊,
// 視覺上會是滑塊浮在軌道上方或被切掉。這裡把滑桿單獨截一張,
// 用像素分析確認:(1) 軌道存在且 4px (2) 滑塊是完整 18px 的圓。
//
// 執行:AI_TP_E2E=1 node .audit/probe-slider.mjs
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'fs'

mkdirSync('docs/audit', { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({ args: ['.'], timeout: 60_000 })
let main = await app.firstWindow()
await main.waitForLoadState('domcontentloaded')
for (let i = 0; i < 15; i++) {
  const ok = await main.evaluate(() => !!document.querySelector('aside')).catch(() => false)
  if (ok) break
  await sleep(500)
  const cand = app.windows().find((w) => w !== main)
  if (cand) {
    const ok2 = await cand.evaluate(() => !!document.querySelector('aside')).catch(() => false)
    if (ok2) main = cand
  }
}
await main.setViewportSize({ width: 1180, height: 780 }).catch(() => {})
await sleep(1000)

await main.evaluate(() => {
  const nav = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('設定'))
  nav?.click()
})
await sleep(1500)

const info = await main.evaluate(() => {
  const el = document.querySelector('input[type=range]')
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
    appearance: cs.appearance,
    outline: cs.outlineStyle,
    aria: el.getAttribute('aria-label')
  }
})
console.log('滑桿 computed:', JSON.stringify(info))

if (info) {
  await sleep(400)
  // pad 要小於 label 與 input 之間的 8px 間距(mb-2),否則上方的白色文字
  // 會被像素分析當成滑塊,量到一條 173x40 的「滑塊」。
  const pad = 6
  await main.screenshot({
    path: 'docs/audit/_slider.png',
    clip: {
      x: Math.max(0, info.x),
      y: Math.max(0, info.y - pad),
      width: Math.min(info.w, 400),
      height: info.h + pad * 2
    }
  })
  console.log(`已輸出 docs/audit/_slider.png (pad=${pad}, 軌道預期 y=${pad + 9}..${pad + 13})`)
}

await app.close()
process.exit(0)
