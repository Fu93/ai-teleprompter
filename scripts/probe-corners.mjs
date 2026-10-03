/**
 * probe-corners.mjs — 四個角的幾何探測:圓角真的存在嗎?
 *
 * 為什麼需要這支:
 *   audit-glass-edge 的掃線取在「四條邊的中點」,那是白邊(直邊亮帶)會現形的
 *   位置 —— 但它對四個角**完全沒有覆蓋**。使用者回報的「有邊角的長方形」
 *   有兩種可能成因,中點掃線對其中一種是盲的:
 *     1. 材質問題(rim 讓直邊讀成框)→ 中點掃線量得到,已修。
 *     2. 幾何問題(角根本沒被 border-radius 切掉,例如 Windows 的 acrylic
 *        backgroundMaterial 已知會讓 frameless 視窗失去圓角 — Electron
 *        issue #43075)→ 只有角落量得出來。
 *
 * 量測方式:
 *   在純白模擬桌布上截表面的 bounding box,從每個角落沿 45° 對角線往內掃,
 *   找第一個「材質」像素(與背景亮度差 > CORNER_CONTRAST)的距離 d。
 *   圓角半徑 r 的對角線邊界距離是解析解:d = r × (1 − 1/√2) ≈ 0.2929 r。
 *     藥丸 r = 24 CSS px(= h/2)→ 1.00×、2x DPI 下理論 ≈ 14 device px
 *     展開/貼鏡 r = 16 CSS px → 2x DPI 下理論 ≈ 9 device px
 *   同時記錄角點 (0,0) 亮度與 computed border-radius,兩種證據互相對照。
 *
 *   判讀:d ≈ 理論值 → 角真的被切掉(幾何正確);
 *         d ≤ 2 且角點是深色材質 → 方角,幾何被外層(視窗系統)吃掉。
 *   glass 開/關各跑一輪:glass 只影響 main 端的 setBackgroundMaterial('acrylic')
 *   與折射層,不改 CSS 幾何 —— 兩輪結果不同就是 acrylic 的鐵證。
 *
 * 執行:node scripts/probe-corners.mjs(需先 npm run build)
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'fs'
import sharp from 'sharp'

process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'
delete process.env.AI_TP_DEBUG

const OUT = 'docs/audit/edge/corners'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 與背景亮度差超過這個級數才算「材質」(白桌布 255 vs 深色玻璃 ~64,餘裕很大) */
const CORNER_CONTRAST = 40
/** 對角第一材質距離容許誤差(device px):涵蓋 rim 暗環與折射造成的 1~2px 偏移 */
const TOLERANCE_PX = 4

async function analyzeCorners(path) {
  // 解碼一次就好:原本這裡呼叫 sharp() 兩次(一次取寬高、一次取 buffer),
  // 等於把同一張圖讀兩遍。resolveWithObject 同時回傳 info 與 data。
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const ch = data.length / width / height
  const lum = (x, y) => {
    const i = (y * width + x) * ch
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }
  const bg = lum(width - 1, height - 1) // 右下角以外最遠處不可靠,用最後一角旁取背景 —— 改用四角中位數
  const cornerProbe = (cx, cy, dx, dy) => {
    const corner = Math.round(lum(cx, cy))
    const limit = Math.floor(Math.min(width, height) / 3)
    let first = -1
    for (let d = 0; d < limit; d++) {
      const x = Math.min(width - 1, cx + dx * d)
      const y = Math.min(height - 1, cy + dy * d)
      if (Math.abs(lum(x, y) - bg) > CORNER_CONTRAST) { first = d; break }
    }
    return { corner, first }
  }
  return {
    size: `${width}x${height}`,
    bg: Math.round(bg),
    corners: {
      左上: cornerProbe(0, 0, 1, 1),
      右上: cornerProbe(width - 1, 0, -1, 1),
      左下: cornerProbe(0, height - 1, 1, -1),
      右下: cornerProbe(width - 1, height - 1, -1, -1)
    }
  }
}

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

