/**
 * audit-deep.mjs — 深度 UI 稽核:補上 audit-ui.mjs 看不到的涵蓋率。
 *
 * audit-ui.mjs 的盲點(這支就是來補的):
 *   1. 只看六頁的「預設/空白」狀態 —— Record 的會後報告、Practice 的進行中、
 *      Calibration 的 step 1/2 從來沒被渲染過。
 *   2. 只有 1180x780 一個尺寸 —— 視窗 minWidth/minHeight 是 960/640,
 *      使用者可以縮到比這更小,而側欄是固定 w-52(208px),內容會被擠壓。
 *   3. 完全不看浮層 —— 辨識主視窗靠的是 <aside>,浮層沒有 <aside>,
 *      所以藥丸/展開/貼鏡三形態從未被檢查過。
 *
 * 做法:不修改任何 app 程式碼,直接在頁面 context 寫 IndexedDB 後 reload。
 * 資料層是 renderer 的 Dexie(`ai-teleprompter` 庫),用原生 IndexedDB API
 * 塞資料進去,再讓頁面重新載入,就能看到「有資料」的樣子。
 *
 * 浮層截圖的關鍵(前兩輪白邊診斷全錯的病根):
 *   captureProtected 預設 true,視窗對螢幕擷取不可見,截圖只會拍到背景,
 *   像素分析會整個失準。所以這支先把它關掉,並且在截圖後自我檢查
 *   「這張圖是不是真的有東西」,避免又拿一張背景圖去做量測。
 *
 * 執行:AI_TP_E2E=1 node scripts/audit-deep.mjs(需先 npm run build)
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { domAudit } from './lib/dom-checks.mjs'
import sharp from 'sharp'

const OUT = 'docs/audit/deep'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 主視窗預設尺寸,以及視窗允許的最小尺寸 */
const VIEWPORTS = [
  ['1180x780', { width: 1180, height: 780 }],
  ['960x640', { width: 960, height: 640 }]
]

// ── 播種資料 ──
// 用真實形狀的假資料,量測才有意義:報告的數字要非零,摘要要有內容量,
// 逐字稿要有多段。這裡刻意放「极端值」(0 秒、極長文字、超長標題)，
// 因為版面 bug 通常只在極端內容下才現形。
const now = Date.now()
const HOUR = 3600_000
const SEG = (speaker, text, start, end) => ({ speaker, text, start, end })

