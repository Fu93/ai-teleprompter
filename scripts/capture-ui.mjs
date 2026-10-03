/**
 * capture-ui.mjs — 啟動 app 並擷取各頁面截圖,供 UI/UX 評估
 * 執行:node scripts/capture-ui.mjs(需先 npm run build)
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'fs'

const OUT = 'docs/screenshots'
mkdirSync(OUT, { recursive: true })

// 範例稿內容:與除錯面板及使用者首用的「載入範例講稿」共用同一份
// (見 src/renderer/src/lib/demoScript.ts)。標題留在這裡 —— 截圖要的是
// 一個示範用的場合名,而使用者自己的第一份稿不該被那個名字綁住。
// Node 直接匯入 .ts:與 audit-ui.mjs 匯入 domAudit.ts 同一條路。
import { DEMO_SCRIPT_CONTENT as DEMO_SCRIPT } from '../src/renderer/src/lib/demoScript.ts'

const app = await electron.launch({ args: ['.'], timeout: 60_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 視窗載入順序隨機,以 DOM 特徵辨識:主視窗有 <aside>,浮層有 .glass-overlay/.glass-pill
const isMainPage = (p) => p.evaluate(() => !!document.querySelector('aside')).catch(() => false)

let main = await app.firstWindow()
await main.waitForLoadState('domcontentloaded')
for (let i = 0; i < 15 && !(await isMainPage(main)); i++) {
  await sleep(700)
  const cand = app.windows().find((w) => w !== main)
  if (cand && (await isMainPage(cand))) main = cand
}
let overlay = app.windows().find((w) => w !== main && true)
for (let i = 0; i < 15 && !overlay; i++) {
  await sleep(700)
  overlay = app.windows().find((w) => w !== main)
}
console.log('windows resolved:', app.windows().length, 'main ok:', await isMainPage(main))
await main.waitForTimeout(600)

// 防呆:重置浮層狀態(前次執行可能留下 compact/lensMode/奇尺寸)
await main.evaluate(() =>
  window.api.setSettings({
    overlay: { compact: false, lensMode: false, width: 720, height: 260, displayMode: 'scroll' }
  })
)
await main.waitForTimeout(600)

// 1-5: 主視窗各頁
await main.screenshot({ path: `${OUT}/01-dashboard.png` })
const nav = [
  ['提詞講稿', '02-scripts'],
  ['錄音轉錄', '03-record'],
  ['面試練習', '04-practice'],
  ['設定', '05-settings']
]
for (const [label, name] of nav) {
  await main.click(`aside button:has-text("${label}")`)
  await main.waitForTimeout(700)
  await main.screenshot({ path: `${OUT}/${name}.png` })
}

// 6: 載入講稿 → 浮層
await main.evaluate((content) => window.api.overlayShow({ title: '產品發表 · 開場', content }), DEMO_SCRIPT)
await main.waitForTimeout(1500)
for (let i = 0; i < 15 && !overlay; i++) {
  await sleep(700)
  overlay = app.windows().find((w) => w !== main)
}
if (!overlay) {
  console.error('overlay window not found; windows:', app.windows().length)
  await app.close()
  process.exit(1)
}
await overlay.waitForLoadState('domcontentloaded')
await overlay.screenshot({ path: `${OUT}/06-overlay-scroll.png` })

// 播放 2 秒讓模式畫面有推進感
const play = overlay.locator('[title*="播放"]').first()
if (await play.count()) {
  await play.click().catch(() => {})
  await main.waitForTimeout(2000)
}

// 7-9: phrase / bullet / karaoke 模式
const modes = [
  ['phrase', '07-overlay-phrase'],
  ['bullet', '08-overlay-bullet'],
  ['karaoke', '09-overlay-karaoke']
]
for (const [mode, name] of modes) {
  await main.evaluate((m) => window.api.setSettings({ overlay: { displayMode: m } }), mode)
  await main.waitForTimeout(900)
  await overlay.screenshot({ path: `${OUT}/${name}.png` })
}

// 10: 藥丸模式 — 走真實點擊流程(收合會縮放視窗,展開會還原)
await overlay.locator('[title*="收合成藥丸"]').click()
await overlay.waitForTimeout(1500)
await overlay.screenshot({ path: `${OUT}/10-overlay-pill.png` })
await overlay.locator('[title*="展開完整面板"]').click()
await overlay.waitForTimeout(1500)

// 11: 貼鏡模式 — 窄條 + camera band
await overlay.locator('[title*="貼鏡模式"]').click()
await overlay.waitForTimeout(1500)
await overlay.screenshot({ path: `${OUT}/11-overlay-lens.png` })
await overlay.locator('[title*="退出貼鏡模式"]').click()
await main.waitForTimeout(800)
// 收尾:確保狀態沖刷(demo 留下 scroll 模式、正常尺寸)
await main.evaluate(() =>
  window.api.setSettings({
    overlay: { compact: false, lensMode: false, width: 720, height: 260, displayMode: 'scroll' }
  })
)
await main.waitForTimeout(1200)

console.log('captured:', OUT)
await app.close()
