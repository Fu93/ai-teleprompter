/**
 * probe-desktop.mjs — 「沒有去背」探測:量使用者桌面上真正看到的像素。
 *
 * 為什麼需要這支:
 *   之前的角落量測(probe-corners / audit:edge)全是 Playwright 對 page 的截圖,
 *   而且我們還把頁面背景塗白 —— 量的是「頁面畫了什麼」,不是「桌面看到什麼」。
 *   視窗層的合成(acrylic 材質、DWM 透明效果)只存在於 OS 層,page 截圖
 *   對它天生是盲的。使用者說「有沒有可能就是沒有去背」指的正是這一層:
 *     - glass: true(預設開)會 setBackgroundMaterial('acrylic'):
 *       acrylic 是視窗**矩形**的背後材質,頁面透明處(膠囊四角被切掉的地區)
 *       透出的是「毛玻璃」而不是桌布 → 四角變淺色磨砂補丁 → 看起來就是
 *       有邊角的長方形。
 *     - Windows「透明效果」關閉 / RDP / GPU 問題 → 透明區變不透明黑塊,
 *       整個視窗是實心矩形,連圓角都沒有。
 *
 * 量測方式:
 *   用 PowerShell System.Drawing CopyFromScreen 抓**合成後的桌面**(Blt),
 *   這是使用者眼睛真正看到的東西。量兩件事:
 *     1. 表面四個角(角點 3×3 平均)與「視窗外圍桌布」的亮度差:
 *        正常去背 → 角點 = 桌布(差 ≈ 0);沒去背 → 角點是材質/黑塊(差大)。
 *     2. **全透明測試**:讓頁面畫成全透明(body background: transparent +
 *        隱藏所有內容)。正常去背 → 桌面上視窗應該**整個消失**
 *        (視窗矩形與桌布差 ≈ 0);還看得到一塊矩形 → 那塊就是視窗層自己
 *        畫的東西(acrylic/黑塊),與頁面無關 —— 這就是「沒有去背」的鐵證。
 *
 *   矩陣:藥丸/展開 × glass on/off × 頁面正常/全透明,外加讀
 *   HKCU\...\Themes\Personalize\EnableTransparency 註冊表對照系統設定。
 *
 * 執行:node scripts/probe-desktop.mjs(需先 npm run build)
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import sharp from 'sharp'

process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'
delete process.env.AI_TP_DEBUG

const OUT = 'docs/audit/edge/desktop'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** OS 層桌面擷取:CopyFromScreen = 合成後的畫面(使用者看到的)。
 *  每個語句用分號隔開寫成**單行**:execFileSync 直呼 powershell -Command 時,
 *  參數內的換行會被 Windows 參數解析吃掉(兩個 Add-Type 被黏成一行 →
 *  「無法繫結參數,因為 'AssemblyName' 已被指定」),這是第一次執行就死的坑。 */