const SEED = {
  scripts: [
    { title: '產品發表會致詞', content: '各位好,今天要跟大家介紹我們最新的產品。\n'.repeat(40), tags: ['致詞'], createdAt: now - 5 * HOUR, updatedAt: now - 2 * HOUR, lastUsedAt: now - HOUR },
    { title: '這個標題刻意做得很長很長很長很長很長很長很長用來測試列表欄位會不會被截斷', content: '短稿', createdAt: now - 9 * HOUR, updatedAt: now - 9 * HOUR },
    { title: '', content: '', createdAt: now - 10 * HOUR, updatedAt: now - 10 * HOUR }
  ],
  sessions: [
    {
      title: '',
      startedAt: now - 2 * HOUR,
      endedAt: now - 2 * HOUR + 5400,
      segments: [
        SEG('me', '我先說明一下目前的進度', 0, 12),
        SEG('them', '那個我想問一下排程是怎麼安排的', 12.5, 40),
        SEG('me', '排程的部分我們分成三個階段', 40, 95)
      ],
      summary: {
        abstract: '本次會議討論了產品排程的三階段規劃,並確認了驗收標準與後續負責人。',
        keyPoints: ['排程分三階段', '驗收標準已確認', '下週二前完成第一階段', '資源需求待評估'],
        todos: ['完成第一階段排程表', '通知相關團隊', '預約測試環境', '更新文件', '安排回顧會議'],
        followUps: ['下週二檢查進度', '資源問題找Ops 確認', '驗收標準簽核'],
        generatedAt: now - 2 * HOUR,
        model: 'ollama/llama3'
      },
      report: {
        durationSec: 5400, mySec: 1800, theirSec: 2400, talkRatio: 0.43,
        myUnits: 3200, myCpm: 107, turnCount: 14, avgMyTurnSec: 128,
        longestMyTurnSec: 400, gapCount: 6, gapTotalSec: 92, theirQuestionCount: 5,
        steadiness: 72,
        suggestions: [
          { kind: 'talk-ratio', text: '你講的比例偏低,可以在對方停頓時補充', severity: 'warn' },
          { kind: 'dead-air', text: '有 6 次超過 5 秒的冷場', severity: 'info' }
        ],
        coachingCounts: { interrupt: 2, filler: 5, tooFast: 1 },
        generatedAt: now - 2 * HOUR
      }
    },
    {
      title: '極短會議(時長 0 秒,測試除零)',
      startedAt: now - 5 * HOUR,
      endedAt: now - 5 * HOUR,
      segments: [],
      report: {
        durationSec: 0, mySec: 0, theirSec: 0, talkRatio: 0,
        myUnits: 0, myCpm: 0, turnCount: 0, avgMyTurnSec: 0,
        longestMyTurnSec: 0, gapCount: 0, gapTotalSec: 0, theirQuestionCount: 0,
        steadiness: 0, suggestions: [], generatedAt: now - 5 * HOUR
      }
    }
  ],
  practiceRuns: [
    {
      position: '後端工程師', type: '技術面試',
      questions: ['請介紹一個你做過最有挑戰的專案', '你怎麼處理線上事故'],
      answers: [
        { question: '請介紹一個你做過最有挑戰的專案', answerTranscript: '我做過一個即時訊息系統的擴充', durationSec: 95, feedback: { score: 78, content: '有具體案例', structure: 'STAR 結構完整', delivery: '語速偏快' } },
        { question: '你怎麼處理線上事故', answerTranscript: '先止血', durationSec: 40 }
      ],
      createdAt: now - 3 * HOUR,
      overallFeedback: '整體表現不錯,建議多給具體數字。'
    }
  ]
}

/** 用原生 IndexedDB API 寫入,schema 對齊 db.ts 的 Dexie 定義 */
async function seedIndexedDb(page) {
  await page.evaluate(
    (seed) =>
      new Promise((resolve, reject) => {
        // 踩到的坑:db.ts 寫的是 Dexie 的 version(1),但原生 IndexedDB 開出來
        // 是 version 10 —— Dexie 內部把版本號乘以 10 當 IDB 版本。
        // 照著寫 version 1 會直接吃 VersionError(DB 已存在且版本較高)。
        const req = indexedDB.open('ai-teleprompter', 10)
        req.onupgradeneeded = () => {
          const db = req.result
          for (const name of ['scripts', 'sessions', 'practiceRuns']) {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, { keyPath: 'id', autoIncrement: true })
            }
          }
        }
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const names = ['scripts', 'sessions', 'practiceRuns']
          const tx = db.transaction(names, 'readwrite')
          for (const n of names) {
            const store = tx.objectStore(n)
            for (const rec of seed[n]) store.add(rec)
          }
          tx.oncomplete = () => { db.close(); resolve(true) }
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        }
      }),
    SEED
  )
}

const problems = []
const addProblem = (kind, page, text) => problems.push({ kind, page, text })

/** 在一個頁面上跑完整檢查集 + 截圖 */
async function auditPage(win, label, file) {
  const n = problems.length
  const dom = await win.evaluate(domAudit).catch((e) => [{ kind: 'audit-failed', text: e.message }])
  for (const d of dom) addProblem(d.kind, label, d.text)
  await win.screenshot({ path: join(OUT, `${file}.png`) }).catch(() => {})
  return problems.length - n
}

