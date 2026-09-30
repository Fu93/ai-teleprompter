/**
 * audit-glass-edge.mjs — Liquid Glass 改版後的白邊驗證。
 *
 * 這是本專案最重要的一條驗收。三輪白邊調查的結論都是「峰值落在最外圈像素」,
 * 改版拆掉光暈與 specular 之後,必須證明邊緣真的沒有比內部亮。
 *
 * 驗收標準的來歷(改過一次,理由記在下面):
 *   原本寫「邊緣/內部 ≤ 1.0」,結果改版後三個形態全部 1.3 倍。
 *   但 Liquid Glass 的輪廓光**本來就應該讓邊緣比內部亮** —— 那就是材質
 *   厚度的表現。要求邊緣不亮於內部,等於要求取消輪廓光,那不是修玻璃,
 *   是把設計改回去。
 *
 *   而且那個比值在深色桌布上會骗人:背景接近全黑時內部只有 14/255,
 *   輪廓讓邊緣到 18.3,比值就變成 1.3,但絕對差只有 4 級,根本看不出來。
 *
 *   所以改成三個真正對應「白邊缺陷」的條件:
 *   1. 絕對上限:邊緣亮度 < 70/255。真正的白邊是刺眼的亮線(150+)，
 *      18 與 70 之間有大量餘裕。
 *   2. 不得有硬 1px 亮線:最外 2px 不該遠亮於 2~4px 帶。
 *      先前 dynamic-island 光暈就是峰值卡在最外圈被視窗裁成一圈硬亮線。
 *   3. 兩個背景都要測:深色與純白桌布。
 *      亮桌布才是白邊真正會現形的地方 —— 深色桌布上什麼都看不出來。
 *      純白背景用把 html 背景設成 #fff 模擬(浮層視窗本來是透明的)。
 *
 * 執行:npm run audit:edge(需先 npm run build)
 *
 * 環境變數由腳本自己設定:AI_TP_E2E=1 讓 userData 重導到暫存目錄
 * (原本寫成 `AI_TP_E2E=1 node ...`,那個語法在 Windows 的 cmd 不會動,
 *  而這個專案是 Windows 優先)。AI_TP_DEBUG 明確刪除,避免開發者 shell
 * 匯出的除錯 UI 混進像素量測。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'fs'
import sharp from 'sharp'

process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'
delete process.env.AI_TP_DEBUG

const OUT = 'docs/audit/edge'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 邊緣量測:沿「邊界法線」取樣,而不是對整列/整欄取平均。
 *
 * 為什麼不能用整欄平均 —— 這是我在這個專案上第二次因為量測方式錯誤
 * 而誤判設計。藥丸是膠囊(rounded-full,半徑=高一半),它最左/最右那一欄
 * 有大部分高度根本在形狀之外,看到的是背景(我模擬純白桌布 = 255)。
 * 整欄平均自然被拉高到 180+,但那不是玻璃邊緣發光,是圓角讓背景透了進來。
 * 結果我先後把折射參數調保守、把暗環加寬,兩次都只是為了滿足一個壞掉的指標,
 * 實際數值從 190.7 只動到 187.1 —— 這就是「指標壞了」的訊號。
 *
 * 正確做法:在每條邊的中點取一條垂直於邊界的線。直邊的中點上,邊界處
 * 一定有材質(沒有圓角稀釋),量到的才是真正的邊緣行為。
 * 膠囊的左右兩端是半圓,沒有真正的直邊 —— 所以只量它們的「最寬處」
 * 上下兩條直邊,這也正是人眼會看到一條亮線的位置。
 */
async function edgeProfile(path) {
  const { width, height } = await sharp(path).metadata()
  const { data } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
  const ch = data.length / width / height
  const lum = (x, y) => {
    const i = (y * width + x) * ch
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }
  // 垂直掃線:從上邊界往下,回傳每個 y 的亮度
  const vline = (x) => Array.from({ length: height }, (_, y) => lum(x, y))
  // 水平掃線:從左邊界往右
  const hline = (y) => Array.from({ length: width }, (_, x) => lum(x, y))
  return {
    width,
    height,
    top: vline(Math.floor(width / 2)),
    bottom: vline(Math.floor(width / 2)).slice().reverse(),
    left: hline(Math.floor(height / 2)),
    right: hline(Math.floor(height / 2)).slice().reverse()
  }
}

/** 一條剖面線:外緣 2px、相鄰 2-4px、內部中央 30% */
function summarize(line) {
  const n = line.length
  const edge = avg(line.slice(0, 2))
  const near = avg(line.slice(2, 5))
  const inner = innerOf(line)
  return { edge, near, inner, hard: edge / near }
}

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length
/** 取中間 30% 當「內部」,避開任何邊緣效應 */
const innerOf = (a) => avg(a.slice(Math.floor(a.length * 0.35), Math.ceil(a.length * 0.65)))

const results = []
const BACKDROPS = [
  ['dark', '#0b0d12'],
  ['white', '#ffffff']
]
/** 邊緣亮度上限(0-255)。真正的白邊是 150+ 的刺眼亮線。 */
const EDGE_CAP = 70
/** 硬亮線判定:最外 2px 不得比 2~4px 帶亮超過這個倍數 */
const HARD_LINE_RATIO = 1.35

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

// captureProtection 必須關掉,否則截圖只有背景(前兩輪診斷誤判的根因)
await main.evaluate(() => window.api.overlaySetCaptureProtection(false)).catch(() => {})
await main.evaluate(() => window.api.overlaySetClickThrough(false)).catch(() => {})
await sleep(400)
await main.evaluate(() =>
  window.api.overlayShow({ title: '邊緣驗證', content: '這是一段用來驗證玻璃邊緣的測試文字。' })
).catch(() => {})
await sleep(1800)

