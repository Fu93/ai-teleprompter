/**
 * audit-deep.mjs — 深度 UI 稽核:補上 audit-ui.mjs 看不到的涵蓋率。
 *
 * 執行:npm run audit:deep   (需要先 npm run build)
 * 輸出:docs/audit/deep/*.png、docs/audit/deep/report.json
 *
 * audit-ui.mjs 的盲點(這支就是來補的):
 *   1. 只看六頁的「預設/空白」狀態 —— Record 的會後報告、Practice 的進行中、
 *      Calibration 的 step 1/2 從來沒被渲染過。
 *   2. 只有 1180x780 一個尺寸 —— 視窗 minWidth/minHeight 是 960/640,
 *      使用者可以縮到比這更小,而側欄是固定 w-52(208px),內容會被擠壓。
 *   3. 完全不看浮層 —— 辨識主視窗靠的是 <aside>,浮層沒有 <aside>,
 *      所以藥丸/展開/貼鏡三形態從未被檢查過。
 *
 * ── 這一版最大的改變:深狀態不再用「猜按鈕」的方式到達 ──
 *   上一版是在頁面上用文字 regex 找按鈕(例如 /下一步|繼續|開始/)再 click。
 *   找不到就靜默 no-op,而 React 狀態沒變的後果是「截圖一模一樣」——
 *   實際發生的事:calibration.png、calibration-step1.png、calibration-step2.png
 *   三張的 sha256 完全相同(step 0 的前進鍵要有相機或手動距離才渲染,
 *   step 1 的前進鍵要等麥克風量出語速,稽核環境兩者都沒有),
 *   而 report.json 是一份漂亮的空清單。深狀態從來沒被量測,報告卻說「全清」。
 *
 *   現在:(a) 狀態由 window.__auditForce 明確指定(見 src/renderer/src/lib/auditBridge.ts),
 *         (b) 每個狀態的截圖都與它的上一個狀態比對 sha256,沒變就記 state-unreached,
 *         (c) 報告帶 auditedStates 清單,空問題清單不再等於「沒問題」。
 *
 * 做法:不修改任何 app 程式碼(除了 AUDIT 模式下的狀態橋),
 * 直接在頁面 context 寫 IndexedDB 後 reload。資料層是 renderer 的 Dexie
 * (`ai-teleprompter` 庫),用原生 IndexedDB API 塞資料進去,再讓頁面重新載入,
 * 就能看到「有資料」的樣子。
 *
 * 浮層截圖的關鍵(前兩輪白邊診斷全錯的病根):
 *   captureProtected 預設 true,視窗對螢幕擷取不可見,截圖只會拍到背景,
 *   像素分析會整個失準。所以這支先把它關掉,並且在截圖後自我檢查
 *   「這張圖是不是真的有東西」,避免又拿一張背景圖去做量測。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { domAudit, settleAnimations } from '../src/renderer/src/lib/domAudit.ts'
// 形態尺寸契約與程式共用同一份常數。腳本自己再寫一次 280/460/420 的那一刻,
// 稽核就會開始驗一個程式已經不遵守的合約(而且報告看起來完全正常)。
import {
  EXPANDED_MIN,
  LENS_MIN,
  LENS_SIZE,
  PILL_MIN,
  PILL_SCALE_MAX,
  PILL_SCALE_MIN,
  PILL_SIZE,
  PILL_WITH_KEYWORD_W,
  pillKeywordCharsOf,
  pillMinOf,
  pillSizeOf
} from '../src/shared/overlayShapes.ts'
import { createReport, fileHash, guardSerializable, splitDomFindings} from './lib/audit-report.mjs'
import sharp from 'sharp'

process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'
delete process.env.AI_TP_DEBUG

const OUT = 'docs/audit/deep'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 主視窗預設尺寸,以及視窗允許的最小尺寸 */
const VIEWPORTS = [
  ['1180x780', { width: 1180, height: 780 }],
  ['960x640', { width: 960, height: 640 }]
]

/**
 * 浮層每個形態各自的尺寸下限與掃描尺寸。
 *
 * 為什麼不再是單一的 280×40:那個數字是「展開形態」的需求。把它當成三個形態共用的
 * 下限,等於允許把藥丸縮到它裝不下 —— 超出部分是 overflow-hidden,於是右邊那顆
 * (展開鈕,藥丸唯一的出口)被裁掉、貼鏡的正文整段消失。這正是上一輪報告裡
 * 那 4 筆 clipped 的成因。
 *
 * 下限與 morph 的目標尺寸現在都來自 src/shared/overlayShapes.ts,腳本直接讀同一份。
 * 「夾住了」與「沒問題」必須分得開:所以除了量每個尺寸,還會另外要求一個
 * 比下限更小的尺寸,斷言它真的被擋下來(見 overlay-min-not-enforced)。
 */
/**
 * 每個形態的「尺寸是怎麼來的」—— 三種形態的來源不同,掃描方式也必須不同。
 *
 * 上一版對三個形態都用 overlaySetSize 掃三個尺寸。那個假設已經不成立:
 *   藥丸的大小由 pillScale 決定、貼鏡是固定設計尺寸,兩者都不接受任意尺寸
 *   (main 的 applyOverlayWindowSettings 現在以形態決定視窗尺寸;先前用
 *   「使用者選的展開尺寸」是錯的 —— 它會把正在顯示的藥丸/貼鏡撐回展開大小)。
 * 所以:藥丸掃「倍率的兩端與中間值」、貼鏡只掃它的設計尺寸、展開才是真正
 * 可以拖的尺寸(使用者擁有那個尺寸)。
 *
 * steps 的形狀:{ state, shot, expect?, min?, req?, setScale? }
 *   - expect:該形態的硬性尺寸(量視窗,不是量設定 —— 兩者不一致就是 bug)
 *   - min:該狀態專屬的下限(藥丸的下限跟著倍率走,不是 1.00× 的 260)
 *   - req:用 overlaySetSize 要求的尺寸(只有展開形態有意義)
 *   - setScale:改 pillScale(藥丸專用)
 */
const SHAPE_CONTRACT = {
  pill: {
    min: { w: PILL_MIN.w, h: PILL_MIN.h },
    steps: [PILL_SCALE_MIN, 1, PILL_SCALE_MAX].map((scale) => {
      const size = pillSizeOf(scale)
      const min = pillMinOf(scale)
      return {
        state: `overlay/pill@${scale}x`,
        shot: `overlay-pill-${size.w}x${size.h}`,
        expect: size,
        min,
        setScale: scale
      }
    })
  },
  lens: {
    min: { w: LENS_MIN.w, h: LENS_MIN.h },
    steps: [
      {
        state: `overlay/lens@${LENS_SIZE.w}x${LENS_SIZE.h}`,
        shot: `overlay-lens-${LENS_SIZE.w}x${LENS_SIZE.h}`,
        expect: { w: LENS_SIZE.w, h: LENS_SIZE.h }
      }
    ]
  },
  expanded: {
    min: { w: EXPANDED_MIN.w, h: EXPANDED_MIN.h },
    steps: [
      { state: `overlay/expanded@${EXPANDED_MIN.w}x${EXPANDED_MIN.h}`, shot: `overlay-expanded-${EXPANDED_MIN.w}x${EXPANDED_MIN.h}`, req: [EXPANDED_MIN.w, EXPANDED_MIN.h] },
      { state: 'overlay/expanded@720x260', shot: 'overlay-expanded-720x260', req: [720, 260] },
      { state: 'overlay/expanded@1440x520', shot: 'overlay-expanded-1440x520', req: [1440, 520] }
    ]
  }
}

// ── 播種資料 ──
// 用真實形狀的假資料,量測才有意義:報告的數字要非零,摘要要有內容量,
// 逐字稿要有多段。這裡刻意放「极端值」(0 秒、極長文字、超長標題),
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

const report = createReport('audit-deep')

/** 在一個視窗上跑完整檢查集 + 截圖,回傳 { count, hash } */
async function auditShot(win, label, file) {
  const n = report.length
  // 先讓有限次的動畫跑完再量。動畫中途的取樣會讓 animation-unsettled 誤報 ——
  // 規則語意不變,只是把取樣時機移到動畫結束之後(見 domAudit.ts 的 settleAnimations)。
  await win.evaluate(settleAnimations).catch(() => {})
  const dom = await win.evaluate(domAudit).catch((e) => [{ kind: 'audit-failed', text: e.message }])
  const split = splitDomFindings(dom)
  for (const d of split.problems) report.add(d.kind, label, d.text)
  if (split.tally) report.tallyRule(split.tally)
  const path = join(OUT, `${file}.png`)
  await win.screenshot({ path }).catch(() => {})
  return { count: report.length - n, hash: fileHash(path) }
}

/** 走強制橋切換狀態。回 false 代表控制項沒註冊或設值被拒 —— 一定要報,不能靜默。 */
async function force(win, label, name, arg) {
  const res = await win
    .evaluate(([n, a]) => window.__auditForce?.(n, a) ?? { ok: false, names: [] }, [name, arg])
    .catch((e) => ({ ok: false, error: String(e), names: [] }))
  if (!res.ok) {
    report.unreached(label, `${name}(${JSON.stringify(arg)}) 失敗:${res.error ?? '未註冊'} 可用=${(res.names || []).join(',')}`)
  }
  return res.ok
}

