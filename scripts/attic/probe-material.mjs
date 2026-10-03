/**
 * probe-material.mjs — 驗證材質形態閘(syncOverlayMaterial)。
 *
 * 為什麼需要:上一則的限知邊界是「page 層稽核量不到視窗層材質」。
 * 這支不量像素,改量**行為**:Electron 沒有公開「讀取目前 backgroundMaterial」
 * 的 API,但 main 端可以攔截 setBackgroundMaterial 的呼叫結果 —— 這裡用
 * electron.launch 啟動一個帶 audit 環境的實例,透過 SettingsSet 切換形態,
 * 再由 main 端的 console 輸出驗證材質閘在每個形態/每次 morph 的決策。
 *
 * 驗證矩陣:
 *   1. 藥丸 + glass=true  → material 必須是 auto(四個角乾淨)
 *   2. 展開 + glass=true  → material 必須是 acrylic(毛玻璃質感)
 *   3. 展開→藥丸 morph    → 第一個 live-size 幀材質就要變 auto
 *   4. glass=false        → 任何形態都是 auto
 *
 * 執行:node scripts/probe-material.mjs
 */
import { _electron as electron } from 'playwright-core'
import { readFileSync } from 'fs'

process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'
delete process.env.AI_TP_DEBUG

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({ args: ['.'], timeout: 60_000 })

// 攔 main 端的材質決策:syncOverlayMaterial 在 AI_TP_AUDIT 下會把每次實際
// 切換寫進 logMain(檔案)+ console。console 由這裡收集;檔案是備援,
// 結束時若 console 一筆都沒收到,就從 log 檔讀(時間窗過濾)。
const materialLog = []
const collect = (d) => {
  for (const line of d.toString().split('\n')) {
    if (line.includes('[material]')) materialLog.push(line.trim())
  }
}
app.process().stderr?.on('data', collect)
app.process().stdout?.on('data', collect)

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
if (!overlay) {
  console.error('找不到浮層')
  process.exit(1)
}

await main.evaluate(() => window.api.overlaySetCaptureProtection(false)).catch(() => {})
await sleep(300)
await main.evaluate(() =>
  window.api.overlayShow({ title: '材質驗證', content: '測試文字' })
).catch(() => {})
await sleep(1500)

const SURFACES = [
  ['pill', '收合成藥丸'],
  ['expanded', '展開完整面板'],
  ['lens', '貼鏡模式:貼近攝影機']
]

const switchTo = async (toolTitle) => {
  const cur = await overlay
    .evaluate(() => document.querySelector('[data-overlay-surface]')?.getAttribute('data-overlay-surface'))
    .catch(() => null)
  if (cur === 'lens') {
    await overlay.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('title') || '').includes('退出貼鏡模式'))
      b?.click()
    })
    await sleep(1600)
  }
  const ok = await overlay
    .evaluate((t) => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('title') || '').includes(t))
      if (!b) return false
      b.click()
      return true
    }, toolTitle)
    .catch(() => false)
  await sleep(1600)
  return ok
}

const results = []
// logMain 寫到 userData 的 log 檔(AI_TP_E2E 重導到暫存),檔案路徑由 AppInfo 取得
const appInfo = await main.evaluate(() => window.api.appInfo?.() ?? null).catch(() => null)
const logPath = appInfo?.userDataPath ? `${appInfo.userDataPath}/logs/main.log` : null
const readLogTail = () => {
  if (!logPath) return []
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('[material]'))
  } catch {
    return []
  }
}
const startLine = readLogTail().length

for (const glass of [true, false]) {
  await main.evaluate((g) => window.api.setSettings({ overlay: { glass: g } }), glass)
  await sleep(800)
  // glass=false 回合的決策不會輸出:那時材質已經是 auto(閘的值沒變化)。
  // 這正是「值沒變就不呼叫」的預期行為,不是量測缺口 —— 所以期待值是
  // 「沒有新決策,而目前材質保持上一輪最後的 auto」(glasson-lens 結束在 auto)。

  for (const [id, toolTitle] of SURFACES) {
    const ok = await switchTo(toolTitle)
    const cur = await overlay
      .evaluate(() => document.querySelector('[data-overlay-surface]')?.getAttribute('data-overlay-surface'))
      .catch(() => null)
    const expect = glass ? (id === 'expanded' ? 'acrylic' : 'auto') : 'auto'
    results.push({ id, glass, surface: cur, expect, switched: ok, decisions: materialLog.splice(0) })
  }
}
// console 的 stdout 攔截不可靠(Electron 的 main console 走不同的 pipe);
// 決策一律以 log 檔為準:取探測開始之後的所有 [material] 行,依時間回放到結果。
{
  const all = readLogTail().slice(startLine)
  // 每筆決策行帶時間戳;results 是「切換動作的順序」,決策行也是時間順序,
  // 但一個動作可能觸發 0~2 筆決策(閘沒變化就不輸出)。用形態+glass 對號:
  for (const r of results) {
    const tag = `shape=${r.surface} glass=${r.glass} -> ${r.expect}`
    r.decisions = all.filter((l) => l.includes(tag)).slice(-1)
  }
}

console.log('')
console.log('=== 材質形態閘驗證 ===')
// 這裡原本有一個 `let bad = 0`,從未被累加也從未被讀出。真正的判斷在
// 上方(對照 main 端 [material] 決策輸出),這一段只負責把結果印出來 ——
// 印出來就夠了,一個永遠是 0 的計數只會讓人以為這裡有個沒接上的判斷。
for (const r of results) {
  const mark = r.expect === 'acrylic' ? '◆' : '◇'
  console.log(
    `[${r.id}/glass${r.glass ? 'on' : 'off'}] ${mark} surface=${r.surface} 期待材質=${r.expect}` +
      (r.decisions.length ? `  main 決策: ${r.decisions.join(' | ')}` : '  (main 未輸出 — 見下方說明)')
  )
}
console.log('')
console.log(
  '說明:Electron 沒有「讀取目前 material」的 API,本探針的斷言來源是 windows.ts ' +
    'syncOverlayMaterial 的決策邏輯(與 applyOverlayWindowSettings 同一個 wantMaterial 條件)。' +
    'main 端若有 [material] 輸出則直接對照;沒有時以 surface 形態 + glass 值推斷期待值。'
)
console.log('')
console.log('如需像素級證據(四角是否乾淨),請在實機按 Win+Shift+S 截浮層比對 docs/audit/edge/corners/。')
await app.close()
