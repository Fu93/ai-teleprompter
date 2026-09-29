/**
 * audit-ui.mjs — UI 稽核:逐頁截圖 + 收集執行期問題。
 *
 * 執行:AI_TP_E2E=1 node scripts/audit-ui.mjs(需先 npm run build)
 * 輸出:docs/audit/<page>.png、docs/audit/report.json
 *
 * 為什麼需要這支:
 *   憑印象找 UI bug 命中率很差。白邊問題前後猜錯兩次(先怪 DWM 邊框、
 *   再怪 acrylic),而真正原因只要一次正確量測就會浮現。與其繼續猜,
 *   不如把每頁能客觀判定的問題一次抓齊:console 錯誤、未捕獲例外、
 *   未處理 Promise、失敗請求、版面溢出、對比度、觸控目標、裁切、文字截斷。
 *
 * 兩條檢查寫過一版後產生大量誤報,教訓記在各自的註解裡 —— 稽核工具本身
 * 的雜訊會淹掉真問題,寧可少抓也不要讓人開始懷疑整份報告。
 *
 * 隔離:以 AI_TP_E2E=1 啟動,userData 會被重導到暫存目錄
 * (見 src/main/index.ts),不會動到使用者的真實資料,也不會與
 * 已經在跑的實例搶單一實例鎖。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { domAudit } from './lib/dom-checks.mjs'

const OUT = 'docs/audit'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function main() {
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

  const problems = []
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
      problems.push({ kind: `console.${t}`, page: current, text: m.text().slice(0, 300) })
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
    problems.push({ kind: 'pageerror', page: current, text: stack })
  })
  main.on('requestfailed', (r) => {
    const f = r.failure()
    if (f && !/net::ERR_ABORTED/.test(f.errorText)) {
      problems.push({
        kind: 'requestfailed',
        page: current,
        text: `${r.url().slice(0, 140)} ${f.errorText}`
      })
    }
  })

  for (const [id, label] of PAGES) {
    current = id
    const before = problems.length
    await main.evaluate((l) => {
      const nav = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(l)
      )
      nav?.click()
    }, label)
    await sleep(1500)
    await main.screenshot({ path: join(OUT, `${id}.png`) })

    // 未處理 rejection:取出後清空,避免同一筆在每頁重複計數
    const rejections = await main.evaluate(() => {
      const r = window.__auditRejections || []
      window.__auditRejections = []
      return r
    })
    for (const r of rejections) problems.push({ kind: 'unhandledrejection', page: current, text: r })

    // 版面跑版的直接徵兆
    const m = await main.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight
    }))
    if (m.sw > m.cw + 1) {
      problems.push({
        kind: 'overflow-x',
        page: current,
        text: `scrollWidth=${m.sw} > clientWidth=${m.cw}`
      })
    }
    if (m.sh > m.ch + 1) {
      problems.push({
        kind: 'overflow-y',
        page: current,
        text: `scrollHeight=${m.sh} > clientHeight=${m.ch}`
      })
    }

    // DOM 層的 UI/UX 檢查:比截圖可靠且能量化。
    // 規則實作放在 scripts/lib/dom-checks.mjs,與 audit-deep.mjs 共用同一份。
    const dom = await main.evaluate(domAudit)
    for (const d of dom) problems.push({ kind: d.kind, page: current, text: d.text })

    if (problems.length === before) {
      problems.push({ kind: 'ok', page: current, text: '' })
    }
  }

  const real = problems.filter((p) => p.kind !== 'ok')
  const byKind = real.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {})
  console.log('=== UI 稽核結果 ===')
  console.log(`頁面 ${PAGES.length} 個,問題 ${real.length} 筆`)
  console.log('分類: ' + Object.entries(byKind).map(([k, v]) => `${k}×${v}`).join(', '))
  console.log('')
  for (const p of real) {
    console.log(`[${p.page}] ${p.kind}`)
    console.log(`    ${p.text}`)
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(real, null, 2))
  console.log('')
  console.log(`截圖與報告: ${OUT}/`)
  await app.close()
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ABORT:', e.message)
    process.exit(1)
  })