async function main() {
  guardSerializable(settleAnimations, 'settleAnimations')
  const srcLen = guardSerializable(domAudit, 'domAudit')
  console.log(`domAudit 序列化檢查通過(${srcLen} 字元)`)

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
      if (t === 'error' || t === 'warning') report.add(`console.${t}`, tag, m.text().slice(0, 300))
    })
    win.on('pageerror', (e) => {
      report.add('pageerror', tag, String(e && e.stack ? e.stack : e).split('\n').slice(0, 4).join(' | ').slice(0, 400))
    })
    win.on('requestfailed', (r) => {
      const f = r.failure()
      if (f && !/net::ERR_ABORTED/.test(f.errorText)) report.add('requestfailed', tag, `${r.url().slice(0, 120)} ${f.errorText}`)
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
    for (const m of r) report.add('unhandledrejection', label, m)
  }

  const bridge = await main.evaluate(() => typeof window.__auditForce === 'function').catch(() => false)
  if (!bridge) {
    report.unreached('boot', 'window.__auditForce 不存在(AI_TP_AUDIT 沒有生效)—— 所有深狀態都會失敗')
  }

  // ── 播種 + 重載 ──
  await seedIndexedDb(main)
  await main.reload()
  await main.waitForLoadState('domcontentloaded')
  await sleep(1500)

  const BASE_PAGES = [
    ['dashboard', '總覽'], ['scripts', '提詞講稿'], ['record', '錄音轉錄'],
    ['practice', '面試練習'], ['calibration', '個人化校準'], ['settings', '設定']
  ]

  for (const [vpName, vp] of VIEWPORTS) {
    await main.setViewportSize(vp).catch(() => {})
    await sleep(600)

    const vpTag = `${vpName}`
    const seenHashes = new Map()

    // 六頁的「有資料」狀態
    for (const [id, label] of BASE_PAGES) {
      const state = `${vpTag}/${id}`
      if (!(await force(main, state, 'app.navigate', id))) continue
      await sleep(1200)
      const { hash } = await auditShot(main, state, `${vpName}-${id}`)
      if (hash) {
        const prev = seenHashes.get(hash)
        if (prev) {
          // 導航失敗會讓兩頁量到同一張圖 —— 這比「這一頁沒問題」重要得多
          report.unreached(state, `截圖與「${prev}」相同:導航沒有真的切換`)
        } else {
          seenHashes.set(hash, state)
          report.measured(`${state}(${label})`)
        }
      } else {
        report.unreached(state, '截圖沒有產生')
      }
    }

    // ── 深狀態 ──
    // 每一個都要與它的「上一個狀態」比對:沒變代表強制沒生效。
    // Record 展開列 -> 摘要/報告(報告數字在極端資料下的排版)
    {
      const state = `${vpTag}/record-expanded`
      if (await force(main, state, 'app.navigate', 'record')) {
        await sleep(900)
        const before = fileHash(join(OUT, `${vpName}-record.png`))
        if (await force(main, state, 'record.expandSession', 0)) {
          await sleep(900)
          const { hash } = await auditShot(main, state, `${vpName}-record-expanded`)
          if (report.expectStateChange(state, before, hash)) report.measured(state)
          await drainRejections(state)
        }
      }
    }

    // Scripts 選「刻意做得很長」的標題那一篇 -> 列表截斷與編輯器
    // (索引 0 會被自動選取,選 0 等於沒換狀態;1 才有意義)
    {
      const state = `${vpTag}/scripts-long-title`
      if (await force(main, state, 'app.navigate', 'scripts')) {
        await sleep(900)
        const before = fileHash(join(OUT, `${vpName}-scripts.png`))
        if (await force(main, state, 'scripts.selectIndex', 1)) {
          await sleep(900)
          const { hash } = await auditShot(main, state, `${vpName}-scripts-long-title`)
          if (report.expectStateChange(state, before, hash)) report.measured(state)
        }
      }
    }

    // Calibration 逐步往後走(step 1 / 2 是完整不同的 UI,而且稽核環境
    // 到不了 —— 這正是上一版靜默 no-op 的地方,所以一定要斷言畫面有變)
    for (const step of [1, 2]) {
      const state = `${vpTag}/calibration-step${step}`
      const prevFile = step === 1 ? `${vpName}-calibration.png` : `${vpName}-calibration-step1.png`
      const curFile = `${vpName}-calibration-step${step}`
      if (await force(main, state, 'app.navigate', 'calibration')) {
        await sleep(700)
        // 回到 step 0 再跳目標步,避免上一個迴圈的狀態殘留
        await force(main, state, 'calibration.step', 0)
        await sleep(300)
        const before = fileHash(join(OUT, prevFile))
        if (await force(main, state, 'calibration.step', step)) {
          await sleep(900)
          const { hash } = await auditShot(main, state, curFile)
          if (report.expectStateChange(state, before, hash)) report.measured(state)
          await drainRejections(state)
        }
      }
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

    const readSize = () =>
      overlay
        .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }))
        .catch(() => null)

    const base = await readSize()
    console.log(`浮層尺寸: ${base ? base.w + 'x' + base.h + ' @' + base.dpr + 'x' : '未知'}`)
    const seenHashes = new Map()
    const sizesSeen = new Set()

    for (const [id, toolTitle] of [
      ['pill', '收合成藥丸'],
      ['expanded', '展開'],
      ['lens', '貼鏡模式']
    ]) {
      // 切換形態要走浮層自己的控制項(compact / lensMode 是設定的一部分,
      // 用 UI 點擊才是真的走到那條路徑)。
      // 踩過的坑:第一版改用 window.api.settingsSet,但 preload 根本沒導出這個
      // 函式,三元運算 fallback 成 null,三個形態其實都停在同一個畫面,
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
      if (!switched) {
        report.unreached(`overlay/${id}`, `浮層找不到「${toolTitle}」控制項,未能切換形態`)
        continue
      }
      await sleep(1600)

      const spec = SHAPE_CONTRACT[id]

      for (const step of spec.steps) {
        const state = step.state
        if (step.setScale !== undefined) {
          await main
            .evaluate((s) => window.api.setSettings({ overlay: { pillScale: s } }), step.setScale)
            .catch(() => {})
        } else if (step.req) {
          await main.evaluate(([tw, th]) => window.api.overlaySetSize(tw, th), step.req).catch(() => {})
        }
        await sleep(900)
        const actual = await readSize()
        if (!actual) {
          report.unreached(state, '浮層沒有回應尺寸查詢')
          continue
        }
        sizesSeen.add(`${actual.w}x${actual.h}`)
        // 低於該形態宣告的下限就是硬性 bug(見 src/shared/overlayShapes.ts)
        const min = step.min ?? spec.min
        if (actual.w < min.w || actual.h < min.h) {
          report.add(
            'overlay-below-min-size',
            state,
            `實際 ${actual.w}x${actual.h} < ${id} 的下限 ${min.w}x${min.h}`
          )
        }
        // 形態的設計尺寸是硬性的(藥丸跟 pillScale、貼鏡固定 420×170)。
        // 量的是**視窗**而不是設定值:先前那個「設定對、畫面對」的 bug
        // (藥丸/貼鏡被撐回展開尺寸)就是兩者不一致。
        if (
          step.expect &&
          (Math.abs(actual.w - step.expect.w) > 2 || Math.abs(actual.h - step.expect.h) > 2)
        ) {
          report.add(
            'overlay-size-wrong',
            state,
            `應該是 ${step.expect.w}x${step.expect.h},實際 ${actual.w}x${actual.h}`
          )
        }
        const { hash } = await auditShot(overlay, state, step.shot)
        const key = hash ?? state
        const dup = seenHashes.get(key)
        if (dup) {
          // 兩張一樣的圖本身不是缺陷(浮層可能在該狀態下確實長一樣),
          // 但「不同的尺寸/倍率卻得到同一張圖」代表它沒生效,那就要報。
          report.add('overlay-size-ignored', state, `截圖與 ${dup} 完全相同,尺寸或倍率可能沒有生效(${actual.w}x${actual.h})`)
        } else {
          seenHashes.set(key, state)
          report.measured(`${state}(實際 ${actual.w}x${actual.h})`)
        }
      }

      // 倍率掃描完還原成預設值:後面的下限檢查、膠囊幾何、暂態與截圖都基於 1.00×。
      if (id === 'pill') {
        await main.evaluate(() => window.api.setSettings({ overlay: { pillScale: 1 } })).catch(() => {})
        await sleep(900)
      }

      // 下限有沒有「真的被強制」?只斷言「量到的不小於下限」是不夠的:
      // 視窗當下本來就比較大時,一個完全沒生效的 setMinimumSize 也會通過。
      // 所以刻意要求一個比下限更小的尺寸 —— 夾得住才會量到下游的值。
      // (藥丸/貼鏡現在更強:它們的尺寸根本不由 overlaySetSize 決定,請求一律無效,
      //  所以對它們來說「不小於下限」是一件恆真的事;這一道仍然守住展開形態。)
      {
        const state = `overlay/${id}@below-min`
        const reqW = Math.max(1, spec.min.w - 40)
        const reqH = Math.max(1, spec.min.h - 8)
        await main.evaluate(([tw, th]) => window.api.overlaySetSize(tw, th), [reqW, reqH]).catch(() => {})
        await sleep(700)
        const actual = await readSize()
        report.note(`overlay.${id}.minEnforced`, actual ? `${actual.w}x${actual.h}` : '(未知)')
        if (!actual) {
          report.unreached(state, '浮層沒有回應尺寸查詢')
        } else if (actual.w < spec.min.w || actual.h < spec.min.h) {
          report.add(
            'overlay-min-not-enforced',
            state,
            `要求 ${reqW}x${reqH} 後實際 ${actual.w}x${actual.h} —— 低於 ${id} 宣告的下限 ${spec.min.w}x${spec.min.h}`
          )
        } else {
          report.measured(`${state}(要求 ${reqW}x${reqH} → 實際 ${actual.w}x${actual.h},下限生效)`)
        }
      }

      // 藥丸必須是「真膠囊」:border-radius = 高的一半。
      // 這不是美學偏好 —— 只要半徑小於高的一半,320×48 的輪廓就從橢圓端變成
      // 圓角長方形,而「看起來像有白邊的長方形」正是這輪要修掉的東西。
      if (id === 'pill') {
        const state = 'overlay/pill@capsule'
        await main.evaluate(() => window.api.overlaySetSize(PILL_SIZE.w, PILL_SIZE.h)).catch(() => {})
        await sleep(700)
        const geo = await overlay.evaluate(() => {
          const el = document.querySelector('.dynamic-island-pill')
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
            w: r.width,
            h: r.height
          }
        })
        report.note('overlay.pill.geometry', geo ? `${Math.round(geo.w)}x${Math.round(geo.h)} radius=${geo.radius}px` : '(未知)')
        if (!geo) {
          report.unreached(state, '找不到藥丸元素')
        } else if (geo.radius < geo.h / 2 - 1) {
          // 注意:用「大於等於」而不是「等於」—— rounded-full 的規格是 9999px,
          // 由引擎在繪製時夾到高的一半,所以 computedStyle 讀不到 24px。
          // 反過來說:只要半徑 < 高的一半,就一定是一個看得出來的圓角長方形。
          report.add(
            'overlay-pill-not-capsule',
            state,
            `border-radius ${geo.radius}px < 高的一半 ${geo.h / 2}px —— 輪廓會讀成圓角長方形而不是橢圓端`
          )
        } else {
          report.measured(`${state}(${Math.round(geo.w)}x${Math.round(geo.h)},radius ${geo.radius}px)`)
        }
      }

      /**
       * 藥丸的狀態可辨識性(2026-10-03 新增)。
       *
       * 為什麼要量這個:四個狀態原本擠在兩種顏色上 —— 「滑鼠穿透」(bg-amber-450)
       * 與「已播畢」(bg-amber-450/80)只差 20% 不透明度。而穿透狀態下視窗**收不到
       * 任何滑鼠事件**,所以那顆點上唯一的說明(title)在該狀態永遠不會顯示:
       * 最需要解釋的狀態剛好是最沒辦法解釋的一個。
       * domAudit 的對比規則逐元素算顏色比值,兩顆 8px 的點各自都合格 ——
       * 要看出「這兩個是不同狀態」需要跨元素比較語意,而沒有任何規則在做那件事。
       *
       * 量兩件事:
       *   (a) 狀態點必須帶 data-overlay-state。沒有它,狀態就無從指涉,
       *       也就無從檢查「它跟別的狀態長得不一樣」。
       *   (b) 預設狀態與穿透狀態的**形狀簽章**必須不同。簽章刻意不含顏色 ——
       *       顏色正是這次要拿掉的依賴。
       *   (c) 穿透狀態在藥丸上必須有文字(見下)。
       */
      if (id === 'pill') {
        const STATE_PROBES = [
          ['default', false],
          ['clickThrough', true]
        ]
        const signatures = {}
        for (const [name, on] of STATE_PROBES) {
          const state = `overlay/pill@state-${name}`
          await main
            .evaluate((v) => window.api.setSettings({ overlay: { clickThrough: v } }), on)
            .catch(() => {})
          await sleep(500)
          const probe = await overlay
            .evaluate(() => {
              const dot = document.querySelector('[data-pill-dot]')
              if (!dot) return null
              const cs = getComputedStyle(dot)
              const child = dot.firstElementChild
              const notice = document.querySelector('[data-pill-notice]')
              return {
                state: dot.getAttribute('data-overlay-state'),
                // 形狀簽章:邊框寬 / 圓角 / 子節點(滑鼠圖示)。**不含顏色**。
                shape: [cs.borderTopWidth, cs.borderTopLeftRadius, child ? child.tagName : '-'].join('|'),
                notice: notice ? (notice.textContent || '').trim() : ''
              }
            })
            .catch(() => null)
          if (!probe) {
            report.unreached(state, '藥丸上找不到狀態點([data-pill-dot])—— 藥丸可能不在預設內容分支')
            continue
          }
          if (!probe.state) {
            report.add(
              'pill-state-unlabelled',
              state,
              '狀態點沒有 data-overlay-state —— 狀態無從檢查,也就無從保證它跟別的狀態長得不一樣'
            )
            continue
          }
          signatures[name] = probe
          report.note(`overlay.pill.state.${name}`, `state=${probe.state} shape=${probe.shape} notice=${probe.notice || '(無)'}`)
          if (name === 'clickThrough' && !probe.notice) {
            report.add(
              'pill-state-no-text',
              state,
              '滑鼠穿透狀態下藥丸上沒有任何文字 —— 這個狀態收不到滑鼠事件,所以唯一的說明只能靠文字,而它不在'
            )
          }
        }
        const def = signatures.default
        const ct = signatures.clickThrough
        if (def && ct && def.shape === ct.shape) {
          report.add(
            'pill-state-indistinguishable',
            'overlay/pill@state-compare',
            `預設(${def.state})與滑鼠穿透的形狀簽章相同(${def.shape})—— 兩個狀態只靠顏色區分,而穿透狀態下 tooltip 永遠顯示不出來`
          )
        } else if (def && ct) {
          report.measured(`overlay/pill@state-compare(形狀可區辨:${def.state}=${def.shape} vs ${ct.state}=${ct.shape})`)
        }
        // 還原:後面的狀態不該繼承這個探針設下的穿透(它會讓 hover 類檢查失效)
        await main.evaluate(() => window.api.setSettings({ overlay: { clickThrough: false } })).catch(() => {})
        await sleep(400)
      }

      /**
       * 浮層工具列的可學性(2026-10-03 新增)。
       *
       * 展開面板是一條 20 顆純圖示按鈕的可橫捲工具列,它們的說明原本只有原生
       * title(hover 約一秒才出現、內容是一整句、還會被可橫捲的容器裁掉)。
       * 改成「底欄說明列」之後,「有沒有接上」變成**資料上可檢查**的事:
       * 每一顆都必須帶 data-tooltip-short(有短標籤)。
       *
       * 這一條抓的是「新增一顆按鈕時忘了給標籤」—— 那顆按鈕在畫面上永遠不
       * 解釋自己,而沒有任何既有規則會發現(no-accessible-name 把 title 當成
       * 合格的名稱,所以它在稽核眼裡甚至是加分項)。
       */
      if (id === 'expanded') {
        const state = 'overlay/expanded@toolbar-labels'
        const toolbar = await overlay
          .evaluate(() => {
            const shell = document.querySelector('[data-toolbar-shell]')
            if (!shell) return null
            const btns = [...shell.querySelectorAll('button')]
            return {
              total: btns.length,
              // 診斷要**指名**是哪一顆。名稱的來源與列舉端一致:text → aria-label
              // → title。只看 aria-label 的話,失敗清單會印出一排「(無名稱)」——
              // 那等於叫人自己去 17 顆裡找一顆沒標籤的按鈕。
              missing: btns
                .filter((b) => !b.hasAttribute('data-tooltip-short'))
                .map((b) =>
                  (
                    (b.textContent || '').trim() ||
                    b.getAttribute('aria-label') ||
                    b.getAttribute('title') ||
                    '(無名稱)'
                  ).slice(0, 14)
                )
            }
          })
          .catch(() => null)
        if (!toolbar || toolbar.total === 0) {
          report.unreached(state, '找不到浮層工具列([data-toolbar-shell])')
        } else if (toolbar.missing.length) {
          report.add(
            'overlay-toolbar-unlabelled',
            state,
            `${toolbar.missing.length}/${toolbar.total} 顆沒有短標籤:${toolbar.missing.join('、')} —— 它們只能靠 hover 一秒後的原生 tooltip,而底欄說明列不會報它們`
          )
        } else {
          report.measured(`${state}(${toolbar.total} 顆全部有短標籤)`)
        }

        /**
         * 工具列的鍵盤提示必須是**真的按得到的那一顆**(2026-10-03 第二輪新增)。
         *
         * 抓的是 P1-E:title 原本寫「暫停(空白鍵)」,但浮層是 `showInactive()`
         * 顯示的(刻意不搶焦點,否則會打斷正在簡報的那個程式)—— 空白鍵只在
         * **浮層自己有焦點**時才送到這裡。於是那個括號裡的捷徑在真實使用情境
         * 下多半不成立,而永遠成立的那一顆(全域 playPause)從未出現在工具列上。
         *
         * 三個方向都要驗,否則「把字改成對的」與「把字刪掉」會互相抵消:
         *   (a) 提到**本地鍵**(空白鍵 / ← / →)的,title 必須同時指名真正全域的
         *       那一顆 —— 否則使用者會拿一個試不成功的鍵去操作。
         *   (b) title 裡出現的每一個和弦都必須是**設定裡真的熱鍵**,不是寫死的
         *       預設值。使用者改過熱鍵之後,寫死的字就是過期字。
         *   (c) 播放/暫停那一顆必須指名 playPause —— 它是這個 App 裡唯一
         *       「浮層沒有焦點也一定按得到」的鍵。
         */
        const keyHints = await overlay
          .evaluate(() => {
            const shell = document.querySelector('[data-toolbar-shell]')
            if (!shell) return null
            return [...shell.querySelectorAll('button')]
              .map((b) => (b.getAttribute('title') || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
          })
          .catch(() => null)
        // 設定的真值:以 main 的設定為準,不是以 renderer 的預設值為準。
        const realHotkeys = await main
          .evaluate(async () => {
            const s = await window.api.getSettings().catch(() => null)
            return s?.hotkeys ?? null
          })
          .catch(() => null)
        if (!keyHints || keyHints.length === 0) {
          report.unreached('overlay/expanded@toolbar-key-hints', '讀不到工具列按鈕的 title')
        } else if (!realHotkeys) {
          report.unreached('overlay/expanded@toolbar-key-hints', '讀不到設定裡的熱鍵(無法判斷哪一顆才是真的)')
        } else {
          const norm = (k) => String(k || '').replaceAll('Control', 'Ctrl')
          const configured = new Set(Object.values(realHotkeys).map(norm).filter(Boolean))
          // 和弦的樣式:(Alt|Ctrl|Shift|Super)+ 之後接一個鍵名
          // 和弦的樣式:(Alt|Ctrl|Shift|Super)+ 之後接一個鍵名。
          // ⚠️ 結束集合必須把 **括號** 也排除:title 寫的是「Alt+P)」,
          // 若只排除左括號,量到的和弦會變成「Alt+P)」而與設定裡的「Alt+P」
          // 對不上 —— 那不是產品壞了,是我的規則量錯了(第一版就這樣紅了一次)。
          const chord = /(Alt|Ctrl|Shift|Super)\+[^\s()（）;；,，、]+/g
          const localOnly = /(空白鍵|←|→)/
          const missingGlobal = []
          const staleChords = []
          for (const t of keyHints) {
            // (a) 提到本地鍵卻沒有名指全域的那一顆
            if (localOnly.test(t) && !/(Alt|Ctrl|Shift|Super)\+/.test(t)) missingGlobal.push(t)
            // (b) title 裡的和弦不在設定裡 = 寫死的字
            for (const c of t.match(chord) || []) {
              if (!configured.has(norm(c))) staleChords.push(`${t.slice(0, 18)}…:${c}`)
            }
          }
          // (c) 播放/暫停必須指名 playPause
          const playT = keyHints.find((t) => /^(播放|暫停)/.test(t))
          const wantPlay = norm(realHotkeys.playPause)
          const playOk = playT ? playT.includes(wantPlay) : false

          if (missingGlobal.length) {
            report.add(
              'overlay-local-key-without-global',
              'overlay/expanded@toolbar-key-hints',
              `${missingGlobal.length} 顆提到本地鍵卻沒有同時指名全域鍵:${missingGlobal
                .map((t) => t.slice(0, 24))
                .join('、')} —— 浮層用 showInactive() 顯示、不搶焦點,本地鍵多半按不到`
            )
          }
          if (staleChords.length) {
            report.add(
              'overlay-stale-hotkey-label',
              'overlay/expanded@toolbar-key-hints',
              `title 裡有設定中不存在的和弦:${staleChords.join('、')} —— 使用者改過熱鍵之後,這些字就是寫死的過期字`
            )
          }
          if (!playT) {
            report.unreached('overlay/expanded@toolbar-key-hints', '工具列上找不到播放/暫停那一顆')
          } else if (!playOk) {
            report.add(
              'overlay-stale-hotkey-label',
              'overlay/expanded@toolbar-key-hints',
              `播放/暫停的 title 是「${playT}」,沒有指到設定裡的 playPause(${wantPlay}) —— 它是唯一「浮層沒焦點也按得到」的那顆鍵`
            )
          }
          if (!missingGlobal.length && !staleChords.length && playOk) {
            report.measured(
              `overlay/expanded@toolbar-key-hints(${keyHints.length} 顆 title 的和弦都對得上設定:${[...configured].join('、')})`
            )
          }
        }
      }

      /**
       * 滿載內容的藥丸:展開鈕在每個倍率下都必須可見。
       *
       * 為什麼要有這一段:「關鍵詞有值」要真的播放到某個位置、「跟讀音柱出現」要真的
       * 開著麥克風跟讀 —— 稽核環境兩者都不成立,所以 `overlay/pill@${scale}x` 那幾個
       * 狀態量到的藥丸**永遠是最空的那一種**。而藥丸唯一的出口就是最右邊那顆展開鈕,
       * 空內容下它一定看得到,滿載下才會被擠掉。
       *
       * 關鍵詞的預期值直接由寬度預算推出來(design.w >= PILL_WITH_KEYWORD_W),
       * 所以這三個狀態同時也驗證了「降級不是無腦全藏」。
       */
      if (id === 'pill') {
        // 六個字:與 production 的 degrade(next, 6) 一致,量到的才是真的寬度
        const PILL_KEYWORD = '下一個關鍵詞示範'
        for (const scale of [PILL_SCALE_MIN, 1, PILL_SCALE_MAX]) {
          const state = `overlay/pill@${scale}x-loaded`
          // 預期值直接用寬度預算推出的字數:0 字 = 整段不渲染。
          // 這樣這個狀態驗證的是「降級的量對不對」,而不只是「有沒有降級」。
          const expectChars = pillKeywordCharsOf(pillSizeOf(scale).w)
          await main
            .evaluate((s) => window.api.setSettings({ overlay: { pillScale: s } }), scale)
            .catch(() => {})
          await sleep(700)
          const forced = await force(overlay, state, 'overlay.pillContent', {
            keyword: PILL_KEYWORD,
            bars: true
          })
          await sleep(500)
          const actual = await readSize()
          if (!forced || !actual) {
            report.unreached(state, forced ? '浮層沒有回應尺寸查詢' : 'overlay.pillContent 未註冊或被拒')
            continue
          }
          // 直接量展開鈕的右緣,不依賴 domAudit 的通用 clipped 規則:
          // 通用規則只看「有沒有東西被裁掉」,不會指名「藥丸唯一的出口不見了」,
          // 而後者才是這裡要守住的不變量。
          const m = await overlay.evaluate(() => {
            const surface = document.querySelector('[data-overlay-surface="pill"]')
            const expandBtn = [...document.querySelectorAll('button')].find(
              (b) => (b.getAttribute('title') || '') === '展開完整面板'
            )
            const kw = document.querySelector('span[title^="下一個:"]')
            // 內容層是 flex-1 min-w-0:它會被壓到比內容還窄,而裡面的子元素是 shrink-0,
            // 於是「不換行、不縮小」變成「溢出並互相重疊」。scrollWidth > clientWidth
            // 是這個狀態唯一可靠的量測 —— 每一顆按鈕各自的 rect 都還在視窗內。
            const row = surface.querySelector('.di-content-in')
            if (!surface) return null
            const s = surface.getBoundingClientRect()
            const b = expandBtn ? expandBtn.getBoundingClientRect() : null
            return {
              surfaceRight: s.right,
              surfaceW: s.width,
              btnRight: b ? b.right : null,
              keyword: !!kw,
              rowClientW: row ? Math.round(row.clientWidth) : null,
              rowScrollW: row ? Math.round(row.scrollWidth) : null
            }
          })
          if (!m) {
            report.unreached(state, '找不到藥丸表面元素')
            continue
          }
          report.note(`overlay.pill.${scale}x.loaded`, `視窗 ${Math.round(m.surfaceW)}px(完整內容預算 ${PILL_WITH_KEYWORD_W}) 內容層 ${m.rowClientW}px / 內容需要 ${m.rowScrollW}px 展開鈕右緣 ${m.btnRight === null ? '(無)' : Math.round(m.btnRight)} / 表面右緣 ${Math.round(m.surfaceRight)}`)
          if (m.btnRight === null) {
            report.add('pill-expand-missing', state, '藥丸上找不到展開鈕 —— 唯一的出口整顆不見了')
          } else if (m.rowScrollW > m.rowClientW + 1) {
            // 這一條才是真正會發生的失效:內容層被壓到比內容窄,而子元素 shrink-0,
            // 結果是關鍵詞、音柱與標題疊在一起 —— 每一顆按鈕的 rect 都還在視窗內,
            // 所以「按鈕有沒有超出表面」量不到它。
            report.add(
              'pill-content-overflow',
              state,
              `內容層 ${m.rowClientW}px 但內容需要 ${m.rowScrollW}px —— shrink-0 的子元素溢出並互相重疊(視窗 ${actual.w}px,關鍵詞${m.keyword ? '顯示' : '已降級'})`
            )
          } else if (m.btnRight > m.surfaceRight + 1) {
            report.add(
              'pill-expand-clipped',
              state,
              `展開鈕右緣 ${Math.round(m.btnRight)} 超出藥丸表面 ${Math.round(m.surfaceRight)}(視窗 ${actual.w}px)—— 藥丸唯一的出口被裁掉`
            )
          } else if (m.keyword !== (expectChars >= 1)) {
            // 反向也要斷言:只驗證「該藏的藏了」會讓「一律全藏」也通過,
            // 那會是另一種缺陷(寬度夠卻什麼都不顯示)。
            report.add(
              'pill-degrade-wrong',
              state,
              `關鍵詞${m.keyword ? '出現' : '沒出現'},這個寬度算出來是 ${expectChars} 字`
            )
          } else {
            report.measured(`${state}(${actual.w}x${actual.h},展開鈕可見,關鍵詞 ${expectChars} 字${m.keyword ? '顯示' : '已降級'})`)
          }
          await auditShot(overlay, state, `overlay-pill-${scale}x-loaded`)
        }
        /**
         * 藥丸視窗必須「不可調整大小」。
         *
         * 這一條是上一段那些寬度預算的**前提**,所以要明確量出來而不是假設:
         * windows.ts 的 applyOverlayWindowSettings 只讓展開形態可調整
         * (`wantResizable = overlayShapeOf(o) === 'expanded'`)。藥丸與貼鏡不可拖,
         * 所以使用者的滑鼠永遠碰不到「比設計寬更窄的藥丸」——
         * pillSizeOf(scale) 就是藥丸唯一的寬度,內容預算因此不可能被使用者拖破。
         *
         * 量法刻意用 overlaySetSizeLive + 1×1:Windows 上 setResizable(false) 會讓
         * **程式化的 setSize 也變成 no-op**,所以「要求 1×1 之後尺寸不變」就是不可調整
         * 的實證(這也是為什麼不能用 setSizeLive 來模擬拖窄:量到的會一直是設計寬,
         * 看起來像稽核通過,實際上什麼都沒發生)。
         *
         * 為什麼要在意:如果哪天有人為了「讓使用者自由調整藥丸大小」而打開 resizable,
         * 這個狀態會立刻失敗 —— 那時 0.8× 的 256px 會立刻變成一個真的會裁掉展開鈕的
         * 視窗,而沒有任何其他狀態看得出來。
         */
        {
          const state = 'overlay/pill@resize-locked'
          const before = await readSize()
          await main.evaluate(() => window.api.overlaySetSizeLive(1, 1)).catch(() => {})
          await sleep(600)
          const after = await readSize()
          if (!before || !after) {
            report.unreached(state, '浮層沒有回應尺寸查詢')
          } else if (after.w !== before.w || after.h !== before.h) {
            report.add(
              'overlay-pill-resizable',
              state,
              `要求 1x1 後變成 ${after.w}x${after.h}(原本 ${before.w}x${before.h})—— 藥丸視窗可被調整大小,寬度預算不再是保證`
            )
          } else {
            report.measured(`${state}(要求 1x1 後仍為 ${after.w}x${after.h},藥丸不可調整 → 設計寬是唯一可能的寬度)`)
          }
          await main
            .evaluate(([w, h]) => window.api.overlaySetSizeLive(w, h), [PILL_SIZE.w, PILL_SIZE.h])
            .catch(() => {})
          await sleep(500)
        }

        // 復原:倍率回到 1.00×、視窗回到設計寬,後面的狀態都以此為基準
        await main.evaluate(() => window.api.setSettings({ overlay: { pillScale: 1 } })).catch(() => {})
        await sleep(600)
        await main
          .evaluate(([w, h]) => window.api.overlaySetSizeLive(w, h), [PILL_SIZE.w, PILL_SIZE.h])
          .catch(() => {})
        await force(overlay, 'overlay/pill@restore', 'overlay.pillContent', null)
        await sleep(500)
      }
    }

    /**
     * 暫態覆蓋層:turn-yield / coaching / panic。
     *
     * 這三個從來沒有被量測過。它們沒有按鈕可以「到達」—— 只能等真實事件發生,
     * 而稽核環境不會有人講話。debug:emit-signal 走的是與真實事件完全相同的廣播
     * 通道與 payload 形狀(AUDIT 模式下放行,見 src/main/ipc.ts 的說明)。
     *
     * 刻意選「發了再拍」而不是等前一個退場:三者在畫面上本來就會疊(提示條在底部、
     * 救援卡從頂部下來),而「疊在一起時誰蓋住誰」正是使用者真正會遇到的狀態。
     */
    const emit = (args) => main.evaluate((a) => window.api.debugEmitSignal(a), args).catch(() => false)
    const clickOverlayButton = (include, exclude) =>
      overlay
        .evaluate(
          ([inc, exc]) => {
            const b = [...document.querySelectorAll('button')].find((x) => {
              const t = x.getAttribute('title') || ''
              return t.includes(inc) && (!exc || !t.includes(exc))
            })
            if (!b) return false
            b.click()
            return true
          },
          [include, exclude]
        )
        .catch(() => false)

    // 回到展開形態並固定在 720x260:提示條與救援卡都需要高度才看得出疊版。
    // 離開貼鏡要先按「退出貼鏡模式」—— 貼鏡的工具列上沒有任何寫著「展開」的按鈕,
    // 只按展開會静默失敗,後面的狀態就全部量在貼鏡模式裡(而且檔名還寫著 expanded)。
    await clickOverlayButton('退出貼鏡模式')
    await sleep(1200)
    await clickOverlayButton('展開')
    await sleep(1400)
    await main.evaluate(() => window.api.overlaySetSize(720, 260)).catch(() => {})
    await sleep(700)
    {
      const shapeSize = await readSize()
      report.note('overlay.transient.shape', shapeSize ? `${shapeSize.w}x${shapeSize.h}` : '(未知)')
      if (!shapeSize || shapeSize.w < 600) {
        report.unreached('overlay/expanded@transient', `未能回到展開形態(實際 ${shapeSize ? `${shapeSize.w}x${shapeSize.h}` : '未知'})`)
      }
    }

    /**
     * morph 途中材質不能被隱藏(回歸測試:120ms 黑洞)。
     *
     * 舊版把 content-morph-in 掛在藥丸 root 上(delay 120ms + fill both),
     * 於是「收合成藥丸」的前 120ms 整顆膠囊是空白的:視窗已經縮小、內容還沒出現。
     * 這裡在點擊後立刻連續取樣「當下形態 root 的 computed opacity」,
     * 任何一個取樣點 < 0.99 就代表材質被藏起來了。
     * 注意:這一刻**不能**跑 domAudit —— 動畫正在跑,animation-unsettled 會誤報。
     */
    {
      const state = 'overlay/pill@morph-material'
      const before = await readSize()
      const samples = await overlay.evaluate(
        () =>
          new Promise((resolve) => {
            const btn = Array.from(document.querySelectorAll('button')).find((b) =>
              (b.getAttribute('title') || '').includes('收合成藥丸')
            )
            if (!btn) return resolve(null)
            btn.click()
            const wanted = [40, 120, 200, 320]
            const out = []
            const start = performance.now()
            const step = () => {
              const now = performance.now() - start
              if (wanted.length && now >= wanted[0]) {
                wanted.shift()
                const el =
                  document.querySelector('.dynamic-island-pill') || document.querySelector('.glass-overlay')
                out.push({
                  t: Math.round(now),
                  kind: el ? el.getAttribute('data-overlay-surface') : '(none)',
                  opacity: el ? Number(getComputedStyle(el).opacity) : 0
                })
              }
              if (wanted.length) requestAnimationFrame(step)
              else resolve(out)
            }
            requestAnimationFrame(step)
          })
      )
      await sleep(900)
      const after = await readSize()
      if (!samples) {
        report.unreached(state, '浮層找不到「收合成藥丸」控制項')
      } else {
        report.note(
          'overlay.pill.morphSamples',
          samples.map((s) => `${s.t}ms:${s.opacity.toFixed(2)}`).join(' ')
        )
        const hidden = samples.filter((s) => s.opacity < 0.99)
        if (hidden.length) {
          report.add(
            'overlay-morph-material-hidden',
            state,
            `morph 途中材質被隱藏:${hidden.map((s) => `${s.t}ms opacity=${s.opacity.toFixed(2)}(${s.kind})`).join('、')}`
          )
        } else if (!before || !after || after.h >= before.h) {
          report.unreached(
            state,
            `收合沒有改變視窗高度(${before ? `${before.w}x${before.h}` : '未知'} → ${after ? `${after.w}x${after.h}` : '未知'}),取樣到的不是 morph 過程`
          )
        } else {
          report.measured(
            `${state}(${samples.length} 個取樣點、材質 opacity 全程 1.00;${before.w}x${before.h} → ${after.w}x${after.h})`
          )
        }
      }
      // 還原成展開形態:後面的暫態狀態需要高度
      await clickOverlayButton('展開')
      await sleep(1400)
      await main.evaluate(() => window.api.overlaySetSize(720, 260)).catch(() => {})
      await sleep(700)
    }

    let prevShot = 'overlay-expanded-720x260.png'
    for (const [name, args] of [
      ['turn', { kind: 'turn', text: 'peer_silence' }],
      ['coaching', { kind: 'coaching', coachingKind: 'fast', text: '（稽核）語速偏快' }],
      ['panic', { kind: 'panic', text: '（稽核）先回應問題核心,再補一個具體例子' }]
    ]) {
      const state = `overlay/expanded@transient-${name}`
      const before = fileHash(join(OUT, prevShot))
      if (!(await emit(args))) {
        report.unreached(state, 'debug:emit-signal 被拒絕(DEBUG 與 AUDIT 都沒開)')
        continue
      }
      // 2600ms 是必要的:useCoaching 有 2s 保險防抖(連續事件會被丟掉),
      // 而文案若間隔太短,量到的會是「上一個狀態 + 沒出現的這個狀態」,
      // 然後被記成 state-unreached —— 一個假缺陷,比沒量更糟。
      await sleep(2600)
      const { hash } = await auditShot(overlay, state, `overlay-expanded-transient-${name}`)
      if (report.expectStateChange(state, before, hash)) report.measured(state)
      prevShot = `overlay-expanded-transient-${name}.png`
      await drainRejections(state)
    }

    // 救援卡是 z-30 的不透明卡,留著會蓋住後面每一個狀態 —— 先把資源收掉
    await overlay.locator('.glass-pill button[title="關閉"]').first().click().catch(() => {})
    await sleep(800)

    /**
     * 瞬時節奏讀數(P4)的**持續型**狀態。
     *
     * 為什麼需要這一格:讀數 chip 只在「真的有人在說話」時出現,而上面 45 個
     * 狀態裡沒有任何一個會說話 —— 也就是說這個新 UI 在發布閘門裡是隱形的,
     * 而它是一個每 2 秒更新、使用者會照著調整語速的東西。
     *
     * 為什麼不用稽核橋強制(不像 coachingHint):讀數是一個**算出來的數字**,
     * 用橋塞一個假值進去等於不驗估計器,只驗「div 畫不畫得出來」。所以這裡
     * 推真的逐字稿走真 IPC(與 e2e/overlay-pace.spec.ts 同一條路徑),驗的是
     * 「它出現在畫面上時,domAudit 的規則怎麼說」。
     *
     * 段落間隔與字數是算過的,不是挑的:
     *   每段 9 個 CJK 單位、間隔 1500ms(≤ CONTINUATION_GAP_MS)→ 第 2 段
     *   開始窗內就有 18 單位 / 3000ms 發聲 = **360 字/分**。360 在 300 基準的
     *   ±10% 帶外(所以畫面真的有顏色可量),但低於 fast 規則的 1.3×(390)
     *   —— 讀數不會順手把教練提示叫出來,這一格的截圖裡只有讀數本身。
     */
    {
      const state = 'overlay/expanded@pace'
      // 讀數掛在「即時教練」開關下(與提示條同一個);先確定它是開的。
      await main.evaluate(() => window.api.setSettings({ overlay: { coaching: true } })).catch(() => {})
      // 先清掉前一格可能留下的語音上下文:窗是 10 秒,「別的狀態離得夠遠」
      // 不該是這一格能不能過的隱性前提。
      await main.evaluate(() => window.api.contextReset()).catch(() => {})
      await sleep(500)
      // 提示鈕先出場,而且要在讀數出現**之前**量它的位置(見下面的穩定性斷言)。
      // 用稽核橋而不是真的教練訊號:這一格驗的是**版面**,不是教練規則 ——
      // 橋的提示是持續的(不像真訊號 8 秒淡出),兩次量測之間不會自己消失。
      await force(overlay, state, 'overlay.coachingHint', { kind: 'filler', message: '稽核:讀數與提示的相對位置' })
      await sleep(700)
      const pillRect = async () =>
        overlay
          .evaluate(() => {
            const el = document.querySelector('[data-effect-id="coaching-mute"]')
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }
          })
          .catch(() => null)
      const pillBefore = await pillRect()
      if (!pillBefore) report.unreached(state, '稽核橋沒有讓提示鈕出現 —— 「讀數出現時提示鈕會不會移動」量不到')
      await overlay.screenshot({ path: join(OUT, 'overlay-expanded-pace-before.png') }).catch(() => {})
      const before = fileHash(join(OUT, 'overlay-expanded-pace-before.png'))

      const SEG = '這是一段測試逐字稿' // 9 個 CJK 單位(見上面那組算過的數字)
      let pushed = true
      for (let i = 0; i < 3; i++) {
        pushed = await main
          .evaluate((t) => window.api.pushTranscript({ text: t, speaker: 'me' }), SEG)
          .catch(() => false)
        if (!pushed) break
        await sleep(1500)
      }

      const chip = overlay.locator('[data-pace="1"]')
      const chipCount = await chip.count().catch(() => 0)
      if (!pushed) {
        report.unreached(state, 'pushTranscript 被拒絕 —— 讀數的來源管道不通')
      } else if (chipCount === 0) {
        report.unreached(state, '推了 3 段真逐字稿(間隔 1.5s)之後浮層仍沒有讀數 chip')
      } else {
        /**
         * 讀數出現時,**可點擊的提示鈕不得移動**。
         *
         * 為什麼這是一條斷言而不是一句設計理念:提示鈕點下去會把那一種提示
         * 靜默到本場結束 —— 它是使用者正在瞄準的目標,而讀數每 2 秒心跳、
         * 隨開口與停頓出現/消失。兩者疊在同一個底部堆疊裡時,誰吸收位移
         * 是有代價的:讀數會動沒關係(它不可互動),提示鈕動了就是點不到。
         */
        if (pillBefore) {
          const pillAfter = await pillRect()
          if (!pillAfter) {
            report.unreached(state, '讀數出現後提示鈕不見了(持續型提示不該淡出)—— 位移量不到')
          } else {
            const dx = Math.abs(pillAfter.left - pillBefore.left)
            const dy = Math.abs(pillAfter.top - pillBefore.top)
            if (dx > 1 || dy > 1) {
              report.add(
                'overlay-pace-shifts-hint',
                state,
                `讀數出現時提示鈕移動了 ${dx}x${dy}px(${pillBefore.top},${pillBefore.left} → ${pillAfter.top},${pillAfter.left})—— 使用者正在瞄準的點擊目標跑掉了`
              )
            } else {
              report.note('overlay.pace.hintStability', `提示鈕不動(${pillAfter.top},${pillAfter.left} ${pillAfter.w}x${pillAfter.h})`)
            }
          }
        }
        // 讀數與提示條不同:它不會自己退場(靠 2 秒心跳活著),所以「整個在
        // 視窗內」是它能不能被讀到的**唯一**保證 —— 貼出去不是漂亮的問題,
        // 是使用者永遠看不到自己偏快。
        const box = await chip.first().boundingBox().catch(() => null)
        const vp = await overlay.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(() => null)
        if (!box || !vp) {
          report.unreached(state, '讀數 chip 在 DOM 裡但量不到幾何(或視窗尺寸)')
        } else if (box.x < 0 || box.y < 0 || box.x + box.width > vp.w || box.y + box.height > vp.h) {
          report.add(
            'overlay-pace-outside-window',
            state,
            `讀數 chip ${Math.round(box.width)}x${Math.round(box.height)} @ ${Math.round(box.x)},${Math.round(box.y)} 超出 ${vp.w}x${vp.h} 的視窗`
          )
        } else {
          const verdict = await chip.first().getAttribute('data-pace-verdict').catch(() => null)
          report.note(
            'overlay.pace.geometry',
            `chip ${Math.round(box.width)}x${Math.round(box.height)} @ ${Math.round(box.x)},${Math.round(box.y)} · verdict=${verdict} · 視窗 ${vp.w}x${vp.h}`
          )
        }
        const { hash } = await auditShot(overlay, state, 'overlay-expanded-pace')
        if (report.expectStateChange(state, before, hash)) report.measured(state)

        /**
         * 高度不足時的不變量:**讀數與工具列不得重疊**。
         *
         * 為什麼量矩形而不是比門檻:拿 PACE_READOUT_MIN_H 來比,等於問 App
         * 「你自己覺得對嗎」—— 門檻調小就會一起通過。這裡量的是兩塊矩形本身,
         * 重疊就是重疊(工具列是提詞機的出口,不能被一個不會退場的讀數蓋住)。
         *
         * 拖到 EXPANDED_MIN(280x40)是使用者真的做得到的事:40 就是下限。
         * 這一條同時驗兩個方向:40px 時讀數必須收起、而且還原高度之後必須
         * 回來(否則「收起」就變成「壞掉」—— 讀數從此不再出現,而畫面上
         * 沒有任何東西會說它去哪了)。
         */
        const toolbarGeo = async () =>
          overlay
            .evaluate(() => {
              const chip2 = document.querySelector('[data-pace="1"]')
              const bar = document.querySelector('[data-overlay-toolbar="1"]')
              if (!bar) return { bar: false, chip: !!chip2, overlapPx: 0, winH: window.innerHeight }
              const b = bar.getBoundingClientRect()
              if (!chip2) return { bar: true, chip: false, overlapPx: 0, winH: window.innerHeight, barBottom: Math.round(b.bottom) }
              const c = chip2.getBoundingClientRect()
              return {
                bar: true,
                chip: true,
                overlapPx: Math.round(Math.min(c.bottom, b.bottom) - Math.max(c.top, b.top)),
                winH: window.innerHeight,
                barBottom: Math.round(b.bottom),
                chipTop: Math.round(c.top)
              }
            })
            .catch(() => null)
        const checkToolbarClear = async (phase) => {
          const g = await toolbarGeo()
          if (!g || !g.bar) {
            report.unreached(state, `找不到工具列([data-overlay-toolbar])—— 讀數與工具列的重疊量不到(${phase})`)
            return null
          }
          if (g.chip && g.overlapPx > 0) {
            report.add(
              'overlay-pace-covers-toolbar',
              state,
              `${phase}:讀數 chip 與工具列重疊 ${g.overlapPx}px(chipTop=${g.chipTop} barBottom=${g.barBottom} 視窗高 ${g.winH})`
            )
          } else {
            report.note(
              `overlay.pace.toolbarClear.${phase}`,
              `視窗高 ${g.winH}px → chip ${g.chip ? '在畫面上' : '已收起'},與工具列重疊 0px`
            )
          }
          return g
        }
        await checkToolbarClear('720x260')
        // 拖到最小高度:下限本身(40px)比讀數需要的還小,chip 必須消失。
        await main.evaluate(([w, h]) => window.api.overlaySetSize(w, h), [EXPANDED_MIN.w, EXPANDED_MIN.h]).catch(() => {})
        await sleep(800)
        const atMin = await checkToolbarClear('min')
        // 還原:後面的狀態要站在原本的展開尺寸上,而且讀數必須回來。
        await main.evaluate(([w, h]) => window.api.overlaySetSize(w, h), [720, 260]).catch(() => {})
        await sleep(800)
        const restored = await checkToolbarClear('restored')
        if (atMin && restored && !atMin.chip && atMin.winH < 77 && !restored.chip) {
          report.add(
            'overlay-pace-lost',
            state,
            `高度不夠時讀數收起是對的,但還原到 ${restored.winH}px 之後它沒有回來(窗內樣本還在)—— 使用者從此看不到讀數`
          )
        }

        /**
         * 底部狀態條(工具列說明列 / 跟讀狀態條)出現時的**第二條位移路徑**。
         *
         * 為什麼要另立一段:狀態條出現時整條堆疊被抬到 bottom-12(+32px),讀數
         * 需要的可用高度從 77px 變成 109px。第一版只算了 bottom-4 —— 於是
         * 720x100(狀態條可見)時 chip 與工具列重疊 8px、720x90 時 18px、
         * 720x80 時 24px,而 720x260 的對照組完全正常:缺陷只落在
         * 「拖小 + 狀態條在場」這一小段高度裡,單看那個常用尺寸看不到它。
         *
         * 為什麼用焦點而不是游標:說明列同時吃 mouseover 與 focus(事件委派在
         * [data-toolbar-shell] 上),而焦點不會因為滑鼠抖一下就跑掉 —— 量測期間
         * 它必須是穩定的。焦點留在工具列上也是真實狀態:使用者按過任何一顆鈕
         * 之後就是這個樣子(所以狀態條與讀數是同一類:不會自己退場)。
         *
         * 三個高度各自代表一件事:
         *   120px → 兩者都放得下(109):chip 必須在,且不碰工具列也不碰狀態條
         *   100px → 放得下狀態條(65)但放不下 chip(109):chip 收起,狀態條在
         *    60px → 連狀態條都放不下(65):它讓位,工具列上只留按鈕
         * 兩個「必須在」是為了不讓缺陷被「那干脆都不要畫」蓋掉 —— 「讓位」與
         * 「壞掉」的差別只在這一側看得出來(與 overlay-pace-lost 同一個理由)。
         */
        await force(overlay, state, 'overlay.coachingHint', null)
        // 窗內樣本會過期(10 秒),而這一段要跨三個 resize:先把樣本補回來。
        for (let i = 0; i < 2; i++) {
          await main
            .evaluate((t) => window.api.pushTranscript({ text: t, speaker: 'me' }), SEG)
            .catch(() => {})
          await sleep(1_500)
        }
        await overlay.locator('[data-overlay-toolbar="1"] [data-tooltip-label]').first().focus().catch(() => {})
        await sleep(600) // 說明列有 120ms 的顯示延遲,不是立刻出現

        const bottomGeo = async () =>
          overlay
            .evaluate(() => {
              const rectOf = (el) => {
                if (!el) return null
                const b = el.getBoundingClientRect()
                return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), rt: Math.round(b.right) }
              }
              const chip = rectOf(document.querySelector('[data-pace="1"]'))
              const toolbar = rectOf(document.querySelector('[data-overlay-toolbar="1"]'))
              const bar = rectOf(
                document.querySelector('[data-toolbar-legend="1"]') ??
                  document.querySelector('[class*="bottom-1.5"]')
              )
              const overlap = (a, b2) => {
                if (!a || !b2) return 0
                const dy = Math.min(a.b, b2.b) - Math.max(a.t, b2.t)
                const dx = Math.min(a.rt, b2.rt) - Math.max(a.l, b2.l)
                return dx > 0 && dy > 0 ? Math.round(dy) : 0
              }
              const stack = document.querySelector('[class*="flex-col"][class*="bottom-"]')
              return {
                winH: window.innerHeight,
                chip: !!chip,
                bar: !!bar,
                chipTop: chip ? chip.t : null,
                barTop: bar ? bar.t : null,
                toolbarBottom: toolbar ? toolbar.b : null,
                chipVsToolbar: overlap(chip, toolbar),
                chipVsBar: overlap(chip, bar),
                barVsToolbar: overlap(bar, toolbar),
                // 非 chip 的堆疊項數(提示條 / 已靜默鈕):用來記錄這一格是在哪一種
                // 排列下量的 —— 提示條在場時讀數的門檻不同(見 paceReadoutFits)。
                items: stack ? Math.max(0, stack.childElementCount - (chip ? 1 : 0)) : null,
                // 說明列的來源是 focus(委派在 [data-toolbar-shell] 上):焦點不在
                // 工具列上時,「狀態條不在」是沒有需求而不是它讓位。
                focusInToolbar: !!document.activeElement?.closest?.('[data-toolbar-shell]')
              }
            })
            .catch(() => null)

        /**
         * 一個高度量三件事:讀數不碰工具列、狀態條不碰工具列、讀數不碰狀態條。
         *
         * 三組都是矩形對矩形的物理不變量(不拿 App 自己的門檻來比 —— 那等於
         * 問它「你自己覺得對嗎」,門檻調小就會跟著通過)。「必須在」的兩條是
         * 反面:它們防的是「把兩個元素都收起來」這種把缺陷藏起來的解法。
         */
        const checkBottomBarPhase = async (phase, w, h, must) => {
          await main.evaluate(([ww, hh]) => window.api.overlaySetSize(ww, hh), [w, h]).catch(() => {})
          await sleep(900)
          const g = await bottomGeo()
          if (!g) {
            report.unreached(state, `量不到底部幾何(工具列/狀態條/讀數)—— ${phase} 的重疊量不到`)
            return null
          }
          if (must.bar && !g.focusInToolbar) {
            report.unreached(
              state,
              `${phase}:焦點已經不在工具列上 —— 狀態條不在場不是它讓位,而是根本沒有需求(這一格量不下去)`
            )
            return null
          }
          report.tallyRule('overlay-bottom-bar-overlap')
          const overlaps = []
          if (g.chip && g.chipVsToolbar > 0) {
            overlaps.push(
              `讀數 chip 與工具列重疊 ${g.chipVsToolbar}px(chipTop=${g.chipTop} 工具列下緣=${g.toolbarBottom})`
            )
          }
          if (g.bar && g.barVsToolbar > 0) {
            overlaps.push(
              `底部狀態條與工具列重疊 ${g.barVsToolbar}px(狀態條上緣=${g.barTop} 工具列下緣=${g.toolbarBottom})`
            )
          }
          if (g.chip && g.chipVsBar > 0) {
            overlaps.push(`讀數 chip 與底部狀態條重疊 ${g.chipVsBar}px(兩者都不會自己退場)`)
          }
          if (overlaps.length > 0) {
            report.add('overlay-bottom-bar-overlap', state, `${phase}(視窗高 ${g.winH}px):${overlaps.join(';')}`)
          }
          if (must.chip) {
            report.tallyRule('overlay-pace-lost')
            if (!g.chip) {
              report.add(
                'overlay-pace-lost',
                state,
                `${phase}:視窗高 ${g.winH}px 放得下讀數(109px + 同框項各 40px —— 狀態條在場時再加 32px)、樣本也還在,chip 卻不在 —— 收起變成了壞掉`
              )
            }
          }
          if (must.bar) {
            report.tallyRule('overlay-status-bar-lost')
            if (!g.bar) {
              report.add(
                'overlay-status-bar-lost',
                state,
                `${phase}:焦點在工具列上、視窗高 ${g.winH}px 放得下狀態條(65px),它卻不在 —— 使用者看不到自己焦點在哪一顆按鈕上`
              )
            }
          }
          if (overlaps.length === 0 && (!must.chip || g.chip) && (!must.bar || g.bar)) {
            report.note(
              `overlay.bottomBar.${phase}`,
              `視窗高 ${g.winH}px → 讀數${g.chip ? '在' : '收起'}、狀態條${g.bar ? '在' : '讓位'}` +
                `${g.items === null ? '' : `、同框提示 ${g.items} 條`};讀數/狀態條/工具列三組矩形兩兩不相交`
            )
          }
          return g
        }
        // 三個**沒有強制**提示條的高度。為什麼是兩個高度(100 與 130)而不是一個:
        // 讀數被推出工具列的那一段高度取決於**提示條在不在**(沒有提示條時是
        // 77–108px,有提示條時是 113–148px),而真實提示條在這一格是不是在場
        // **不由這支腳本決定**(main 的冷場訊號只給 8 秒淡出)── 每一格的
        // `同框提示 N 條` 會寫進 note,兩種排列各自都被覆蓋。
        // (實測時真實提示正好在場:100px 與 130px 都量到 1 條。)
        // 兩個高度在修好的程式碼裡都是綠的;而對修法前的程式碼,任一排列都
        // 至少有一個高度會紅(1 條提示時 130px 重疊 19px、100px 重疊 12px)。
        await checkBottomBarPhase('bar@260', 720, 260, { chip: true, bar: true })
        await checkBottomBarPhase('bar@100', 720, 100, { chip: false, bar: true })
        await checkBottomBarPhase('bar@130', 720, 130, { chip: false, bar: true })

        /**
         * 讀數與**其他項**同框的排列。
         *
         * 為什麼要這一組:堆疊比空間高時被推出頂端的是第一項(讀數) ——
         * 「讀數自己放得下」不等於「讀數加別人放得下」。用稽核橋強制一條提示條
         * (它是持續的,而且 `auditCoaching ?? realCoachingHint` 讓它蓋過真實訊號),
         * 排列就是確定的:這就是實測到 24px 重疊的那一格。
         */
        await force(overlay, state, 'overlay.coachingHint', {
          kind: 'filler',
          message: '稽核:與讀數同框的提示'
        })
        await sleep(500)
        await checkBottomBarPhase('bar+hint@120', 720, 120, { chip: false, bar: true })
        await checkBottomBarPhase('bar+hint@260', 720, 260, { chip: true, bar: true })
        await force(overlay, state, 'overlay.coachingHint', null)
        await sleep(500)
        // 連狀態條都放不下的高度(65px):它讓位,工具列上只留按鈕。
        await checkBottomBarPhase('bar@60', 720, 60, { chip: false, bar: false })

        // 收尾:焦點與尺寸都要還原 —— 說明列是元件層的狀態,留著會跟著進下一個
        // 形態的截圖(下一格是貼鏡暫態)。
        await overlay.evaluate(() => document.activeElement?.blur?.()).catch(() => {})
        await main.evaluate(() => window.api.overlaySetSize(720, 260)).catch(() => {})
        await sleep(700)
        const restored2 = await bottomGeo()
        report.note(
          'overlay.bottomBar.restored',
          `焦點已放開、尺寸還原 720x260 → 狀態條${restored2 && restored2.bar ? '仍在(不該)' : '已收起'}`
        )
      }
      // 收尾:讀數、強制的提示與語音上下文都不得留給下一格(下一格是貼鏡暫態;
      // 這裡開始說話之後,若不清掉,8 秒冷場會落在別人的截圖上)。
      await force(overlay, state, 'overlay.coachingHint', null)
      await main.evaluate(() => window.api.contextReset()).catch(() => {})
      await sleep(700)
    }

    // 貼鏡(420x170)裡的暫態覆蓋層。
    //
    // 救援卡是卡片比視窗高的實際受害者;這一版把信心/來源搬進標題列就是為了它。
    // 但這一版同時加了另外兩件事,所以三種暫態都必須各有狀態:
    //   1. 貼鏡底部的預讀行(下一句/下一詞組)會在任一暫態提示出現時收起
    //      (suppressBottom)—— 「疊印在一起兩行都讀不了」是它要消滅的缺陷;
    //   2. coaching 提示在貼鏡形態原本漏送,這一版補上;
    //   3. turn-yield 與 coaching 同時出現時是一條 flex-col 兩層 pill。
    // 三者都發生在 420×170 這個會被裁掉的視窗裡 —— 沒有狀態就是沒量過。
    {
      let lensPrevShot = `overlay-lens-${LENS_SIZE.w}x${LENS_SIZE.h}.png`
      await clickOverlayButton('貼鏡模式', '退出')
      await sleep(1600)
      for (const [name, args] of [
        ['turn', { kind: 'turn', text: 'peer_silence' }],
        ['coaching', { kind: 'coaching', coachingKind: 'fast', text: '（稽核）語速偏快' }],
        ['panic', { kind: 'panic', text: '（稽核）先回應問題核心,再補一個具體例子' }]
      ]) {
        const state = `overlay/lens@transient-${name}`
        const before = fileHash(join(OUT, lensPrevShot))
        if (!(await emit(args))) {
          report.unreached(state, 'debug:emit-signal 被拒絕(DEBUG 與 AUDIT 都沒開)')
          continue
        }
        // 2600ms 與展開形態同理:useCoaching 有 2s 保險防抖,
        // 間隔太短會量到「上一個狀態」而記成假缺陷。
        await sleep(2600)
        const { hash } = await auditShot(overlay, state, `overlay-lens-transient-${name}`)
        if (report.expectStateChange(state, before, hash)) report.measured(state)
        lensPrevShot = `overlay-lens-transient-${name}.png`
        await drainRejections(state)
        // 救援卡是 z-30 的不透明卡,留著會蓋住下一輪的狀態 —— 先收掉
        await overlay.locator('.glass-pill button[title="關閉"]').first().click().catch(() => {})
        await sleep(600)
      }
    }
    // 收尾:回到展開形態,不讓後面的斷言看到一個帶著救援卡的畫面
    await overlay.locator('.glass-pill button[title="關閉"]').first().click().catch(() => {})
    await clickOverlayButton('退出貼鏡模式')
    await sleep(900)

    // resize 完全失效的總體斷言:所有尺寸都量到同一組實際值
    if (sizesSeen.size === 1) {
      report.unreached('overlay/resize-sweep', `所有尺寸要求都得到同一組實際值(${[...sizesSeen][0]})—— 尺寸掃描形同無效`)
    }

    // 自我檢查:截圖真的有東西嗎?整張圖近乎單一顏色 = 拍到背景,量測會失準
    // (檔名跟著藥丸的設計尺寸走:寫死尺寸或下限的話,一改就永遠找不到檔案)
    const shot = join(OUT, `overlay-pill-${PILL_SIZE.w}x${PILL_SIZE.h}.png`)
    report.note('overlay.pill.sampleShot', shot)
    try {
      const st = await sharp(shot).stats()
      const ch = st.channels.slice(0, 3)
      const spread = Math.max(...ch.map((c) => c.max - c.min))
      console.log(`浮層截圖像素極差: ${spread}(<20 代表整張近乎單色,可能是背景)`)
      if (spread < 20) {
        report.add('overlay-screenshot-blank', 'overlay', `藥丸截圖像素極差只有 ${spread},很可能拍到背景而非視窗內容`)
      }
    } catch (e) {
      report.add('overlay-screenshot-missing', 'overlay', e.message)
    }
  } else {
    report.unreached('overlay', '找不到浮層視窗,浮層未被稽核')
  }

  const problems = report.finish(join(OUT, 'report.json'))
  console.log(`輸出: ${OUT}/`)
  await app.close()
  return problems
}

main()
  // 問題數必須進 exit code,理由同 audit-ui.mjs:稽核不擋人的話就只是報表。
  .then((problems) => process.exit(problems.length ? 1 : 0))
  .catch((e) => {
    console.error('ABORT:', e.stack || e.message)
    process.exit(1)
  })
