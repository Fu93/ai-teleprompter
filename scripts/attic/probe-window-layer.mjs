/**
 * probe-window-layer.mjs — 視窗層到底畫了什麼?(OS 層,合成後的桌面)
 *
 * 為什麼需要這支:
 *   所有 audit:* 都是 Playwright 對 **page** 截圖。`transparent: true` 的浮層
 *   還有一層頁面之外的合成(webContents 底色、DWM 背景材質、視窗邊框),
 *   page 截圖對它天生是盲的。實測案例:setBackgroundMaterial('acrylic') 是畫在
 *   **視窗矩形**上的材質,展開面板是圓角矩形 → 四個角各露出一塊方形補丁,
 *   而所有頁面層的角落斷言當時全綠(見 docs/AUDIT_BLINDSPOTS.md 盲區 4)。
 *
 * 前任 probe-desktop.mjs 為什麼看不到:它拿 CSS px 去量裝置 px 的桌面點陣圖
 *   (本機 200% DPI),量的是桌布對桌布;而且它的「全透明」判定寫反了
 *   (alpha 平均 0 被判成「有內容」)。這支把兩個錯都修掉。
 *
 * 量測法(不依賴猜座標,也不依賴桌布顏色):
 *   A1 = 浮層正常顯示; B = 把 UI 藏起來(#root visibility:hidden,保留 App 的
 *   行內透明設定);C = 把**視窗隱藏**(hide(),不是搬走)。三張都是整台桌面。
 *   為什麼是「隱藏」而不是「搬走」:搬走的視窗會落在比較區域上(展開視窗寬
 *   1440 裝置 px,搬 1200 反而壓住左半邊)—— 第一次用搬走寫的版本就是這樣
 *   量出假陽性的 48%。
 *     - |A1 − C| 在視窗矩形內的比例 ≈ 100%  → 頁面確實在畫(量測有效性檢查)
 *     - |B − C| 在視窗矩形內的比例 → **視窗層自己畫的東西**。去背正常時,
 *       B 的那塊區域就是 C 的同一塊桌面(只剩桌布自己的變動),比例應該接近 0。
 *   角落另外印出差分圖:視窗層若在畫矩形,四個角會是實心的方角。
 *
 * 已知限制(誠實寫在前面):
 *   - 桌布上有動態內容(別的 App 視窗)時,|B − C| 會有基線雜訊;判讀看的是
 *     「比例」與「角落差分圖是不是實心方角」,不是單一像素。
 *   - 擷取範圍是 PowerShell 看到的虛擬螢幕(本機為 2720×900 裝置 px);展開
 *     面板的底部可能被切掉,腳本會把「視窗是否完整落在擷取範圍內」印出來。
 *   - 這不是閘門:它需要真實桌面、無法在 CI 穩定重現。要抓回歸,靠的是
 *     src/main/__tests__/overlayMaterial.test.ts(行為層)+ 這支(現象層)。
 *   - 「頁面全透明」那一列是數值,但真正的判讀標準是「接近 0」:桌布本身的動態
 *     內容會留下幾 % 的基線。這支在缺陷時期量到的是 95-100%(平均 165-227),
 *     修好後是 0%——兩者差一個數量級,不會認錯。
 *
 * 執行:node scripts/attic/probe-window-layer.mjs(需先 npm run build)
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import sharp from 'sharp'

process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'
delete process.env.AI_TP_DEBUG

const OUT = 'docs/audit/edge/window-layer'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ps(cmd) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    timeout: 30000,
    encoding: 'utf8'
  }).trim()
}

const [vw, vh] = ps(
  'Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; "$($b.Width),$($b.Height)"'
)
  .split(',')
  .map(Number)

/** 桌面擷取。多個語句用分號串成單行:直呼 powershell -Command 時,參數裡的
 *  換行會被 Windows 參數解析吃掉(兩個 Add-Type 被黏成一行 → 繫結錯誤)。 */