async function main() {
  const app = await electron.launch({ args: ['.'], timeout: 60_000 })

  // 分辨主視窗與浮層:主視窗有 <aside>(側欄),浮層沒有。
  // 這一點是「浮層從未被稽核」的根本原因 —— 原本只找主視窗。
  let main = await app.firstWindow()
  let overlay = null
  await main.waitForLoadState('domcontentloaded')
  for (let i = 0; i < 20; i++) {
    const wins = app.windows()
    let foundMain = false
    for (const w of wins) {
      const hasAside = await w.evaluate(() => !!document.querySelector('aside')).catch(() => false)
      const hasBody = await w.evaluate(() => !!document.body).catch(() => false)
      if (hasAside) { main = w; foundMain = true }
      else if (hasBody && !hasAside) overlay = w
    }
    if (foundMain && overlay) break
    await sleep(400)
  }
  await main.setViewportSize(VIEWPORTS[0][1]).catch(() => {})
  await sleep(1200)

  console.log(`主視窗: ${main.url().slice(-40)}`)
  console.log(`浮層視窗: ${overlay ? overlay.url().slice(-40) : '(未找到)'}`)

  // ── 攔截器:console / pageerror / unhandledrejection ──
  const wire = (win, tag) => {
    win.on('console', (m) => {
      const t = m.type()
      if (t === 'error' || t === 'warning') addProblem(`console.${t}`, tag, m.text().slice(0, 300))
    })
    win.on('pageerror', (e) => {
      addProblem('pageerror', tag, String(e && e.stack ? e.stack : e).split('\n').slice(0, 4).join(' | ').slice(0, 400))
    })
    win.on('requestfailed', (r) => {
      const f = r.failure()
      if (f && !/net::ERR_ABORTED/.test(f.errorText)) addProblem('requestfailed', tag, `${r.url().slice(0, 120)} ${f.errorText}`)
    })
  }
  wire(main, 'main')
  if (overlay) wire(overlay, 'overlay')
  await main.evaluate(() => {
    window.__rej = []
    window.addEventListener('unhandledrejection', (e) => {
      window.__rej.push(String(e.reason && e.reason.message ? e.reason.message : e.reason).slice(0, 200))
    })
  })

  const drainRejections = async (label) => {
    const r = await main.evaluate(() => { const x = window.__rej || []; window.__rej = []; return x })
    for (const m of r) addProblem('unhandledrejection', label, m)
  }

  const goto = async (navLabel) => {
    await main.evaluate((l) => {
      const nav = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(l))
      nav?.click()
    }, navLabel)
    await sleep(1200)
  }

  // ── 播種 + 重載 ──
  await seedIndexedDb(main)
  await main.reload()
  await main.waitForLoadState('domcontentloaded')
  await sleep(1500)

  for (const [vpName, vp] of VIEWPORTS) {
    await main.setViewportSize(vp).catch(() => {})
    await sleep(600)

    // 六頁的「有資料」狀態
    for (const [id, label] of [
      ['dashboard', '總覽'], ['scripts', '提詞講稿'], ['record', '錄音轉錄'],
      ['practice', '面試練習'], ['calibration', '個人化校準'], ['settings', '設定']
    ]) {
      await goto(label)
      const found = await auditPage(main, `${vpName}/${id}`, `${vpName}-${id}`)
      if (found === 0) addProblem('ok', `${vpName}/${id}`, '')
    }

    // 深狀態:點開有互動的東西,讓沒預設渲染的面板出現
    // Record 展開列 -> 摘要/報告
    await goto('錄音轉錄')
    await main.evaluate(() => {
      const row = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('產品') || b.textContent?.length > 20)
      row?.click()
    })
    await sleep(700)
    await auditPage(main, `${vpName}/record-expanded`, `${vpName}-record-expanded`)
    await drainRejections(`${vpName}/record-expanded`)

    // Scripts 選一篇稿子 -> 編輯器
    await goto('提詞講稿')
    await main.evaluate(() => {
      const row = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('產品發表會'))
      row?.click()
    })
    await sleep(700)
    await auditPage(main, `${vpName}/script-selected`, `${vpName}-script-selected`)

    // Calibration 逐步往後走(step 1 / 2 是完整不同的 UI)
    await goto('個人化校準')
    for (let step = 1; step <= 2; step++) {
      await main.evaluate(() => {
        const next = Array.from(document.querySelectorAll('button')).find((b) => /下一步|繼續|開始/.test(b.textContent || ''))
        next?.click()
      })
      await sleep(900)
      await auditPage(main, `${vpName}/calibration-step${step}`, `${vpName}-calibration-step${step}`)
      await drainRejections(`${vpName}/calibration-step${step}`)
    }
  }

  // ── 浮層 ──
  if (overlay) {
    // captureProtected 必須關掉,否則截圖只有背景(前兩輪診斷誤判的根因)
    await main.evaluate(() => window.api.overlaySetCaptureProtection(false)).catch(() => {})
    // clickThrough 關掉,滑鼠事件才進得去(specular / hover 才測得到)
    await main.evaluate(() => window.api.overlaySetClickThrough(false)).catch(() => {})
    await sleep(400)
    await main.evaluate(() =>
      window.api.overlayShow({
        title: '產品發表會致詞',
        content: '各位好,今天要跟大家介紹我們最新的產品。這是一個很長的段落,用來測試換行、截斷、與捲動的行為。'
      })
    ).catch(() => {})
    await sleep(2000)

    const box = await overlay.evaluate(() => ({
      w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio
    })).catch(() => null)
    console.log(`浮層尺寸: ${box ? box.w + 'x' + box.h + ' @' + box.dpr + 'x' : '未知'}`)

    for (const [id, toolTitle] of [
      ['pill', '收合成藥丸'],
      ['expanded', '展開'],
      ['lens', '貼鏡模式']
    ]) {
      // 切換形態要走浮層自己的控制項(compact / lensMode 是 VOLATILE_OVERLAY_KEYS,
      // 刻意不落地,preload 也沒有 settingsSet)。用 UI 點擊才是真的走到那條路徑。
      // 踩過的坑:第一版改用 window.api.settingsSet,但 preload 根本沒導出這個
      // 函式,三元運算fallback 成 null,三個形態其實都停在同一個畫面,
      // 座標一模一樣還以為是三個不同的問題。
      const switched = await overlay
        .evaluate((t) => {
          const b = Array.from(document.querySelectorAll('button')).find((x) =>
            (x.getAttribute('title') || '').includes(t)
          )
          if (!b) return false
          b.click()
          return true
        }, toolTitle)
        .catch(() => false)
      if (!switched) addProblem('overlay-switch-failed', `overlay/${id}`, `浮層找不到「${toolTitle}」控制項,未能切換形態`)

      await sleep(1600)
      const n = await auditPage(overlay, `overlay/${id}`, `overlay-${id}`)
      if (n === 0) addProblem('ok', `overlay/${id}`, '')
      const size = await overlay
        .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, html: document.body.innerText.slice(0, 40) }))
        .catch(() => null)
      console.log(`  浮層 ${id}: ${size ? size.w + 'x' + size.h : '?'} ${size ? JSON.stringify(size.html) : ''}`)
    }

    // 自我檢查:截圖真的有東西嗎?整張圖近乎單一顏色 = 拍到背景,量測會失準
    const shot = join(OUT, 'overlay-pill.png')
    try {
      const st = await sharp(shot).stats()
      const ch = st.channels.slice(0, 3)
      const spread = Math.max(...ch.map((c) => c.max - c.min))
      console.log(`浮層截圖像素極差: ${spread}(<20 代表整張近乎單色,可能是背景)`)
      if (spread < 20) {
        addProblem('overlay-screenshot-blank', 'overlay', `藥丸截圖像素極差只有 ${spread},很可能拍到背景而非視窗內容`)
      }
    } catch (e) {
      addProblem('overlay-screenshot-missing', 'overlay', e.message)
    }
  } else {
    addProblem('overlay-not-found', 'overlay', '找不到浮層視窗,浮層未被稽核')
  }

  // ── 報告 ──
  const real = problems.filter((p) => p.kind !== 'ok')
  const byKind = real.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {})
  console.log('')
  console.log('=== 深度稽核結果 ===')
  console.log(`問題 ${real.length} 筆`)
  console.log('分類: ' + (Object.entries(byKind).map(([k, v]) => `${k}×${v}`).join(', ') || '(無)'))
  console.log('')
  for (const p of real) {
    console.log(`[${p.page}] ${p.kind}`)
    console.log(`    ${p.text}`)
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(real, null, 2))
  console.log('')
  console.log(`輸出: ${OUT}/`)
  await app.close()
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ABORT:', e.stack || e.message)
    process.exit(1)
  })