async function grabDesktop(file) {
  const winPath = file.replace(/\//g, '\\')
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)',
    '$g.Dispose()',
    `$bmp.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()'
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000 })
}

/** 讀系統透明效果設定(關閉時 DWM 不合成透明 → 一切去背失效)。 */
function readTransparency() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -ErrorAction Stop).EnableTransparency"],
      { timeout: 15000, encoding: 'utf8' }
    ).trim()
    return out === '1' ? 'on' : out === '0' ? 'off' : `unknown(${out})`
  } catch {
    return 'unknown'
  }
}

/** 在桌面截圖上量一個矩形:回傳四角(3×3 平均)、邊中點、內部、以及視窗外圍 8px 框的亮度。 */
async function measureRect(file, rect) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: ch } = info
  const lum = (x, y) => {
    const xi = Math.max(0, Math.min(W - 1, Math.round(x)))
    const yi = Math.max(0, Math.min(H - 1, Math.round(y)))
    const i = (yi * W + xi) * ch
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length
  const patch = (cx, cy, r = 2) => {
    const vals = []
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) vals.push(lum(cx + dx, cy + dy))
    return avg(vals)
  }
  // 視窗外圍:矩形往外 4~12px 的環(8 個採樣點),那就是「周圍桌布」
  const ring = []
  for (const [ox, oy] of [[-8, 0], [-4, 0], [rect.w + 8, 0], [rect.w + 4, 0], [0, -8], [0, -4], [0, rect.h + 8], [0, rect.h + 4]]) {
    ring.push(lum(rect.x + ox, rect.y + oy))
  }
  const m = Math.floor(rect.h / 2)
  return {
    corners: {
      左上: Math.round(patch(rect.x + 1, rect.y + 1)),
      右上: Math.round(patch(rect.x + rect.w - 1, rect.y + 1)),
      左下: Math.round(patch(rect.x + 1, rect.y + rect.h - 1)),
      右下: Math.round(patch(rect.x + rect.w - 1, rect.y + rect.h - 1))
    },
    edgeMid: Math.round(avg([patch(rect.x + rect.w / 2, rect.y + 1), patch(rect.x + rect.w / 2, rect.y + rect.h - 1), patch(rect.x + 1, rect.y + m), patch(rect.x + rect.w - 1, rect.y + m)])),
    inner: Math.round(patch(rect.x + rect.w / 2, rect.y + m, 6)),
    surround: Math.round(avg(ring))
  }
}

const sysTransparency = readTransparency()
console.log(`系統透明效果(EnableTransparency): ${sysTransparency}`)
if (sysTransparency === 'off') {
  console.log('⚠ 系統透明效果關閉:acrylic 與分層視窗的去背在 DWM 層就會失效,這本身就是「沒有去背」的候選成因。')
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

await main.evaluate(() => window.api.overlaySetCaptureProtection(false)).catch(() => {})
await main.evaluate(() => window.api.overlaySetClickThrough(false)).catch(() => {})
await sleep(400)
await main.evaluate(() =>
  window.api.overlayShow({ title: '桌面去背驗證', content: '這是一段用來驗證去背的測試文字。' })
).catch(() => {})
await sleep(1800)

/** 取視窗在「桌面座標」的矩形(CopyFromScreen 從 VirtualScreen 左上角起算)。 */
const desktopRect = async () => {
  const r = await overlay.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('title') || '').includes('收合成藥丸'))
    return null
  }).catch(() => null)
  void r
  const [vx, vy] = await overlay.evaluate(() => [window.screenX, window.screenY]).catch(() => [0, 0])
  const [w, h] = await overlay.evaluate(() => [window.innerWidth, window.innerHeight]).catch(() => [0, 0])
  const vs = await overlay.evaluate(() => ({
    sx: window.screen.availLeft ?? 0,
    sy: window.screen.availTop ?? 0
  })).catch(() => ({ sx: 0, sy: 0 }))
  // VirtualScreen 左上角可能不於主螢幕原點;CopyFromScreen 以 VirtualScreen 為 (0,0)。
  const virtual = await overlay.evaluate(() => {
    void 0
    return null
  }).catch(() => null)
  void virtual
  // screenX/screenY 已是「虛擬桌面座標」(與 CopyFromScreen 的基準一致,
  // 只要我們同時用 VirtualScreen 原點當截圖原點 —— 上面 PowerShell 正是這樣)。
  return { x: vx, y: vy, w, h, vs, virtual: null }
}

const SURFACES = [
  ['pill', '收合成藥丸'],
  ['expanded', '展開完整面板']
]

const results = []
for (const glass of [true, false]) {
  await main.evaluate((g) => window.api.setSettings({ overlay: { glass: g } }), glass)
  await sleep(1200)

  for (const [id, toolTitle] of SURFACES) {
    // 貼鏡先退出(按鈕只在展開工具列)
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
    if (!ok) {
      results.push({ id, glass, status: 'switch-failed' })
      continue
    }
    await sleep(1600)

    // 桌面座標 + page 座標兩份都要:page 截圖比對用
    const [vx, vy] = await overlay.evaluate(() => [window.screenX, window.screenY])
    const [ww, wh] = await overlay.evaluate(() => [window.innerWidth, window.innerHeight])

    for (const mode of ['normal', 'transparent']) {
      // transparent:把頁面畫成全透明 + 隱藏所有內容。
      // 去背正常 → 桌面上視窗應該完全消失;還有一塊可見 → 那是視窗層畫的。
      await overlay.evaluate((m) => {
        const doc = document
        if (m === 'transparent') {
          doc.documentElement.style.background = 'transparent'
          doc.body.style.background = 'transparent'
          doc.querySelectorAll('[data-overlay-surface], [data-overlay-card]').forEach((el) => {
            el.style.visibility = 'hidden'
          })
        } else {
          doc.documentElement.style.background = ''
          doc.body.style.background = ''
          doc.querySelectorAll('[data-overlay-surface], [data-overlay-card]').forEach((el) => {
            el.style.visibility = ''
          })
        }
      }, mode)
      await sleep(700)

      const shot = `${OUT}/${id}-glass${glass ? 'on' : 'off'}-${mode}.png`
      await grabDesktop(shot)
      const desk = await measureRect(shot, { x: vx, y: vy, w: ww, h: wh })
      // page 截圖(對照組):看頁面自己畫了什麼
      const pageShot = `${OUT}/${id}-page-${mode}.png`
      const pageBox = await overlay.evaluate(() => {
        const el = document.querySelector('[data-overlay-surface]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })
      let pageVisible = null
      if (pageBox && mode === 'transparent' && pageBox.w > 0) {
        await overlay.screenshot({
          path: pageShot,
          clip: { x: pageBox.x, y: pageBox.y, width: pageBox.w, height: pageBox.h }
        })
        const st = await sharp(pageShot).stats()
        // 全透明頁面 → 每個 channel 都該是 0(全透明像素在 PNG 裡 RGBA=0)
        pageVisible = st.channels[0].mean > 1 || st.channels[3].mean < 250
      }

      // 判讀:cornerSurroundDiff = 角點與周圍桌布的差。去背正常 ≈ 0;
      // 沒去背 = 材質(或黑塊)填滿視窗矩形 → 角點與桌布差很大。
      const cornerVals = Object.values(desk.corners)
      const maxCornerDiff = Math.max(...cornerVals.map((c) => Math.abs(c - desk.surround)))
      // transparent 模式的「整個視窗可見度」:視窗內部與桌布的差
      const wholeVisibleDiff = Math.abs(desk.inner - desk.surround)
      const verdict =
        mode === 'transparent'
          ? wholeVisibleDiff <= 6 && maxCornerDiff <= 6
            ? 'gone' // 視窗在桌面上消失了 = 去背正常
            : wholeVisibleDiff > 6
              ? 'opaque-window' // 整塊矩形可見 = 視窗層在畫東西
              : 'corners-opaque' // 只有角可見(部分去背失效)
          : maxCornerDiff <= 8
            ? 'corners-transparent'
            : cornerVals.every((c) => Math.abs(c - desk.inner) <= 8)
              ? 'corners-material' // 角點 = 內部材質 → 角被材質填滿
              : 'corners-mixed'
      results.push({
        id,
        glass,
        mode,
        status: 'ok',
        rect: { x: vx, y: vy, w: ww, h: wh },
        ...desk,
        maxCornerDiff: Math.round(maxCornerDiff),
        wholeVisibleDiff: Math.round(wholeVisibleDiff),
        pageVisible,
        verdict,
        shot
      })
    }

    await overlay.evaluate(() => {
      document.documentElement.style.background = ''
      document.body.style.background = ''
      document.querySelectorAll('[data-overlay-surface], [data-overlay-card]').forEach((el) => {
        el.style.visibility = ''
      })
    })
    await sleep(300)
  }
}

await main.evaluate(() => window.api.setSettings({ overlay: { glass: true } })).catch(() => {})

console.log('')
console.log('=== 桌面去背探測(OS 層 CopyFromScreen = 使用者看到的) ===')
console.log('')
let suspicious = 0
for (const r of results) {
  if (r.status !== 'ok') {
    console.log(`[${r.id}/glass${r.glass ? 'on' : 'off'}] ✗ ${r.status}`)
    suspicious++
    continue
  }
  const mark = r.mode === 'transparent' ? (r.verdict === 'gone' ? '✓' : '✗') : '·'
  const corners = Object.entries(r.corners).map(([k, v]) => `${k}${v}`).join(' ')
  console.log(
    `[${r.id}/glass${r.glass ? 'on' : 'off'}/${r.mode}] ${mark} 角[${corners}] 邊${r.edgeMid} 內${r.inner} 桌布${r.surround}` +
      ` 角差${r.maxCornerDiff} 整窗差${r.wholeVisibleDiff} → ${r.verdict}`
  )
  if (r.mode === 'transparent' && r.verdict !== 'gone') suspicious++
}
console.log('')
const opaqueWindows = results.filter((r) => r.mode === 'transparent' && r.verdict === 'opaque-window')
const cornersMaterial = results.filter((r) => r.mode === 'normal' && r.verdict === 'corners-material')
if (opaqueWindows.length) {
  console.log(`結論:沒有去背。${opaqueWindows.length} 個組合在「頁面全透明」時桌面上仍有一整塊可見矩形 —— 那是視窗層(acrylic/系統)畫的,與頁面無關。`)
  console.log('修法方向:glass 開啟時 acrylic 材質會填滿整個視窗矩形,而頁面只在膠囊形狀內畫材質 —— 兩層形狀不一致。見 probe 的 corners-material 列。')
} else if (cornersMaterial.length) {
  console.log(`結論:去背正常,但 ${cornersMaterial.length} 個組合的四角被材質填滿(角點 ≈ 內部)→ 視窗矩形可見但只在角落 —— 檢查 acrylic 與頁面形狀的差異。`)
} else {
  console.log('結論:去背正常 —— 頁面全透明時視窗在桌面上完全消失,四角也是桌布色。')
}
writeFileSync(`${OUT}/desktop.json`, JSON.stringify({ sysTransparency, results }, null, 2))
console.log(`輸出: ${OUT}/`)
await app.close()