async function grabDesktop(file) {
  const winPath = file.replace(/\//g, '\\')
  const s = [
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    `$bmp = New-Object System.Drawing.Bitmap(${vw}, ${vh})`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)',
    '$g.Dispose()',
    `$bmp.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()'
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', s], { timeout: 30000 })
}

async function load(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const lum = (x, y) => {
    const xi = Math.max(0, Math.min(width - 1, Math.round(x)))
    const yi = Math.max(0, Math.min(height - 1, Math.round(y)))
    const i = (yi * width + xi) * channels
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }
  return { width, height, lum }
}

const T_COLLAPSE = String.fromCharCode(0x6536, 0x5408, 0x6210, 0x85e5, 0x4e38)
const T_EXPAND = String.fromCharCode(0x5c55, 0x958b, 0x5b8c, 0x6574, 0x9762, 0x677f)
const T_EXIT_LENS = String.fromCharCode(0x9000, 0x51fa, 0x8cbc, 0x93e1, 0x6a21, 0x5f0f)

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
if (!overlay) {
  console.error('找不到浮層')
  process.exit(1)
}
overlay.on('pageerror', (e) => console.error('[overlay pageerror]', e.message))

await main.evaluate(() => window.api.overlaySetCaptureProtection(false)).catch(() => {})
await main.evaluate(() => window.api.overlaySetClickThrough(false)).catch(() => {})
await sleep(400)
await main
  .evaluate(() => window.api.overlayShow({ title: '視窗層驗證', content: '這是一段用來驗證視窗層的測試文字。' }))
  .catch(() => {})
await sleep(1800)

const dpr = await overlay.evaluate(() => window.devicePixelRatio)
console.log(`devicePixelRatio=${dpr}  擷取範圍 ${vw}x${vh} 裝置 px`)

async function clickToolbar(needle) {
  return overlay
    .evaluate((t) => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        (x.getAttribute('title') || '').includes(t)
      )
      if (!b) return false
      b.click()
      return true
    }, needle)
    .catch(() => false)
}

async function hideUi(hidden) {
  await overlay.evaluate((h) => {
    const root = document.getElementById('root')
    if (root) root.style.visibility = h ? 'hidden' : ''
  }, hidden)
}

const start = await overlay.evaluate(() => ({ x: window.screenX, y: window.screenY }))
// 移到螢幕頂端:擷取範圍通常不含整個虛擬螢幕高度,展開面板才不會被切掉
await overlay.evaluate(() => window.moveTo(window.screenX, 0))
await sleep(600)

const SHAPES = [
  ['pill', T_COLLAPSE],
  ['expanded', T_EXPAND]
]
const results = []

for (const [id, title] of SHAPES) {
  const cur = await overlay
    .evaluate(() => document.querySelector('[data-overlay-surface]')?.getAttribute('data-overlay-surface'))
    .catch(() => null)
  if (cur === 'lens') {
    await clickToolbar(T_EXIT_LENS)
    await sleep(1500)
  }
  if (!(await clickToolbar(title))) {
    console.log(`[${id}] 找不到工具列按鈕 —— 跳過`)
    results.push({ id, status: 'switch-failed' })
    continue
  }
  await sleep(1500)

  const geo = await overlay.evaluate(() => ({
    x: window.screenX,
    y: window.screenY,
    w: window.innerWidth,
    h: window.innerHeight
  }))
  // 裝置 px:screenX/screenY 是 CSS px,桌面點陣圖是裝置 px(前任探測腳本
  // 就是在這裡混用,量到的是桌布對桌布)。
  const rect = { x: geo.x * dpr, y: geo.y * dpr, w: geo.w * dpr, h: geo.h * dpr }
  const fits = rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= vw && rect.y + rect.h <= vh
  console.log(
    `\n===== ${id} ===== 視窗矩形 ${rect.x},${rect.y} ${rect.w}x${rect.h} 裝置 px（完整落在擷取範圍內:${fits}）`
  )

  const a1 = `${OUT}/${id}-A1-visible.png`
  await grabDesktop(a1)
  await hideUi(true)
  await sleep(700)
  const b = `${OUT}/${id}-B-pageblank.png`
  await grabDesktop(b)
  await hideUi(false)
  await sleep(500)
  // C:同一塊桌面、但沒有視窗 —— 真值。用 hide() 而不是搬走:搬走會讓視窗
  // 落在比較區域上(展開視窗很寬),量到的是自己造成的假陽性。
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay'))
    w?.hide()
  })
  await sleep(800)
  const c = `${OUT}/${id}-C-window-hidden.png`
  await grabDesktop(c)
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay'))
    w?.showInactive()
  })
  await sleep(700)

  const imgA1 = await load(a1)
  const imgB = await load(b)
  const imgC = await load(c)

  const stats = (imgX, thr) => {
    let n = 0
    let sum = 0
    let max = 0
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const d = Math.abs(imgX.lum(rect.x + x, rect.y + y) - imgC.lum(rect.x + x, rect.y + y))
        if (d > thr) {
          n++
          if (x < x0) x0 = x
          if (y < y0) y0 = y
          if (x > x1) x1 = x
          if (y > y1) y1 = y
        }
        sum += d
        if (d > max) max = d
      }
    }
    const total = rect.w * rect.h
    return { changed: n, total, pct: Number(((n / total) * 100).toFixed(1)), mean: Number((sum / total).toFixed(2)), max: Math.round(max), bbox: x1 >= 0 ? { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null }
  }

  const pageVsGone = stats(imgA1, 6) // 頁面有沒有在畫(有效性檢查)
  const layerVsGone = stats(imgB, 6) // 視窗層有沒有在畫(要修的東西)
  console.log(`  頁面 vs 沒有視窗     : ${pageVsGone.pct}% 像素不同(平均 ${pageVsGone.mean})—— 應該很高,否則代表量測失效`)
  console.log(`  頁面全透明 vs 沒有視窗: ${layerVsGone.pct}% 像素不同(平均 ${layerVsGone.mean}、max ${layerVsGone.max})—— 去背正常應該接近 0`)

  // 角落差分圖:視窗層若在畫矩形,四角會是實心方角
  const map = (cx, cy, dx, dy) => {
    const lines = []
    for (let j = 0; j < 26; j++) {
      let line = ''
      for (let i = 0; i < 26; i++) {
        const d = Math.abs(
          imgB.lum(rect.x + (dx > 0 ? i : rect.w - 1 - i), rect.y + (dy > 0 ? j : rect.h - 1 - j)) -
            imgC.lum(rect.x + (dx > 0 ? i : rect.w - 1 - i), rect.y + (dy > 0 ? j : rect.h - 1 - j))
        )
        line += d > 6 ? '#' : d > 2 ? '+' : '.'
      }
      lines.push(line)
    }
    return lines
  }
  const corners = { tl: map(rect.x, rect.y, 1, 1), br: map(rect.x, rect.y, -1, -1) }
  for (const [name, lines] of Object.entries(corners)) {
    console.log(`  ${id}/${name} 差分圖（'#' = 視窗層在那些像素上畫了東西）:`)
    for (const l of lines) console.log('    |' + l + '|')
  }

  results.push({ id, rect, fits, pageVsGone, layerVsGone, corners })
}

await overlay.evaluate(({ x, y }) => window.moveTo(x, y), start)
await sleep(400)
writeFileSync(`${OUT}/report.json`, JSON.stringify({ dpr, capture: { vw, vh }, results }, null, 2))
console.log(`\n輸出: ${OUT}/`)
const worst = results.filter((r) => r.layerVsGone).sort((a, b) => b.layerVsGone.pct - a.layerVsGone.pct)[0]
console.log(
  worst && worst.layerVsGone.pct > 5
    ? `結論:視窗層在畫 —— ${worst.id} 的視窗矩形內有 ${worst.layerVsGone.pct}% 的像素在頁面全透明時仍與「沒有視窗」不同。`
    : '結論:視窗層沒有在畫任何東西(頁面全透明時,那塊桌面與視窗隱藏後一致)。'
)
await app.close()
