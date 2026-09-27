/**
 * capture-ui.mjs — 啟動 app 並擷取各頁面截圖,供 UI/UX 評估
 * 執行:node scripts/capture-ui.mjs(需先 npm run build)
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'fs'

const OUT = 'docs/screenshots'
mkdirSync(OUT, { recursive: true })

const DEMO_SCRIPT = `各位好,今天要向大家介紹我們的新產品 Flow。
首先,為什麼我們要做這件事?因為每場重要對話,你都只有一次機會。
接下來三個重點:第一,市場痛點;第二,我們的解法;第三,為什麼是現在。
市場痛點很簡單——資訊不對等。會議中你可能在想上一句話,就已經錯過下一句。
我們的解法是即時的語意追蹤與提示,像副駕駛一樣安靜地幫你補位。
為什麼是現在?因為本地語音模型剛好跨越了延遲的門檻。
總結一句話:我們不是取代你的注意力,而是保護它。
謝謝大家,接下來是實機示範。`

const app = await electron.launch({ args: ['.'], timeout: 60_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 視窗載入順序隨機,以 DOM 特徵辨識:主視窗有 <aside>,浮層有 .glass-overlay/.glass-pill
const isMainPage = (p) => p.evaluate(() => !!document.querySelector('aside')).catch(() => false)
const isOverlayPage = (p) =>
  p.evaluate(() => !!document.querySelector('.glass-overlay, .glass-pill')).catch(() => false)

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

console.log('captured:', OUT)
await app.close()
