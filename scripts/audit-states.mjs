/**
 * audit-states.mjs — 互動狀態稽核:量「不是預設狀態」的畫面。
 *
 * 執行:npm run build && AI_TP_E2E=1 node scripts/audit-states.mjs
 * 輸出:docs/audit/states/report.json + docs/audit/states/*.png
 *
 * 為什麼需要這一支:
 *   audit-ui 每頁量 1 個狀態(共 6 個),audit-deep 加到 40 個 —— 但兩者量的
 *   都是**預設狀態**:對話框關著、toast 沒出現、沒有 focus 停在控制項上、
 *   沒有錯誤/空/收尾中。而這個 App 的狀態分支非常多(Record 有 error×12、
 *   saving×10,Practice 有 busy×11、error×9),七個確認對話框一個都沒量過。
 *   「還有很多 UI bug」的根因不是規則不夠(8 條 domAudit 規則其夠用),
 *   而是量測只覆蓋了每個頁面最無聊的那一格。
 *
 * 與其他稽核腳本的分工:
 *   domAudit 規則實作只有一份(src/renderer/src/lib/domAudit.ts),本腳本不重複
 *   實作任何版面規則,只在它之上加「狀態驅動」與「互動專屬斷言」。
 *
 * 播種方式:資料層是 renderer 直接讀寫 IndexedDB(lib/db.ts 的 Dexie),
 *   沒有走 IPC,所以稽核直接在頁面裡用原生 indexedDB 寫入 —— 不需要新增
 *   preload API,也不會為了讓掃描器好跑而放寬測試。到不了的狀態一律
 *   報 unreached(「沒量到」不等於「沒問題」)。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { domAudit } from '../src/renderer/src/lib/domAudit.ts'
import { createReport, guardSerializable } from './lib/audit-report.mjs'

process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'
delete process.env.AI_TP_DEBUG

const OUT = 'docs/audit/states'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = createReport('audit-states')

/** 主視窗尺寸:預設與下限各跑一次(下限 960×640 是 createMainWindow 的 minWidth/minHeight) */
const VIEWPORTS = [
  { width: 1180, height: 780, tag: '' },
  { width: 960, height: 640, tag: '@960' }
]

// ───────────────────────── 播種 ─────────────────────────
/**
 * 用原生 indexedDB 寫入測試資料。
 * Dexie 的 schema 是 ++id(自動遞增),所以不給 id 就會由引擎指派。
 * 刻意給「很長」與「很短」的兩組:長標題是版面最容易壞掉的輸入。
 */