// switch-failed 時不能只留一個 false:把頁面當下長怎樣、有沒有丟錯印出來。
// 否則「按鈕不見了」和「evaluate 本身拋例外」看起來一模一樣。
overlay.on('pageerror', (err) => console.error('[overlay pageerror]', err.message))
overlay.on('console', (msg) => {
  if (msg.type() === 'error') console.error('[overlay console]', msg.text())
})
const dumpState = async () => {
  const state = await overlay
    .evaluate(() => ({
      url: location.href,
      buttons: Array.from(document.querySelectorAll('button')).map((b) => b.getAttribute('title')).filter(Boolean).slice(0, 12),
      surface: document.querySelector('[data-overlay-surface]')?.getAttribute('data-overlay-surface') ?? '(none)',
      bodyLen: document.body.innerHTML.length
    }))
    .catch((e) => ({ evaluateError: String(e) }))
  console.error('[overlay 狀態]', JSON.stringify(state))
}

await main.evaluate(() => window.api.overlaySetCaptureProtection(false)).catch(() => {})
await main.evaluate(() => window.api.overlaySetClickThrough(false)).catch(() => {})
await sleep(400)
await main.evaluate(() =>
  window.api.overlayShow({ title: '角落驗證', content: '這是一段用來驗證圓角幾何的測試文字。' })
).catch(() => {})
await sleep(1800)

const dpr = await overlay.evaluate(() => window.devicePixelRatio)
const SURFACES = [
  ['pill', '收合成藥丸', 24], // r = PILL_BASE.h/2
  ['expanded', '展開完整面板', 20], // .overlay-radius
  ['lens', '貼鏡模式:貼近攝影機', 20]
]

const results = []
for (const glass of [true, false]) {
  // glass 的 main 端效果 = setBackgroundMaterial('acrylic'|'auto');CSS 幾何不變。
  await main.evaluate((g) => window.api.setSettings({ overlay: { glass: g } }), glass)
  await sleep(1200)

  for (const [id, toolTitle, radiusCss] of SURFACES) {
    // 貼鏡先退出:目標形態的按鈕幾乎都在展開工具列裡,上一輪停在貼鏡的話
    // 整個回合會全部 switch-failed(第一輪實測就是這樣死的)。
    const cur = await overlay
      .evaluate(() => document.querySelector('[data-overlay-surface]')?.getAttribute('data-overlay-surface'))
      .catch(() => null)
    if (cur === 'lens') {
      await overlay.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) =>
          (x.getAttribute('title') || '').includes('退出貼鏡模式')
        )
        b?.click()
      })
      await sleep(1600)
    }
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
      console.error(`[switch-failed] ${id} glass=${glass} 找不到 title 含「${toolTitle}」的按鈕`)
      await dumpState()
      results.push({ id, glass, status: 'switch-failed' })
      continue
    }
    await sleep(1600)

    const info = await overlay.evaluate(() => {
      const el =
        document.querySelector('.dynamic-island-pill') || document.querySelector('.glass-overlay')
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        radius: cs.borderRadius,
        tl: cs.borderTopLeftRadius,
        box: { x: r.x, y: r.y, w: r.width, h: r.height }
      }
    })
    if (!info) {
      results.push({ id, glass, status: 'element-not-found' })
      continue
    }

    // 純白模擬桌布:角被切掉的話,角點就該是白
    await overlay.evaluate(() => {
      document.documentElement.style.background = '#ffffff'
    })
    await sleep(500)

    const file = `${OUT}/${id}-glass${glass ? 'on' : 'off'}.png`
    // 立即把對角線掃描的原始資料印出來:這支是探測工具,人要當場看細節,
    // 不能等 console 摘要(那裡只有分類結果)才知道量到什麼。
    console.log(`[${id}/glass${glass ? 'on' : 'off'}] radius=${info.radius} box=${info.box.w}x${info.box.h}`)
    await overlay.screenshot({
      path: file,
      clip: { x: info.box.x, y: info.box.y, width: info.box.w, height: info.box.h }
    })
    const analysis = await analyzeCorners(file)

    // 解析解:d = r × (1 − 1/√2),先 CSS px 再乘 dpr 成 device px
    // 斷言細節(每角首材質距離與角點亮度)直接印在探測行上,一目瞭然。
    const theoryDevice = radiusCss * (1 - 1 / Math.SQRT2) * dpr
    const firsts = Object.values(analysis.corners).map((c) => c.first)
    const minFirst = Math.min(...firsts)
    const cornerLums = Object.values(analysis.corners).map((c) => c.corner)
    const squareCorners = firsts.filter((d) => d >= 0 && d <= 2).length
    const roundedCorners = firsts.filter(
      (d) => Math.abs(d - theoryDevice) <= TOLERANCE_PX
    ).length
    let status
    if (roundedCorners === 4) status = 'round'
    else if (squareCorners >= 3) status = 'square'
    else status = 'mixed'
    // corner 值 −1 = 整條對角線都沒掃到材質(形狀與背景同色,不該發生)
    if (firsts.some((d) => d < 0)) status = 'no-material'

    results.push({
      id,
      glass,
      status,
      shape: id === 'pill' ? '膠囊' : '面板',
      cssRadius: info.radius,
      theoryDevice: Math.round(theoryDevice * 10) / 10,
      firsts,
      cornerLums,
      minFirst,
      squareCorners,
      roundedCorners,
      size: analysis.size,
      dpr,
      file
    })

    await overlay.evaluate(() => {
      document.documentElement.style.background = ''
    })
    await sleep(300)
  }
}

