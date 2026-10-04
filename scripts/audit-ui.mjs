/**
 * audit-ui.mjs — UI 稽核:逐頁截圖 + 收集執行期問題。
 *
 * 執行:npm run audit:ui   (需要先 npm run build)
 * 輸出:docs/audit/<page>.png、docs/audit/report.json
 *
 * 為什麼需要這支:
 *   憑印象找 UI bug 命中率很差。白邊問題前後猜錯兩次(先怪 DWM 邊框、
 *   再怪 acrylic),而真正原因只要一次正確量測就會浮現。與其繼續猜,
 *   不如把每頁能客觀判定的問題一次抓齊:console 錯誤、未捕獲例外、
 *   未處理 Promise、失敗請求、版面溢出、對比度、觸控目標、裁切、文字截斷。
 *
 * 環境變數由腳本自己設定(npm script 因此不必依賴 shell 的 `VAR=x cmd` 語法,
 * Windows 的 cmd 不支援那個寫法):
 *   AI_TP_E2E=1   userData 重導到暫存目錄(見 src/main/index.ts),
 *                 不會動到使用者的真實資料,也不會與已開啟的實例搶單一實例鎖。
 *   AI_TP_AUDIT=1 開啟「狀態強制橋」window.__auditForce(見 src/main/debug.ts)。
 *   AI_TP_DEBUG   明確刪除:若開發者的 shell 匯出過它,除錯面板會掛進 DOM,
 *                 而 DOM 稽核會把面板自己的小按鈕當成缺陷報出來。
 *
 * 頁面切換不再比對側欄文字:改用 __auditForce('app.navigate', id)。
 * 文字比對的失敗模式是靜默 no-op —— 找不到按鈕時畫面不變,而「這一頁沒問題」
 * 與「這一頁沒被量到」在截圖與報告上長得一模一樣。現在切換失敗會回報,
 * 而且六頁的截圖必須兩兩不同(同一個 hash 出現兩次 = 其中一次根本沒切過去)。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { domAudit, settleAnimations } from '../src/renderer/src/lib/domAudit.ts'
import { createReport, fileHash, guardSerializable } from './lib/audit-report.mjs'

// 稽核環境必須乾淨:見檔頭說明。
process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'
delete process.env.AI_TP_DEBUG

const OUT = 'docs/audit'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 頁面 id 對應 app.navigate 的參數,label 只用在報告裡 */
const PAGES = [
  ['dashboard', '總覽'],
  ['scripts', '提詞講稿'],
  ['record', '錄音轉錄'],
  ['practice', '面試練習'],
  ['calibration', '個人化校準'],
  ['settings', '設定']
]

/** 主視窗尺寸固定,否則各頁截圖尺寸不一,難以比較排版 */
const VIEWPORT = { width: 1180, height: 780 }

const report = createReport('audit-ui')

