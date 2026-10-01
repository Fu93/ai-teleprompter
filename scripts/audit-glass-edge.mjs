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
import { CORNER_TOL_PX, cornerScan } from './lib/corner-scan.mjs'

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

/**
 * 一條剖面線的判定。
 *
 * **量測位置改過一次,這是重點。** 舊版只看最外 2px,並把 2~5px 當作「參考基準」
 * (`hard = edge / near`)。而實際缺陷恰好在那個「基準」裡:.lg-rim::after 是
 * 「1.5px 暗環 + 上緣輪廓光」兩段相鄰的 inset box-shadow,量出來是
 * `[40,39,38, 80,78,76]` —— 外緣 2px 是**暗的**(39,過 EDGE_CAP),
 * 亮帶在 3~5px(80,而 80 **已經超過 EDGE_CAP=70**)。
 * 舊版於是報「全部通過」:它量的是暗環,而把亮帶當成「邊緣不得超過的基準」。
 *
 * 現在改成:取最外 6 device px(在 2x DPI 下正好是暗環 + 亮帶)的**最大值**,
 * 與內部比較 —— 那就是使用者看到的「白邊」的全部。
 *
 * 為什麼 6 而不是 2:2px 落在暗環裡,量不到亮帶。為什麼是 max 而不是 mean:
 * 缺陷是一條窄帶,取平均會被同一帶裡的暗像素拉回來。
 *
 * dip(暗環深度)只記錄不判定 —— 暗環是刻意的,它的職責是壓住白桌布上的外洩
 * (見 global.css 的 .lg-rim 註解)。把它判成缺陷會逼人移除一個正確的設計。
 */
const BAND_PX = 6

function summarize(line) {
  const edge = avg(line.slice(0, 2))
  const inner = innerOf(line)
  const band = line.slice(0, BAND_PX)
  const bmax = Math.max(...band)
  const bmin = Math.min(...band)
  return {
    edge,
    inner,
    /** 帶內最亮 vs 內部。這是「白邊」的可斷言量。 */
    lift: bmax / inner,
    /** 帶內最暗 vs 內部。只記錄。 */
    dip: inner / bmin,
    bandMax: bmax,
    band: band.map((v) => Math.round(v))
  }
}

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length
/** 取中間 30% 當「內部」,避開任何邊緣效應 */
const innerOf = (a) => avg(a.slice(Math.floor(a.length * 0.35), Math.ceil(a.length * 0.65)))

// 四角幾何量測在 scripts/lib/corner-scan.mjs:抽出來是為了讓負向驗證能用
// 合成 PNG 直接跑(見 scripts/lib/__tests__/corner-scan.test.mjs),
// 不必為了驗證量測端而啟動整個 App。容差 CORNER_TOL_PX = 4 device px,
// 涵蓋 antialias + rim 暗環 + 折射合計 1–2px 的偏移,同時仍抓得住
// 「角被填成方形」(實測方角首材質 ≤ 2px)與半徑對半縮水(7 vs 14)。

const results = []
const BACKDROPS = [
  ['dark', '#0b0d12'],
  ['white', '#ffffff'],
  // 中灰是**新增**的,而它不是湊數:藥丸的底色是 rgba(8,10,16,0.78),
  // 深色桌布上內部只有 11,於是 rim 的相對亮度被放大(實測深底 lift 2.87、
  // 白底只有 1.24)。只測純白桌布會漏掉最嚴重的那一種;純白是白邊的傳統
  // 測試場,但這個缺陷的嚴重程度取決於底色與桌布的對比,不是桌布本身多白。
  ['gray', '#808080']
]
/** 邊緣亮度上限(0-255)。真正的白邊是 150+ 的刺眼亮線。 */
const EDGE_CAP = 70
/**
 * 帶內最亮不得比內部亮超過這個倍數。**分形態兩個門檻。**
 *
 * 設計原則(就是這次修改的依據):rim 的強度應該跟著**曲率**走。
 *   - 膠囊(長寬比 > 6):上下兩條直邊合起來佔輪廓的 85%(272/320),
 *     沿著它們畫 rim 等於在整個形狀最長的地方畫最重的線 —— 那就是
 *     「有白邊的圓角長方形」。所以膠囊的直邊必須是平的。
 *   - 面板:直邊本來就是它的輪廓(大面板的邊就是一條直線),帶一點 rim 是
 *     正確的材質表現。
 *
 * 實測值(全部來自像素量測):
 *   藥丸 修前 深底 2.87 / 白底 1.24
 *   藥丸 只改底色、沒加遮罩 深底 1.75  ← 這就是遮罩該抓的東西
 *   藥丸 修後 三種桌布 1.00,弧上 1.03~1.19
 *   展開/貼鏡 深底 1.57 / 白底 1.18 / 中灰 1.27
 *
 * 1.25 與 1.75 之間有 40% 餘裕,而藥丸弧上實測最高 1.19 也在門檻內 ——
 * 也就是「弧上可以有 rim、直邊不行」這條規則是被量出來的,不是設定出來的。
 */
const RIM_LIFT_CAP_CAPSULE = 1.25
const RIM_LIFT_CAP_PANEL = 1.8
/**
 * 絕對下限:差不到這個亮度級數就不算缺陷。
 *
 * 為什麼需要:`lift` 是比值,而內部很暗時(純黑桌布)比值會被雜訊放大 ——
 * 內部 8、帶內 12 是 1.5 倍,但那 4 級肉眼看不到。沒有這條下限,
 * 深色桌布上的藥丸弧會因為 1 級雜訊而紅燈。
 */