async function seed(page) {
  return page.evaluate(async () => {
    const now = Date.now()
    const longTitle =
      '這是一個刻意取得非常長的講稿標題用來壓迫截斷與換行版面測試極限情況以及標題列與按鈕的排列是否還能維持'
    const open = () =>
      new Promise((res, rej) => {
        const r = indexedDB.open('ai-teleprompter')
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
        r.onupgradeneeded = () => {
          const db = r.result
          for (const [name, schema] of [
            ['scripts', '++id, title, updatedAt, lastUsedAt'],
            ['sessions', '++id, startedAt, endedAt'],
            ['practiceRuns', '++id, createdAt']
          ]) {
            if (db.objectStoreNames.contains(name)) continue
            // keyPath 從 schema 推導,不要另外寫死 'id'。
            // 寫死的話,新增一個 keyPath 不同的 store 時這裡會安靜地建出一個
            // schema 不符的 object store —— 而且症狀是「寫入後查不到」,
            // 與真正的 schema 錯誤長得一模一樣。
            const keyPath = schema.split(',')[0].replace(/^\+\+/, '').trim()
            db.createObjectStore(name, { keyPath, autoIncrement: true })
          }
        }
      })
    const putAll = (db, store, rows) =>
      new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite')
        const os = tx.objectStore(store)
        for (const row of rows) os.put(row)
        tx.oncomplete = () => res(rows.length)
        tx.onerror = () => rej(tx.error)
      })
    const db = await open()
    const scripts = [
      { title: '短標題', content: '第一行\n第二行', createdAt: now, updatedAt: now },
      { title: longTitle, content: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行內容，這一行刻意寫得比較長一點`).join('\n'), createdAt: now, updatedAt: now }
    ]
    const segs = (n, txt) => Array.from({ length: n }, (_, i) => ({ speaker: i % 2 ? 'them' : 'me', text: `${txt} ${i + 1}`, startMs: i * 3000, endMs: i * 3000 + 2500 }))
    const sessions = [
      { title: '', startedAt: now - 86400000, endedAt: now - 86400000 + 1800000, segments: segs(12, '對方說的句子') },
      { title: longTitle, startedAt: now - 172800000, endedAt: now - 172800000 + 2400000, segments: segs(30, '很長的一段逐字稿內容') }
    ]
    const practice = [
      { position: '產品經理', type: '行為面試', questions: ['請介紹一個你主導的專案', '遇到的最大阻力是什麼'], answers: [{ question: '請介紹一個你主導的專案', answerTranscript: '我負責了這個專案…', durationSec: 92 }], createdAt: now - 3600000 },
      { position: longTitle, type: '技術面試', questions: Array.from({ length: 12 }, (_, i) => `這是一個刻意很長的問題編號 ${i + 1} 用來測試列表版面`), answers: [], createdAt: now - 7200000 }
    ]
    const counts = {
      scripts: await putAll(db, 'scripts', scripts),
      sessions: await putAll(db, 'sessions', sessions),
      practiceRuns: await putAll(db, 'practiceRuns', practice)
    }
    db.close()
    return counts
  })
}

// ───────────────────────── 小工具 ─────────────────────────
const nav = (main, id) => main.evaluate((x) => window.__auditForce?.('app.navigate', x), id)

/**
 * 每個區塊開始前把 renderer 重新載入,回到乾淨狀態。
 *
 * 為什麼需要(這是掃描器自己的 bug,不是 App 的缺陷):前一段留下 dirty 草稿時,
 * 下一段按「新講稿」會先跳出 Scripts 的「有未儲存的修改」確認框,於是刪除鈕
 * 根本不存在 —— 報告看起來像「刪除對話框有問題」,實際上量到的是另一個對話框。
 * 共用殘留狀態會讓每一段都不可信,所以寧可多花一次重新載入。
 *
 * 重新載入不會動到 IndexedDB(資料是播種進去的),也不會丟掉 AUDIT 橋。
 */
/**
 * 切頁並等到「內容真的換了」,而不是等一個固定時間。
 *
 * 為什麼需要:Record / Practice 的列表是 mount 時從 IndexedDB 讀的。若在同一頁
 * 反覆 nav(例如 reset 後本來就停在 record),useEffect 不會重跑,列表也就永遠
 * 停在「還沒有紀錄」—— 掃描器會以為「沒有資料所以沒有刪除鈕」,把一個
 * 沒量到的狀態報成「沒問題」。先跳去 dashboard 再回來可以保證真的重新 mount。
 *
 * 失敗時把頁面可見文字一起回報:只說「找不到按鈕」是沒辦法除錯的。
 */
async function goto(main, id, settle = 1500) {
  await nav(main, 'dashboard')
  await sleep(500)
  await nav(main, id)
  await sleep(settle)
}

/** 診斷:目前頁面看得到什麼、按鈕幾個 */
async function probe(main) {
  return main.evaluate(() => ({
    text: (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ').slice(0, 100),
    buttons: document.querySelectorAll('main button').length,
    titles: [...document.querySelectorAll('main button')]
      .map((b) => b.getAttribute('title') || (b.textContent || '').trim().slice(0, 8))
      .filter(Boolean)
      .slice(0, 14)
  }))
}

async function resetMain(main) {
  await main.reload().catch(() => {})
  for (let i = 0; i < 20; i++) {
    const ok = await main
      .evaluate(() => !!document.querySelector('aside') && typeof window.__auditForce === 'function')
      .catch(() => false)
    if (ok) break
    await sleep(500)
  }
  await sleep(700)
  // 舊的對話框/toast 狀態會隨重新載入消失,這正是我們要的
  const leftover = await main.evaluate(() => !!document.querySelector('[role="dialog"]'))
  if (leftover) report.add('dialog-leftover', 'reset', '重新載入後確認對話框還在 —— 它可能橫跨了區塊邊界')
}

/** 用可見文字或 title 找按鈕並點擊(走真實 click,不 dispatchEvent) */
/**
 * 等到控制項真的出現再點擊(最多 timeoutMs),而不是「睡固定時間後 hope」。
 *
 * 這一版是被自己的 bug 教訓逼出來的:原本 clickBtn 只試一次,結果在 Record /
 * Practice 的列表「刪除」按鈕上一律失敗 —— 而緊接著的診斷探針卻列出那些按鈕。
 * 也就是說按鈕確實存在,只是比我的等待時間晚一點到。與其推理它晚多久,
 * 不如把「等它出現」變成動作本身:稽核工具應該描述它要操作的狀態,而不是
 * 假設狀態已經在那裡。
 *
 * 匹配語法:字串以 't=' 開頭比對可見文字,否則比對 title。多個條件用 '|' 分隔。
 */
async function waitClick(main, match, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await main.evaluate((m) => {
      const b = [...document.querySelectorAll('button')].find((x) => {
        const txt = (x.textContent || '').trim()
        const ti = x.getAttribute('title') || ''
        // 預設「title 或可見文字」任一命中即可;前綴 't=' / 'ti=' 用來收窄。
        // 原本的語義是「只有 t= 才看文字,ti= 只看 title」,而記錄/練習列表的刪除鈕
        // 是 icon-only(文字在 textContent、title 也在),一旦哪一個對不上就整個漏掉 ——
        // 這個函式為此卡了一輪才發現。放寬比收窄安全:多命中一次頂多點錯一顆,
        // 漏掉則是整個狀態被記成 unreached。
        return m.split('|').some((k) => {
          const key = k.replace(/^(t|ti)=/, '')
          const wantText = k.startsWith('t=')
          const wantTitle = k.startsWith('ti=')
          if (wantText) return txt.includes(key)
          if (wantTitle) return ti.includes(key)
          return ti.includes(key) || txt.includes(key)
        })
      })
      if (!b) return false
      b.click()
      return true
    }, match)
    if (ok) return true
    if (Date.now() > deadline) {
      // 失敗時把它看到的按鈕標題帶回來。只回報「找不到」是沒辦法除錯的 ——
      // 這個函式自己就因為「不知道按鈕到底存不存在」卡過一輪。
      const seen = await main
        .evaluate(() =>
          [...document.querySelectorAll('button')]
            .map((b, i) => i + ':' + (b.getAttribute('title') || (b.textContent || '').trim().slice(0, 8) || '(無)'))
            .slice(0, 20)
        )
        .catch(() => ['(讀不到)'])
      report.note(`waitClick.miss:${match}`, `看到 ${seen.length} 顆按鈕: ${seen.join(' / ')}`)
      return false
    }
    await sleep(200)
  }
}

/** 一次點擊(沿用舊名稱的呼叫端全部改用 waitClick,這裡保留相容包裝) */
async function clickBtn(main, match) {
  return waitClick(main, match, 2000)
}

async function typeInto(main, placeholderFragment, text) {
  return main.evaluate(([frag, val]) => {
    const el = [...document.querySelectorAll('input,textarea')].find((i) => (i.placeholder || '').includes(frag))
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
    if (setter) setter.call(el, val)
    else el.value = val
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, [placeholderFragment, text])
}

/** 確認對話框的互動斷言:一次量完 focus 落點、Tab 循環、Esc 行為、可見性 */
async function inspectDialog(main, label, expect) {
  const state = await main.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    if (!d) return { present: false }
    const r = d.getBoundingClientRect()
    const cs = getComputedStyle(d)
    return {
      present: true,
      title: (d.querySelector('#confirm-title')?.textContent || '').trim(),
      body: (d.querySelector('#confirm-body')?.textContent || '').trim(),
      ok: (d.querySelector('[data-confirm="ok"]')?.textContent || '').trim(),
      cancel: (d.querySelector('[data-confirm="cancel"]')?.textContent || '').trim(),
      focused: document.activeElement?.getAttribute('data-confirm') || document.activeElement?.tagName || '(none)',
      rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
      vw: window.innerWidth,
      vh: window.innerHeight,
      z: cs.zIndex,
      // 背景是否還能被 Tab 到(焦點陷阱失效的徵兆)
      backgroundFocusable: [...document.querySelectorAll('aside button, main input, main button')].length
    }
  })
  if (!state.present) {
    report.unreached(label, '確認對話框沒有出現(無法到達這個狀態)')
    return null
  }
  // 破壞性操作的預設焦點必須是取消,不是確認
  if (state.focused !== 'cancel') {
    report.add('dialog-focus-wrong', label, `焦點在「${state.focused}」而不是取消鍵 —— Enter 可能直接執行破壞性操作`)
  }
  if (state.rect.w + state.rect.left > state.vw + 1 || state.rect.left < -1 || state.rect.h + state.rect.top > state.vh + 1 || state.rect.top < -1) {
    report.add('dialog-overflow', label, `對話框 ${state.rect.w}×${state.rect.h} @ (${state.rect.left},${state.rect.top}) 超出視窗 ${state.vw}×${state.vh}`)
  }
  if (expect?.cancel && state.cancel !== expect.cancel) {
    report.add('dialog-label-unexpected', label, `取消鍵是「${state.cancel}」`)
  }
  // 確認鍵文案必須說清楚「會發生什麼」,而不只是「確定」
  if (['確定', '確定嗎', 'OK', 'Yes'].includes(state.ok)) {
    report.add('dialog-vague-confirm', label, `確認鍵只有「${state.ok}」—— 使用者看不出按下去會發生什麼`)
  }
  report.measured(`${label}(「${state.title}」取消:${state.cancel} 確認:${state.ok} ${state.rect.w}×${state.rect.h})`)
  return state
}

/** 量一次畫面:domAudit + 溢出 + 截圖 */
async function shoot(win, label, file) {
  const dom = await win.evaluate(domAudit).catch((e) => [{ kind: 'audit-failed', text: e.message }])
  for (const d of dom) report.add(d.kind, label, d.text)
  const ov = await win
    .evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight
    }))
    .catch(() => null)
  if (ov && ov.sw > ov.cw + 1) report.add('overflow-x', label, `scrollWidth=${ov.sw} > clientWidth=${ov.cw}`)
  const path = join(OUT, `${file}.png`)
  await win.screenshot({ path }).catch(() => {})
  // 這裡必須記 measured:有量到就該出現在涵蓋率裡。少了這行,toast/* 與 data/*
  // 這十幾個狀態會被跑過、會回報問題,卻不出現在 meta.auditedStates ——
  // 報告會少數狀態數,而那正是「這個報告到底量了多少」的答案。
  report.measured(label)
  return path
}

// ───────────────────────── A1 確認對話框 ─────────────────────────
/**
 * 七個確認對話框全部靠真實點擊到達。
 *
 * 每個對話框都自帶完整的準備步驟(導航 → 確保有對應資料 → 觸發),
 * 不可共用前一個的殘留狀態 —— 共用時第二個對話框會因為「上一個已經把草稿
 * 清掉」而根本不出現,報告上看起來像「這個對話框沒問題」,實際上是沒量到。
 * 到不了的狀態一律報 unreached。
 */
async function phaseDialogs(main, tag) {
  await resetMain(main)

  // ── 1. 講稿有未儲存修改 → 側欄切頁 ──
  {
    const label = `dialog/nav-away${tag}`
    await nav(main, 'scripts')
    await sleep(1300)
    if (!(await clickBtn(main, 't=新講稿'))) report.unreached(label, '找不到「新講稿」按鈕')
    await sleep(800)
    if (!(await typeInto(main, '講稿標題', '稽核用的未儲存標題')))
      report.unreached(label, '找不到講稿標題輸入框,無法製造 dirty 狀態')
    await sleep(500)
    await clickBtn(main, 't=總覽')
    await sleep(800)
    await inspectDialog(main, label, { cancel: '取消' })

    // Tab 與 Shift+Tab 必須留在對話框內
    await main.keyboard.press('Tab').catch(() => {})
    await sleep(200)
    const inside = await main.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      return d ? d.contains(document.activeElement) : null
    })
    if (inside === false)
      report.add('dialog-focus-escape', label, '對話框開著時 Tab 跑到背景去了 —— 焦點應該鎖在對話框內')

    // Esc 關閉後焦點要回到開啟前的元素,否則鍵盤使用者得從頭 Tab 一次
    const opener = await main.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      return d ? d.getAttribute('data-opener') : null
    })
    void opener
    await main.keyboard.press('Escape').catch(() => {})
    await sleep(700)
    if (await main.evaluate(() => !!document.querySelector('[role="dialog"]')))
      report.add('dialog-esc-ignored', label, 'Esc 沒有關閉確認對話框')
    await shoot(main, label, `dialog-nav-away${tag}`)
  }

  // ── 2. 刪除講稿(danger) ──
  {
    const label = `dialog/delete-script${tag}`
    await resetMain(main)
    await goto(main, 'scripts', 1500)
    if (!(await clickBtn(main, 't=新講稿'))) report.unreached(label, '找不到「新講稿」按鈕')
    await sleep(900)
    await typeInto(main, '講稿標題', '要刪掉的講稿')
    await sleep(500)
    if (!(await waitClick(main, 'ti=刪除這份講稿', 8000))) {
      const p = await probe(main)
      report.unreached(label, `找不到「刪除這份講稿」按鈕。按鈕 ${p.buttons} 個:${p.titles.join('/')} | 文字:${p.text}`)
    }
    await sleep(800)
    const d = await inspectDialog(main, label)
    if (d && !/刪除/.test(d.ok)) report.add('dialog-danger-style', label, `確認鍵是「${d.ok}」,沒有把「刪除」講出來`)
    if (d && d.title && !/刪除/.test(d.title)) report.add('dialog-wrong-title', label, `標題是「${d.title}」,但這裡應該是刪除確認`)
    await shoot(main, label, `dialog-delete-script${tag}`)
    await main.keyboard.press('Escape').catch(() => {})
    await sleep(500)
  }

  // ── 3. 刪除會議紀錄(danger) ──
  {
    const label = `dialog/delete-session${tag}`
    await resetMain(main)
    await goto(main, 'record', 1800)
    if (!(await waitClick(main, 'ti=刪除這場會議紀錄', 8000))) {
      const p = await probe(main)
      report.unreached(label, `找不到「刪除這場會議紀錄」按鈕。按鈕 ${p.buttons} 個:${p.titles.join('/')} | 文字:${p.text}`)
    }
    await sleep(800)
    const d = await inspectDialog(main, label)
    if (d && !/刪除/.test(d.ok)) report.add('dialog-danger-style', label, `確認鍵是「${d.ok}」`)
    await shoot(main, label, `dialog-delete-session${tag}`)
    await main.keyboard.press('Escape').catch(() => {})
    await sleep(500)
  }

  // ── 4. 刪除練習紀錄(danger) ──
  {
    const label = `dialog/delete-practice${tag}`
    await resetMain(main)
    await goto(main, 'practice', 1800)
    if (!(await waitClick(main, 'ti=刪除這次練習紀錄', 8000))) {
      const p = await probe(main)
      report.unreached(label, `找不到「刪除這次練習紀錄」按鈕。按鈕 ${p.buttons} 個:${p.titles.join('/')} | 文字:${p.text}`)
    }
    await sleep(800)
    const d = await inspectDialog(main, label)
    if (d && !/刪除/.test(d.ok)) report.add('dialog-danger-style', label, `確認鍵是「${d.ok}」`)
    await shoot(main, label, `dialog-delete-practice${tag}`)
    await main.keyboard.press('Escape').catch(() => {})
    await sleep(500)
  }
}

// ───────────────────────── A2 Toast ─────────────────────────
/**
 * Toast 有三個已知風險,沒有一個有測試守住:
 *   1. 對話框開著時被遮罩壓暗(上一輪才把 z-index 從 50 提到 90)
 *   2. 錯誤 toast 的停留時間夠不夠
 *   3. hover 暫停是否真的暫停
 * 這裡用 debug 訊號觸發不了 toast(toast 是 renderer 內部狀態),
 * 所以改由「真的觸發一個錯誤」—— 打開雲端 STT 設定後開始錄音最難,
 * 因此用最直接的方式:在頁面上呼叫 toast 模組。若拿不到模組就報 unreached。
 */
async function phaseToasts(main, tag) {
  await resetMain(main)
  const canFire = await main.evaluate(() => typeof window.__auditToast === 'function')
  if (!canFire) {
    report.unreached(`toast/variants${tag}`, '拿不到 toast 橋(window.__auditToast 未掛)—— 這幾個狀態沒有被量到')
    return
  }
  for (const kind of ['error', 'info', 'success']) {
    await main.evaluate((k) => window.__auditToast(k, `稽核用的${k}訊息:連線逾時,請檢查網路後重試`), kind)
    await sleep(600)
    await shoot(main, `toast/${kind}${tag}`, `toast-${kind}${tag}`)
  }
  // 三層堆疊
  for (const kind of ['info', 'success', 'error']) {
    await main.evaluate((k) => window.__auditToast(k, `堆疊測試 ${k} 的訊息`), kind)
  }
  await sleep(700)
  await shoot(main, `toast/stack${tag}`, `toast-stack${tag}`)

  // 關鍵組合:對話框開著時跳一個錯誤 toast。
  // 這是上一輪把 toast 從 z-50 提到 z-[90] 的理由(ConfirmDialog 的遮罩是
  // z-[80] bg-black/55),但那個結論到目前為止只是推理 —— 這裡第一次真的量到。
  await nav(main, 'scripts')
  await sleep(1300)
  if (await clickBtn(main, 't=新講稿')) {
    await sleep(700)
    await typeInto(main, '講稿標題', 'x')
    await sleep(400)
    await clickBtn(main, 't=總覽')
    await sleep(800)
    const open = await main.evaluate(() => !!document.querySelector('[role="dialog"]'))
    if (!open) {
      report.unreached(`toast/over-dialog${tag}`, '對話框沒有開起來,這個組合沒有量到')
    } else {
      await main.evaluate(() => window.__auditToast('error', '儲存失敗:磁碟空間不足,這份變更沒有寫入'))
      await sleep(700)
      // 遮罩是 z-80、toast 是 z-90:toast 必須疊在遮罩之上,否則 12 秒的錯誤
      // 提示會被 55% 的黑壓到讀不到 —— 而那正是把停留時間拉長的全部理由。
      // 直接量 backdrop 自己的 z-index。上一版讀的是按鈕的祖父層(拿到 z=auto),
      // 等於沒有比較 —— 「通過」是假通過。
      const z = await main.evaluate(() => {
        const t = document.querySelector('[role="status"]')
        const backdrop = document.querySelector('[data-modal-backdrop]')
        const box = document.querySelector('[role="dialog"]')
        return {
          toastZ: t ? getComputedStyle(t).zIndex : null,
          backdropZ: backdrop ? getComputedStyle(backdrop).zIndex : null,
          boxZ: box ? getComputedStyle(box).zIndex : null
        }
      })
      report.note(`toast.overDialog.z${tag}`, `toast=${z.toastZ} / backdrop=${z.backdropZ} / dialog=${z.boxZ}`)
      // 只有 toastZ 與 backdropZ 必須是數字。boxZ 是 dialog 本體,它在遮罩**內部**,
      // z-index 自然是 auto —— 要求它是數字等於要求一個永遠量不到的東西,
      // 上一版就是這樣把這個狀態誤報成 unreached 的。
      const nums = [Number(z.toastZ), Number(z.backdropZ)]
      if (!nums.every((n) => Number.isFinite(n))) {
        report.unreached(`toast/over-dialog${tag}`, `量不到 z-index(toast=${z.toastZ} backdrop=${z.backdropZ})`)
      } else if (nums[0] <= nums[1]) {
        report.add('toast-behind-dialog', `toast/over-dialog${tag}`, `toast z=${nums[0]} 沒有高於遮罩 z=${nums[1]} —— 對話框開著時錯誤提示會被壓到陰影裡,而把錯誤停留拉到 12 秒的全部理由就是不能被錯過`)
      } else {
        report.measured(`toast/over-dialog${tag}(toast z=${nums[0]} > 遮罩 z=${nums[1]},錯誤提示不被壓暗)`)
      }
      await shoot(main, `toast/over-dialog${tag}`, `toast-over-dialog${tag}`)
      await main.keyboard.press('Escape').catch(() => {})
      await sleep(400)
    }
  }
}

// ───────────────────────── A3 鍵盤巡覽 ─────────────────────────
/**
 * 每頁 Tab 到底,逐個停靠點檢查:
 *   - focused 元素在可視區內(捲動容器沒有把它帶進來 = 鍵盤使用者迷路)
 *   - computed outline-width > 0(看得見自己在哪)
 * 這是滑鼠操作完全不會暴露的一類缺陷。
 */
async function phaseKeyboard(main, tag, pages) {
  await resetMain(main)
  for (const [id] of pages) {
    await nav(main, id)
    await sleep(1100)
    // 先把焦點丟回 body,確保 Tab 從頁面開頭開始
    await main.evaluate(() => document.activeElement?.blur?.())
    let stops = 0
    // 只 push 不重新賦值 —— const 對這裡才是正確的語意。
    const bad = []
    for (let i = 0; i < 40; i++) {
      await main.keyboard.press('Tab').catch(() => {})
      await sleep(70)
      const s = await main.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return { none: true }
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        const name =
          (el.textContent || '').trim().slice(0, 12) ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          el.tagName
        return {
          name,
          tag: el.tagName,
          top: Math.round(r.top),
          left: Math.round(r.left),
          w: Math.round(r.width),
          h: Math.round(r.height),
          outline: parseFloat(cs.outlineWidth) || 0,
          inView: r.top >= -2 && r.left >= -2 && r.bottom <= window.innerHeight + 2 && r.right <= window.innerWidth + 2,
          onScreen: r.width > 0 && r.height > 0
        }
      })
      if (s.none) break
      stops++
      if (s.onScreen && !s.inView) bad.push(`${s.name}(在 ${s.left},${s.top},超出視窗)`)
      if (s.onScreen && s.outline === 0) bad.push(`${s.name}(focused 但 outline-width=0)`)
      if (stops >= 25) break
    }
    if (stops === 0) {
      report.unreached(`keyboard/${id}${tag}`, 'Tab 走不到任何可聚焦元素')
    } else if (bad.length) {
      for (const b of bad.slice(0, 4)) report.add('keyboard-focus', `keyboard/${id}${tag}`, b)
      report.measured(`keyboard/${id}${tag}(${stops} 個停靠點,${bad.length} 個問題)`)
    } else {
      report.measured(`keyboard/${id}${tag}(${stops} 個停靠點全部有可見焦點且在視窗內)`)
    }
  }
}

// ───────────────────────── A4 有資料的頁面 ─────────────────────────
async function phaseData(main, tag) {
  for (const [id] of [
    ['scripts', '提詞講稿'],
    ['record', '錄音轉錄'],
    ['practice', '面試練習'],
    ['dashboard', '總覽']
  ]) {
    await nav(main, id)
    await sleep(1400)
    await shoot(main, `data/${id}${tag}`, `data-${id}${tag}`)
  }
}

// ───────────────────────── A5 會改變版面的頁面內狀態 ─────────────────────────
/**
 * 這一組是先前四支稽核全部漏掉的那一整塊。
 *
 * 為什麼前一階段的 48 個狀態抓不到它們:那些狀態全部是「疊在頁面上的東西」
 * (對話框、toast、鍵盤巡覽、有資料的頁面),而這裡的每一個都是**頁面本身換了形狀**
 * —— 一個橫幅、一張進度卡、一個被推下去的按鈕。
 *
 * 而且它們的觸發條件在 headless 全部走不到:辨識失敗要連續 3 次 STT 失敗
 * (STT_FAILURE_BANNER_THRESHOLD)、模型下載卡由進度回呼驅動、語速結果要真的量麥克風。
 * 所以只能走 `registerAuditControl` 強制推進 —— 見各頁的 branchState 控制項。
 *
 * 特別值得量的兩個:
 *   - record/practice 的 sttFailed 橫幅:「你講的話不會被存」的唯一提示
 *   - scripts/preview 彈窗:一個 truncate 路徑 + 一個只有圖示的關閉鈕
 *
 * 每個狀態都必須真的渲染出來才記 measured;強制失敗的報 unreached,
 * 否則又會回到「跑了但沒量到,報告看起來全清」那種狀況。
 */
async function phaseBranchStates(main, tag) {
  const cases = [
    {
      page: 'record',
      control: 'record.branchState',
      arg: 'stt-failed',
      label: `branch/record-stt-failed${tag}`,
      file: `branch-record-stt-failed${tag}`,
      expect: '語音辨識持續失敗'
    },
    {
      page: 'record',
      control: 'record.branchState',
      arg: 'model-loading',
      label: `branch/record-model-loading${tag}`,
      file: `branch-record-model-loading${tag}`,
      expect: '下載 Whisper'
    },
    {
      page: 'record',
      control: 'record.branchState',
      arg: 'model-error',
      label: `branch/record-model-error${tag}`,
      file: `branch-record-model-error${tag}`,
      expect: '模型下載失敗'
    },
    {
      page: 'record',
      control: 'record.branchState',
      arg: 'report',
      label: `branch/record-report${tag}`,
      file: `branch-record-report${tag}`,
      expect: null
    },
    {
      page: 'practice',
      control: 'practice.branchState',
      arg: 'stt-failed',
      label: `branch/practice-stt-failed${tag}`,
      file: `branch-practice-stt-failed${tag}`,
      expect: '語音辨識持續失敗'
    },
    {
      page: 'practice',
      control: 'practice.branchState',
      arg: 'model-dl',
      label: `branch/practice-model-dl${tag}`,
      file: `branch-practice-model-dl${tag}`,
      expect: '下載 Whisper'
    },
    {
      page: 'practice',
      control: 'practice.branchState',
      arg: 'busy',
      label: `branch/practice-busy-feedback${tag}`,
      file: `branch-practice-busy-feedback${tag}`,
      expect: 'AI 評分中'
    },
    {
      page: 'calibration',
      control: 'calibration.step',
      arg: 0,
      then: { control: 'calibration.branchState', arg: 'camera-error' },
      label: `branch/calibration-camera-error${tag}`,
      file: `branch-calibration-camera-error${tag}`,
      expect: '攝影機不可用'
    },
    {
      page: 'calibration',
      control: 'calibration.step',
      arg: 1,
      then: { control: 'calibration.branchState', arg: 'model-progress' },
      label: `branch/calibration-model-progress${tag}`,
      file: `branch-calibration-model-progress${tag}`,
      expect: '下載語音模型'
    },
    {
      page: 'calibration',
      control: 'calibration.step',
      arg: 1,
      then: { control: 'calibration.branchState', arg: 'rate-implausible' },
      label: `branch/calibration-rate-implausible${tag}`,
      file: `branch-calibration-rate-implausible${tag}`,
      // 這是唯一一個「量到的是提醒使用者再測一次」的分支
      expect: '建議再測一次'
    },
    {
      page: 'scripts',
      control: 'scripts.preview',
      arg: undefined,
      label: `branch/scripts-preview${tag}`,
      file: `branch-scripts-preview${tag}`,
      expect: '錄影完成'
    }
  ]

  for (const c of cases) {
    await nav(main, 'dashboard')
    await sleep(400)
    await nav(main, c.page)
    await sleep(1300)

    const r1 = await main
      .evaluate(([n, a]) => window.__auditForce?.(n, a) ?? { ok: false, error: 'bridge 不可用' }, [
        c.control,
        c.arg
      ])
      .catch((e) => ({ ok: false, error: String(e) }))
    if (!r1?.ok) {
      report.unreached('force', `${c.label}:${c.control} 未成功(${r1?.error ?? 'ok=false'})`)
      continue
    }
    if (c.then) {
      const r2 = await main
        .evaluate(([n, a]) => window.__auditForce?.(n, a) ?? { ok: false, error: 'bridge 不可用' }, [
          c.then.control,
          c.then.arg
        ])
        .catch((e) => ({ ok: false, error: String(e) }))
      if (!r2?.ok) {
        report.unreached('force', `${c.label}:${c.then.control} 未成功(${r2?.error ?? 'ok=false'})`)
        continue
      }
    }
    await sleep(700)

    // 「強制成功」不等於「真的渲染出來」。這是 auditBridge 註解裡說過的失敗模式:
    // 狀態沒變與沒問題,在報告與截圖上長得一模一樣。
    if (c.expect) {
      const seen = await main
        .evaluate((t) => (document.querySelector('main')?.innerText || '').includes(t), c.expect)
        .catch(() => false)
      if (!seen) {
        report.unreached('force', `${c.label}:找不到「${c.expect}」—— 強制成功但沒渲染`)
        continue
      }
    }
    await shoot(main, c.label, c.file)
  }
}

/**
 * A6 結構不變量:首用卡片唯一性 + 設定頁目錄。
 *
 * 為什麼需要這一相(2026-10-03 新增):
 *   前面五相量的都是**單一元素**的性質 —— 幾何、對比、命中區、遮擋、狀態是否到達。
 *   但有兩類缺陷不屬於任何單一元素:
 *     (1) 「同一頁上有兩張在講同一件事的卡」。總覽頁原本同時有「3 分鐘上手」
 *         與「開始三部曲」,兩張都是三欄按鈕格 + 進度語意,卻定義了不同的三步
 *         —— 而 domAudit 看到的是兩組各自合格的按鈕。只有「數一數有幾張」
 *         量得到它。
 *     (2) 「長頁面上找不到東西」。設定頁九個區塊疊成一頁,每個區塊都合格,
 *         合起來是一個沒有索引的長捲動。目錄的價值在於**跳得到**,
 *         所以這一相不只比對集合,還會真的按最後一個連結一次。
 *
 * 兩個檢查都用新的 data 錨點([data-onboarding] / [data-settings-section] /
 * [data-settings-toc-link])—— 不靠文字比對,因為文字會改,而「找不到元素」
 * 與「這一頁沒問題」在報告上長得一模一樣(同 audit-ui.mjs 檔頭的教訓)。
 */
async function phaseStructure(main) {
  const tag = ''

  // (1) 首用卡片唯一性
  await goto(main, 'dashboard')
  const onboarding = await main
    .evaluate(() => {
      const cards = [...document.querySelectorAll('[data-onboarding]')]
      return {
        count: cards.length,
        labels: cards.map((c) => (c.getAttribute('aria-label') || (c.textContent || '').trim().slice(0, 18)) || '')
      }
    })
    .catch(() => null)
  const label = `structure/onboarding${tag}`
  if (!onboarding) {
    report.unreached(label, '讀不到 [data-onboarding] 數量')
  } else if (onboarding.count > 1) {
    report.add(
      'onboarding-duplicate',
      label,
      `總覽頁有 ${onboarding.count} 張首用進度卡:${onboarding.labels.join(' | ')} —— 使用者會看到兩套「三步」`
    )
  } else {
    report.measured(`${label}(${onboarding.count} 張首用卡)`)
  }

  // (2) 設定頁目錄 ↔ 區塊。雙向相等:
  //     目錄漏一個區塊 = 那個區塊沒有入口;目錄多一個 = 點下去沒有反應,
  //     而「按了沒反應」比「沒有入口」更糟(它看起來像壞掉)。
  await goto(main, 'settings')
  const toc = await main
    .evaluate(() => {
      const sections = [...document.querySelectorAll('[data-settings-section]')].map((s) =>
        s.getAttribute('data-settings-section')
      )
      const links = [...document.querySelectorAll('[data-settings-toc-link]')].map((a) =>
        a.getAttribute('data-settings-toc-link')
      )
      return {
        sections,
        links,
        // 有 id 屬性但 getElementById 找不到 = 目錄的捲動目標不存在
        brokenAnchors: sections.filter((id) => !document.getElementById(id))
      }
    })
    .catch(() => null)
  const tocLabel = `structure/settings-toc${tag}`
  if (!toc) {
    report.unreached(tocLabel, '讀不到設定頁目錄')
    return
  }

  const missing = toc.sections.filter((id) => !toc.links.includes(id))
  const extra = toc.links.filter((id) => !toc.sections.includes(id))
  if (missing.length) report.add('settings-toc-missing', tocLabel, `目錄缺少區塊:${missing.join('、')}`)
  if (extra.length) report.add('settings-toc-extra', tocLabel, `目錄指向不存在的區塊:${extra.join('、')}`)
  if (toc.brokenAnchors.length) {
    report.add('settings-toc-broken-anchor', tocLabel, `這些 id 過不了 getElementById:${toc.brokenAnchors.join('、')}`)
  }
  if (toc.sections.length === 0 || toc.links.length === 0) {
    report.add('settings-toc-missing', tocLabel, `沒有量到區塊或目錄(sections=${toc.sections.length}, links=${toc.links.length})`)
    return
  }

  // 真的按一次最後一個連結:目錄的用途就是「跳得到」
  const last = toc.links[toc.links.length - 1]
  const before = await main.evaluate(() => document.querySelector('main')?.scrollTop ?? 0)
  // 點擊失敗要現形。這裡原本是 `.catch(() => {})` —— 而「點不到」與
  // 「點下去但沒反應」在報告上長得一模一樣,兩者的修正方向卻完全不同
  // (一個是工具找不到元素,一個是產品壞了)。
  const clickErr = await main
    .click(`[data-settings-toc-link="${last}"]`, { timeout: 5000 })
    .then(() => null)
    .catch((e) => e.message.split('\n')[0])
  if (clickErr) {
    report.add('settings-toc-not-clickable', tocLabel, `目錄項「${last}」點不到:${clickErr}`)
    return
  }

  // 等捲動**停下來**,而不是假設一個時間。
  // 這一版是被自己的誤報逼出來的:原本固定等 800ms,而 1180×780 的設定頁有
  // 3657px 可捲 —— 平滑捲動跑完要 ~1.7s,於是量到的 top=807(還在視窗外),
  // 被報成「目錄跳不到」。那是**量測時機**的錯,不是產品的錯,而這種誤報
  // 會讓人開始不信任整份報告。
  let prevScroll = -1
  let stable = 0
  for (let i = 0; i < 20 && stable < 2; i++) {
    await sleep(200)
    const now = await main.evaluate(() => document.querySelector('main')?.scrollTop ?? 0)
    if (now === prevScroll) stable += 1
    else stable = 0
    prevScroll = now
  }

  const jumped = await main
    .evaluate(
      (id) => {
        const el = document.getElementById(id)
        if (!el) return { ok: false, top: null, scroll: 0 }
        const r = el.getBoundingClientRect()
        // 「跳得到」的判準是「區塊真的在視窗裡」,不是「它正好貼齊頂端」:
        // 最後一個區塊跳過去時,頁面已經到底、不能再捲,它會停在視窗下半部
        // (實測 960×640 時 top=390)。要求貼齊頂端會把「正常」報成缺陷 ——
        // 而誤報正是這份報告最容易被丟掉的原因。
        return {
          ok: r.top > -4 && r.top < window.innerHeight - 40,
          top: Math.round(r.top),
          scroll: document.querySelector('main')?.scrollTop ?? 0
        }
      },
      last
    )
    .catch(() => ({ ok: false, top: null, scroll: 0 }))
  if (!jumped.ok) {
    report.add('settings-toc-no-scroll', tocLabel, `點了「${last}」但區塊沒有進入視窗(top=${jumped.top})`)
  } else if (jumped.scroll <= before) {
    report.add('settings-toc-no-scroll', tocLabel, `點了「${last}」但頁面沒有捲動(scrollTop ${before} → ${jumped.scroll})`)
  } else {
    report.measured(
      `${tocLabel}(${toc.sections.length} 個區塊 ↔ ${toc.links.length} 個目錄項,雙向相符;點「${last}」會捲到 top=${jumped.top})`
    )
  }
}

/**
 * A7 熱鍵註冊失敗的**告知範圍**(2026-10-03 第二輪新增)。
 *
 * 這一條抓的是 P1-D:警示原本只長在設定頁,而**使用者的第一眼是側欄**。
 * 側欄每一頁都在無條件白紙黑字寫著 `Ctrl+Alt+T 顯示 / 隱藏浮層`,於是在
 * 「那顆鍵被別的程式搶走」的機器上,App 的兩個畫面講了兩件互相矛盾的話:
 * 一個在承諾,一個在道歉 —— 而使用者先看到的是承諾那個。
 *
 * 為什麼必須自己製造衝突(而不是等真的衝突):乾淨的機器上
 * `appInfo().hotkeyConflicts` 永遠是空陣列,於是這條規則在 CI 上永遠綠燈 ——
 * 而「永遠綠燈」正是這個專案寫過的教訓(見 P1-2 的 aria-label 註解)。
 * 所以用稽核橋 `app.hotkeyConflicts` 覆寫(熱鍵的清單只存在 main 那一處
 * 判定裡,這裡不會去真的占用 OS 熱鍵 —— 那才是量測端做文章)。
 *
 * 量的是**三個承諾點**,不是「有沒有警告」:
 *   1. 側欄那一行必須改成「註冊失敗」而不是繼續承諾功能
 *   2. 總覽頁的熱鍵 footer 必須出現衝突註記(它是第二個無條件寫出組合的地方)
 *   3. 衝突鈕按下之後要真的到得了設定頁(有告知但到不了,等於沒告知)
 * 順便驗**收回**:覆寫清空後警示必須跟著消失 —— 留在畫面上的過期警告會讓人
 * 去查一個已經修好的問題,比沒有警告更糟(這是 hotkeys.ts 頭上寫的理由)。
 */
async function phaseHotkeys(main) {
  const label = 'structure/hotkey-conflict'
  // 先把世界弄成「有衝突」。toggleOverlay 是側欄與總覽頁都會寫出來的那一顆,
  // 用它當衝突名單才量得到真正的失效:只塞一個不相干的組合,兩處都照樣
  // 寫著「顯示 / 隱藏浮層」,那正是這個缺陷的形狀。
  const applied = await main.evaluate(async () => {
    // 用「設定裡真正的 toggleOverlay」當衝突名單,不要寫死字串:
    // 寫死的話,預設值一改,這條規則會安靜地開始量一個不相干的組合 ——
    // 而它的失效症狀(兩處都還在承諾)看起來跟真的量到一模一樣。
    const settings = await window.api.getSettings().catch(() => null)
    const key = settings?.hotkeys?.toggleOverlay ?? 'Control+Alt+T'
    const r = await window.__auditForce?.('app.hotkeyConflicts', [key])
    return { ok: r?.ok === true, error: r?.error ?? null, key }
  })
  if (!applied.ok) {
    report.unreached(label, `app.hotkeyConflicts 稽核橋未生效(${applied.error ?? 'ok=false'})—— 熱鍵衝突這一格完全沒量到`)
    return
  }
  await sleep(700)

  await goto(main, 'dashboard')
  const seen = await main
    .evaluate(() => {
      const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
      const sidebar = document.querySelector('aside')
      const notice = document.querySelector('[data-hotkey-conflict]')
      const btn = document.querySelector('[data-effect-id="hotkey-conflict"]')
      const footerNote = document.querySelector('main [data-hotkey-conflict]')
      return {
        // 側欄那一行:在衝突狀態下必須**否認**功能,而不是照舊承諾
        sidebarText: txt(sidebar),
        noticeText: txt(notice),
        noticeInSidebar: !!(notice && sidebar?.contains(notice)),
        footerNote: !!footerNote,
        hasButton: !!btn,
        buttonText: txt(btn).slice(0, 30)
      }
    })
    .catch(() => null)
  if (!seen) {
    report.unreached(label, '讀不到側欄／總覽頁的熱鍵區塊')
    return
  }

  const problems = []
  if (!seen.noticeInSidebar) {
    problems.push('側欄仍然在無條件承諾熱鍵功能(沒有 data-hotkey-conflict)')
  } else if (/註冊失敗|沒有註冊成功/.test(seen.noticeText) === false && seen.sidebarText.includes('顯示 / 隱藏浮層')) {
    // 只掛屬性、不改文案是最容易犯的半套修法:警示長在旁邊,而那一行照舊
    // 寫著「顯示 / 隱藏浮層」—— 使用者還是會照著按。
    problems.push(`側欄的警示文字沒有否認功能:${JSON.stringify(seen.noticeText.slice(0, 40))}`)
  }
  if (!seen.footerNote) problems.push('總覽頁的熱鍵 footer 沒有標出衝突(它照樣把組合寫給使用者)')
  if (!seen.hasButton) problems.push('側欄沒有「到設定頁修改」的出口(有告知但到不了)')

  if (problems.length) {
    for (const p of problems) report.add('hotkey-conflict-undisclosed', label, p)
    return
  }

  // 出口真的到得了設定頁:clickEffectId 的身分是 data-effect-id,不靠文案
  const before = await main.evaluate(() => location.hash)
  const clicked = await main
    .click('[data-effect-id="hotkey-conflict"]', { timeout: 5000 })
    .then(() => null)
    .catch((e) => e.message.split('\n')[0])
  if (clicked) {
    report.add('hotkey-conflict-unreachable', label, `衝突鈕點不到:${clicked}`)
  } else {
    await sleep(900)
    const after = await main.evaluate(() => location.hash)
    if (after.includes('settings') && after !== before) {
      report.measured(`${label}(側欄/總覽頁都告知,衝突鈕導航 ${before} → ${after})`)
    } else {
      report.add('hotkey-conflict-unreachable', label, `按了衝突鈕但 hash 是 ${after}(預期 #/settings)`)
    }
  }

  // 收回:過期警示比沒有警示更糟
  const cleared = await main.evaluate(async () => {
    const r = await window.__auditForce?.('app.hotkeyConflicts', null)
    return r?.ok === true
  })
  if (!cleared) {
    report.unreached(label, 'app.hotkeyConflicts(null) 沒有生效 —— 過期警示這一格沒量到')
    return
  }
  await sleep(700)
  const stale = await main.evaluate(() => ({
    notice: !!document.querySelector('[data-hotkey-conflict]'),
    button: !!document.querySelector('[data-effect-id="hotkey-conflict"]')
  }))
  if (stale.notice || stale.button) {
    report.add(
      'hotkey-conflict-stale',
      label,
      `衝突清單清空後畫面上還留著警示(notice=${stale.notice}, button=${stale.button})—— 過期的警告會讓人去查一個已經修好的問題`
    )
  }
}

// ───────────────────────── main ─────────────────────────
async function main_() {
  const srcLen = guardSerializable(domAudit, 'domAudit')
  console.log(`domAudit 序列化檢查通過(${srcLen} 字元)`)

  const app = await electron.launch({ args: ['.'], timeout: 60_000 })
  let main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  for (let i = 0; i < 15; i++) {
    if (await main.evaluate(() => !!document.querySelector('aside')).catch(() => false)) break
    await sleep(500)
    const c = app.windows().find((w) => w !== main)
    if (c && (await c.evaluate(() => !!document.querySelector('aside')).catch(() => false))) main = c
  }
  await main.setViewportSize(VIEWPORTS[0]).catch(() => {})
  await sleep(1200)

  const bridge = await main.evaluate(() => typeof window.__auditForce === 'function').catch(() => false)
  if (!bridge) report.unreached('boot', 'window.__auditForce 不存在(AI_TP_AUDIT 沒生效)—— 所有狀態都會失敗')

  console.log('播種測試資料…')
  const counts = await seed(main).catch((e) => ({ error: String(e) }))
  console.log('  ', JSON.stringify(counts))

  const PAGES = [
    ['dashboard', '總覽'],
    ['scripts', '提詞講稿'],
    ['record', '錄音轉錄'],
    ['practice', '面試練習'],
    ['settings', '設定'],
    ['calibration', '個人化校準']
  ]

  for (const vp of VIEWPORTS) {
    await main.setViewportSize(vp).catch(() => {})
    await sleep(900)
    const tag = vp.tag
    console.log(`\n── ${vp.width}×${vp.height} ──`)
    console.log('A1 確認對話框…')
    await phaseDialogs(main, tag)
    console.log('A2 Toast…')
    await phaseToasts(main, tag)
    console.log('A3 鍵盤巡覽…')
    await phaseKeyboard(main, tag, PAGES)
    console.log('A4 有資料的頁面…')
    await phaseData(main, tag)
    console.log('A5 會改變版面的頁面內狀態…')
    await phaseBranchStates(main, tag)
  }

  // A6 只跑一次:這兩個不變量與視窗尺寸無關(它們是結構,不是版面),
  // 兩個尺寸各跑一次只會讓報告多一倍同樣的結論。
  console.log('\nA6 結構不變量(首用卡片唯一性 / 設定頁目錄)…')
  await phaseStructure(main)
  console.log('A7 熱鍵註冊失敗的告知範圍…')
  await phaseHotkeys(main)

  const problems = report.finish(join(OUT, 'report.json'))
  console.log(`\n輸出: ${OUT}/`)
  await app.close()
  return problems
}

main_()
  // 問題數必須進 exit code,理由同 audit-ui.mjs:稽核不擋人的話就只是報表。
  .then((problems) => process.exit(problems.length ? 1 : 0))
  .catch((e) => {
    console.error('ABORT:', e.stack || e.message)
    process.exit(1)
  })