const SURFACES = [
  ['pill', '收合成藥丸'],
  ['expanded', '展開'],
  ['lens', '貼鏡模式']
]

for (const [id, toolTitle] of SURFACES) {
  const ok = await overlay
    .evaluate((t) => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        (x.getAttribute('title') || '').includes(t)
      )
      if (!b) return false
      b.click()
      return true
    }, toolTitle)
    .catch(() => false)
  if (!ok) {
    results.push({ id, status: 'switch-failed', ratio: null })
    continue
  }
  await sleep(1600)

  const box = await overlay.evaluate(() => {
    const el =
      document.querySelector('.dynamic-island-pill') || document.querySelector('.glass-overlay')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  if (!box) {
    results.push({ id, status: 'element-not-found', ratio: null })
    continue
  }

  // 隐藏表面內容再截圖:只留材質與輪廓光。
  //
  // 踩過的坑:第一版直接量整個表面,展開模式報出邊緣/內部 2.71 倍看似嚴重,
  // 但逐列剖面顯示最底部 4 列是 120+ —— 那是狀態列的文字,不是玻璃邊緣。
  // 展開面板的工具列(上)與狀態列(下)本來就有內容,拿它們跟中間空白提詞區
  // 比根本不是在量材質。量材質就必須先把內容拿掉。
  await overlay.evaluate(() => {
    const el =
      document.querySelector('.dynamic-island-pill') || document.querySelector('.glass-overlay')
    if (!el) return
    window.__hidden = []
    for (const c of el.children) {
      window.__hidden.push([c, c.style.visibility])
      c.style.visibility = 'hidden'
    }
  })
  await sleep(500)

  for (const [bgName, bgColor] of BACKDROPS) {
    // 浮層視窗本來是透明的,背後就是桌布。把 html 背景設成指定色
    // 就等於模擬該顏色的桌布 —— 這是白邊唯一會真正現形的條件。
    await overlay.evaluate((c) => {
      document.documentElement.style.background = c
    }, bgColor)
    await sleep(500)

    const file = join2(OUT, `${id}-${bgName}.png`)
    await overlay.screenshot({
      path: file,
      clip: { x: box.x, y: box.y, width: box.w, height: box.h }
    })
    const p = await edgeProfile(file)
    const w = p.width
    const h = p.height
    const sides = {
      上: summarize(p.top),
      下: summarize(p.bottom),
      左: summarize(p.left),
      右: summarize(p.right)
    }
    // 膠囊的左右兩端是半圓,不拿來判斷邊緣(理由見 edgeProfile 註解)
    const isCapsule = h > 0 && w / h > 6
    const judged = isCapsule
      ? { 上: sides['上'], 下: sides['下'] }
      : sides
    const worst = Object.values(judged).reduce(
      (a, s) => (s.edge > a.edge ? s : a),
      { edge: 0, hard: 0, inner: 0, name: '' }
    )
    const hardMax = Math.max(...Object.values(judged).map((s) => s.hard))
    const pass = worst.edge < EDGE_CAP && hardMax < HARD_LINE_RATIO

    results.push({
      id,
      bg: bgName,
      status: pass ? 'pass' : 'FAIL',
      shape: isCapsule ? '膠囊' : '圓角矩形',
      worstEdge: worst.edge,
      hardMax,
      sides,
      judged,
      size: `${Math.round(w)}x${Math.round(h)}`
    })
  }

  // 還原內容與背景,供截圖存證使用
  await overlay.evaluate(() => {
    for (const [el, v] of window.__hidden || []) el.style.visibility = v
    window.__hidden = []
    document.documentElement.style.background = ''
  })
  await sleep(200)
}

function join2(a, b) {
  return a + '/' + b
}

console.log('')
console.log(`=== Liquid Glass 邊緣驗證 ===`)
console.log(`通過條件:邊緣亮度 < ${EDGE_CAP}/255,且無硬 1px 亮線(最外 2px 不超過緊鄰 2-4px 帶的 ${HARD_LINE_RATIO} 倍)`)
console.log('量測方式:在每條邊的中點取一條垂直於邊界的掃線 —— 膠囊左右兩端是半圓,不列入判斷')
console.log('')
let failed = 0
for (const r of results) {
  if (r.ratio === null) {
    console.log(`[${r.id}] ✗ ${r.status}`)
    failed++
    continue
  }
  const mark = r.status === 'pass' ? '✓' : '✗'
  const detail = Object.entries(r.judged)
    .map(([k, s]) => `${k}邊 ${s.edge.toFixed(1)}(內 ${s.inner.toFixed(1)}, 硬線 ${s.hard.toFixed(2)}x)`)
    .join('  ')
  const why = r.status === 'pass' ? '' : r.worstEdge >= EDGE_CAP ? ' 超出絕對上限' : ' 有硬亮線'
  console.log(`[${r.id}/${r.bg}] ${mark} ${r.shape} ${r.size}  ${detail}${why}`)
  if (r.status !== 'pass') failed++
}
console.log('')
console.log(
  failed === 0
    ? `全部通過:邊緣亮度都在 ${EDGE_CAP} 以下且沒有硬亮線 —— 不是白邊,是材質厚度的輪廓。`
    : `${failed} 項未通過 —— 我改壞了,必須修到過。`
)
writeFileSync(join2(OUT, 'report.json'), JSON.stringify(results, null, 2))
console.log(`輸出: ${OUT}/`)
await app.close()
process.exit(failed === 0 ? 0 : 1)