const RIM_LIFT_MIN_ABS = 6

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
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    // 半徑取左上角宣告值(三個形態四角等值):膠囊 rounded-full 在 computed style
    // 是 9999px,cornerScan 會按 CSS 規則把它夾到 min(w,h)/2。
    const radiusCss = parseFloat(cs.borderTopLeftRadius) || 0
    return { x: r.x, y: r.y, w: r.width, h: r.height, radiusCss }
  })
  if (!box) {
    results.push({ id, status: 'element-not-found', ratio: null })
    continue
  }
  const cornerRadiusCss = box.radiusCss

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
    // 角落幾何只在白桌布那輪判定:深/灰桌布上材質與背景的對比天生不足以
    // 分辨「被切掉的角」和「材質」,cornerScan 會量不到東西。白桌布上
    // 深玻璃(≈64)vs 255 的對比充裕,且這正是幾何缺陷最會現形的背景。
    let corners = null
    if (bgName === 'white') {
      corners = await cornerScan(file, box, cornerRadiusCss)
    }
    const w = p.width
    const h = p.height
    const sides = {
      上: summarize(p.top),
      下: summarize(p.bottom),
      左: summarize(p.left),
      右: summarize(p.right)
    }
    // 四邊都判。舊版對膠囊只判上下(「左右兩端是半圓」),那是因為 rim 當時
    // 對整圈一視同仁,而上下直邊才是缺陷所在。現在 rim 已經被遮罩限制在兩端
    // 的弧上 —— 弧上的 rim 是**設計**,所以它必須被量,不能被排除。
    const isCapsule = h > 0 && w / h > 6
    const cap = isCapsule ? RIM_LIFT_CAP_CAPSULE : RIM_LIFT_CAP_PANEL
    const judged = sides
    const worstEdge = Math.max(...Object.values(judged).map((s) => s.edge))
    // 同時要滿足「比值超過門檻」與「絕對差夠大」才判失敗(理由見 RIM_LIFT_MIN_ABS)
    const offenders = Object.entries(judged)
      .filter(([, s]) => s.lift >= cap && s.bandMax - s.inner >= RIM_LIFT_MIN_ABS)
      .map(([k]) => k)
    const worstLift = Math.max(...Object.values(judged).map((s) => s.lift))
    const pass = worstEdge < EDGE_CAP && offenders.length === 0 && (corners === null || corners.pass)

    results.push({
      id,
      bg: bgName,
      status: pass ? 'pass' : 'FAIL',
      shape: isCapsule ? '膠囊' : '圓角矩形',
      cap,
      worstEdge,
      worstLift,
      offenders,
      sides,
      judged,
      corners,
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
console.log(
  `通過條件:最外 2px 亮度 < ${EDGE_CAP}/255,且最外 ${BAND_PX}px 的最大值 < 內部的 ${RIM_LIFT_CAP_CAPSULE}x(膠囊) / ${RIM_LIFT_CAP_PANEL}x(面板),且絕對差 < ${RIM_LIFT_MIN_ABS} 級;白桌布輪另驗四角:對角首材質距離 = 宣告半徑 × (1−1/√2) × dpr ± ${CORNER_TOL_PX}px`
)
console.log('量測方式:在每條邊的中點取一條垂直於邊界的掃線,四邊都列入判斷;四角另沿 45° 對角線掃(只在白桌布,幾何缺陷在那裡最會現形)')
console.log('為什麼量 6px:缺陷是「1.5px 暗環 + 輪廓光」兩段相鄰的 inset 陰影,亮帶落在 3~5px。舊版只量最外 2px 而把 3~5px 當基準,於是把缺陷當成了參考值(見 summarize 的註解)')
console.log('為什麼分兩個門檻:rim 應該跟著曲率走。膠囊的直邊佔輪廓 85%,在上面畫 rim 就是白邊;面板的邊本來就該有 rim。理由與實測值見 RIM_LIFT_CAP_CAPSULE 的註解')
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
    .map(([k, s]) => `${k}邊 lift ${s.lift.toFixed(2)}x [${s.band.join(',')}] 內${Math.round(s.inner)}`)
    .join('  ')
  const cornerDetail =
    r.corners && r.corners.firsts
      ? `  四角 ${r.corners.firsts.join('/')}px 理論${r.corners.theory}px${r.corners.pass ? '' : ' ← 角落幾何不符(方角?半徑被吃掉?)'}`
      : ''
  const why =
    r.status === 'pass'
      ? ''
      : r.worstEdge >= EDGE_CAP
        ? ' 超出絕對上限'
        : r.corners && !r.corners.pass
          ? ' 角落幾何不符'
          : ` 有硬亮帶:${r.offenders.join('')} >${r.cap}x 且差 ${RIM_LIFT_MIN_ABS} 級以上`
  console.log(`[${r.id}/${r.bg}] ${mark} ${r.shape} ${r.size}  ${detail}${cornerDetail}${why}`)
  if (r.status !== 'pass') failed++
}
console.log('')
console.log(
  failed === 0
    ? `全部通過:最外 ${BAND_PX}px 沒有畫出白框,且四角都遵守宣告的半徑 —— 膠囊的 rim 只在弧上,面板的 rim 在閱讀門檻內。`
    : `${failed} 項未通過 —— 我改壞了,必須修到過。`
)
writeFileSync(join2(OUT, 'report.json'), JSON.stringify(results, null, 2))
console.log(`輸出: ${OUT}/`)
await app.close()
process.exit(failed === 0 ? 0 : 1)
