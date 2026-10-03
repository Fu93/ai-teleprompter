// 專用量測:游標跟隨 specular 會不會在浮層邊緣產生白邊。
//
// 這是白邊調查唯一沒結案的項目。理由(純猜測,必須實測):
//   .glass-specular::after 是一個 rgba(255,255,255,0.14) 的 220px 徑向漸層,
//   中心跟隨游標(--spec-x/--spec-y),預設 --spec-y 是 0%,也就是游標在上緣時
//   漸層峰值正好落在視窗邊界。藥丸本身就是視窗,超出部分被裁掉 ——
//   跟先前 dynamic-island 光暈同一種失敗型態(峰值落在最外圈像素)。
//
// 做法:把游標停在 0% / 50% / 100% 三個高度,各截一張藥丸,
// 用 sharp 逐像素比較「邊緣列」與「內部列」的亮度。
// 邊緣比內部亮出一截 = 會看到白邊;差不多 = 沒問題。
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'fs'

mkdirSync('docs/audit/spec', { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({ args: ['.'], timeout: 60_000 })
let main = await app.firstWindow()
let overlay = null
await main.waitForLoadState('domcontentloaded')
for (let i = 0; i < 20; i++) {
  for (const w of app.windows()) {
    const hasAside = await w.evaluate(() => !!document.querySelector('aside')).catch(() => false)
    const hasBody = await w.evaluate(() => !!document.body).catch(() => false)
    if (hasAside) main = w
    else if (hasBody && !hasAside) overlay = w
  }
  if (overlay) break
  await sleep(400)
}
if (!overlay) { console.error('找不到浮層'); process.exit(1) }

// captureProtection 必須關掉,否則截圖只有背景
await main.evaluate(() => window.api.overlaySetCaptureProtection(false)).catch(() => {})
await main.evaluate(() => window.api.overlaySetClickThrough(false)).catch(() => {})
await sleep(300)
await main.evaluate(() => window.api.overlayShow({ title: '高光測試', content: '這是一段測試用的提詞文字' })).catch(() => {})
await sleep(1500)

// 切到藥丸
await overlay.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('title') || '').includes('收合成藥丸'))
  b?.click()
}).catch(() => {})
await sleep(1500)

const pill = await overlay.evaluate(() => {
  const el = document.querySelector('.glass-specular')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
if (!pill) { console.error('找不到藥丸元素'); await app.close(); process.exit(1) }
console.log(`藥丸: ${Math.round(pill.w)}x${Math.round(pill.h)} @ (${Math.round(pill.x)},${Math.round(pill.y)})`)

for (const [name, fx, fy] of [['top', 0.5, 0.0], ['mid', 0.5, 0.5], ['bottom', 0.5, 1.0]]) {
  await overlay.evaluate(({ fx, fy }) => {
    const el = document.querySelector('.glass-specular')
    el.style.setProperty('--spec-x', `${fx * 100}%`)
    el.style.setProperty('--spec-y', `${fy * 100}%`)
    el.style.setProperty('--spec-o', '1')
  }, { fx, fy })
  await sleep(700)
  await overlay.screenshot({
    path: `docs/audit/spec/pill-${name}.png`,
    clip: { x: pill.x, y: pill.y, width: pill.w, height: pill.h }
  })
  // 關閉高光,量同一張圖當基準
  await overlay.evaluate(() => document.querySelector('.glass-specular').style.setProperty('--spec-o', '0'))
  await sleep(700)
  await overlay.screenshot({
    path: `docs/audit/spec/pill-${name}-off.png`,
    clip: { x: pill.x, y: pill.y, width: pill.w, height: pill.h }
  })
  console.log(`已輸出 pill-${name}.png / pill-${name}-off.png`)
}

await app.close()
process.exit(0)