// 收尾:還原 glass 預設值(預設開),避免污染使用者設定
await main.evaluate(() => window.api.setSettings({ overlay: { glass: true } })).catch(() => {})

console.log('')
console.log('=== 四角幾何探測(白桌布,對角線掃到第一個材質像素) ===')
console.log(`理論距離 = r × (1 − 1/√2) ≈ 0.293 × r(device px,±${TOLERANCE_PX})`)
console.log('')
let bad = 0
for (const r of results) {
  if (r.status === 'switch-failed' || r.status === 'element-not-found') {
    console.log(`[${r.id}/glass${r.glass ? 'on' : 'off'}] ✗ ${r.status}`)
    bad++
    continue
  }
  const mark = r.status === 'round' ? '✓' : '✗'
  // corners 陣列在 analyzeCorners 回傳值上,results 只存了 firsts/cornerLums ——
  // 摘要列直接用那些扁平欄位,不再依賴巢狀 corners。
  const names = ['左上', '右上', '左下', '右下']
  const detail = (r.firsts ?? [])
    .map((d, i) => `${names[i]} ${d}px/${r.cornerLums[i]}`)
    .join('  ')
  const extra =
    r.status === 'square'
      ? ' ← 方角:視窗層(acrylic?)把圓角吃掉了'
      : r.status === 'mixed'
        ? ' ← 只有部分角被切掉'
        : r.status === 'no-material'
          ? ' ← 對角線上量不到材質'
          : ''
  console.log(
    `[${r.id}/glass${r.glass ? 'on' : 'off'}] ${mark} ${r.shape ?? ''} radius=${r.cssRadius} 理論≈${r.theoryDevice}px ${r.size}  ${detail}${extra}`
  )
  if (r.status !== 'round') bad++
}
console.log('')
console.log(
  bad === 0
    ? '全部四角都被 border-radius 正確切掉 —— 「有邊角的長方形」是材質/視覺問題,不是幾何。'
    : `${bad} 項角落呈方角 —— 幾何被視窗層吃掉,對照 glass on/off 找出責任層。`
)
writeFileSync(`${OUT}/corners.json`, JSON.stringify(results, null, 2))
console.log(`輸出: ${OUT}/`)
await app.close()