async function main() {
  // 序列化契約:domAudit 會被 page.evaluate 送進頁面,函式內不能有型別標註
  // 或模組層級識別字。讓它在啟動第一行就爆,而不是某一頁莫名 audit-failed。
  guardSerializable(settleAnimations, 'settleAnimations')
  const srcLen = guardSerializable(domAudit, 'domAudit')
  console.log(`domAudit 序列化檢查通過(${srcLen} 字元)`)

  const app = await electron.launch({ args: ['.'], timeout: 60_000 })

  // 視窗載入順序隨機,以 DOM 特徵辨識:主視窗有 <aside>
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
  await main.setViewportSize(VIEWPORT).catch(() => {})
  await sleep(1200)

  let current = 'boot'

  // 在頁面腳本裡裝攔截器,補抓 render process 內的未處理 rejection ——
  // pageerror 只涵蓋未捕獲例外,rejection 在 Playwright 沒有對應事件。
  await main.evaluate(() => {
    window.__auditRejections = []
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason
      window.__auditRejections.push(String(r && r.message ? r.message : r).slice(0, 200))
    })
  })

  main.on('console', (m) => {
    const t = m.type()
    if (t === 'error' || t === 'warning') {
      report.add(`console.${t}`, current, m.text().slice(0, 300))
    }
  })
  main.on('pageerror', (e) => {
    // 帶 stack:只有訊息時無法定位,實務上這類錯誤多在壓縮後的 bundle 裡,
    // 沒有 stack 就得反覆猜是哪個檔案。
    const stack = String(e && e.stack ? e.stack : e)
      .split('\n')
      .slice(0, 4)
      .join(' | ')
      .slice(0, 400)
    report.add('pageerror', current, stack)
  })
  main.on('requestfailed', (r) => {
    const f = r.failure()
    if (f && !/net::ERR_ABORTED/.test(f.errorText)) {
      report.add('requestfailed', current, `${r.url().slice(0, 140)} ${f.errorText}`)
    }
  })

  // 強制橋沒掛起來的話,後面每一個狀態都會失敗 —— 先講清楚,否則只會看到
  // 六頁「都一樣」而不知道原因。
  const bridge = await main
    .evaluate(() => typeof window.__auditForce === 'function')
    .catch(() => false)
  if (!bridge) report.unreached('boot', 'window.__auditForce 不存在(AI_TP_AUDIT 沒有生效?)')

  const hashes = new Map()

  for (const [id, label] of PAGES) {
    current = id
    const forced = await main
      .evaluate((pageId) => window.__auditForce?.('app.navigate', pageId) ?? { ok: false, names: [] }, id)
      .catch((e) => ({ ok: false, error: String(e) }))
    if (!forced.ok) {
      report.unreached(`${id}(${label})`, `導航沒有生效:${forced.error ?? '控制項未註冊'} 可用=${(forced.names || []).join(',')}`)
      continue
    }
    await sleep(1500)
    const shot = join(OUT, `${id}.png`)
    await main.screenshot({ path: shot }).catch(() => {})

    // 未處理 rejection:取出後清空,避免同一筆在每頁重複計數
    const rejections = await main.evaluate(() => {
      const r = window.__auditRejections || []
      window.__auditRejections = []
      return r
    })
    for (const r of rejections) report.add('unhandledrejection', current, r)

    // 版面跑版的直接徵兆
    const m = await main.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight
    }))
    if (m.sw > m.cw + 1) {
      report.add('overflow-x', current, `scrollWidth=${m.sw} > clientWidth=${m.cw}`)
    }
    if (m.sh > m.ch + 1) {
      report.add('overflow-y', current, `scrollHeight=${m.sh} > clientHeight=${m.ch}`)
    }

    // DOM 層的 UI/UX 檢查:比截圖可靠且能量化。
    // 規則實作是 src/renderer/src/lib/domAudit.ts,與 audit-deep.mjs 及
    // App 內建除錯面板的「稽核」分頁共用同一份。
    // 先讓有限次動畫跑完再量(理由見 domAudit.ts 的 settleAnimations)。
    await main.evaluate(settleAnimations).catch(() => {})
    const dom = await main.evaluate(domAudit)
    for (const d of dom) report.add(d.kind, current, d.text)

    // 六頁必須各自不同。相同 hash 代表有兩次導航其實停在同一頁。
    const hash = fileHash(shot)
    if (hash) {
      const prev = hashes.get(hash)
      if (prev) {
        report.unreached(`${id}(${label})`, `截圖與「${prev}」完全相同:導航沒有真的切換頁面`)
      } else {
        hashes.set(hash, `${id}(${label})`)
        report.measured(`${id}(${label})`)
      }
    } else {
      report.unreached(`${id}(${label})`, '截圖沒有產生,無法判定是否量測成功')
    }
  }

  const problems = report.finish(join(OUT, 'report.json'))
  console.log(`截圖: ${OUT}/`)
  await app.close()
  return problems
}

main()
  // 必須把問題數帶到 exit code。在這之前這裡是無條件 process.exit(0) ——
  // 意思是 `npm run audit` 抓到 50 筆問題在 CI 裡一樣是綠的。
  // 稽核的存在理由就是「紅燈要擋住人」,exit 0 等於那個理由不存在。
  .then((problems) => process.exit(problems.length ? 1 : 0))
  .catch((e) => {
    console.error('ABORT:', e.stack || e.message)
    process.exit(1)
  })
