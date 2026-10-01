/**
 * audit-journey.mjs — 站在**使用者**的位置問問題,不是站在 DOM 的位置。
 *
 * 為什麼需要這一支:
 *   前面三輪(audit-ui / audit-deep / audit-states)量的是「頁面長什麼樣」——
 *   按鈕多大、有沒有可及名稱、有沒有截斷。每一輪都找到真缺陷,那是對的。
 *   但它們**沒有一輪問過「使用者走到這裡會不會卡住」**,而那才是產品真正的失敗。
 *
 *   這個差別在實例上很具體:總覽頁有一張卡片寫著浮層「隱藏中」,
 *   卡片上卻**沒有任何按鈕可以讓它顯示** —— 那張卡片對「只想看看浮層長什麼樣」
 *   的新使用者是純裝飾。而 audit-ui 量了每一顆按鈕的尺寸與命名,全都通過。
 *   按鈕通過是對的:問題不是按鈕壞了,是**按鈕不存在**。
 *
 *   所以這支工具的斷言跟前三支不同:不是「這個元素夠不夠好」,
 *   而是「**使用者想做 X 的時候,有沒有一條路**」。缺的時候報問題,有的時候記下
 *   那條路長什麼樣,讓報告可以回答「這個人現在能做什麼」。
 *
 *   它刻意**不判定美醜**。資訊夠不夠、順序對不對,是使用者測試的事;
 *   這裡只擋「零路徑」與「走了卻沒有回饋」——那是客觀的。
 *
 * 執行:npm run audit:journey(需先 npm run build)
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { createReport } from './lib/audit-report.mjs'

// e2e/稽核隔離:必須在 electron.launch **之前**設好,子程序才會繼承。
// AI_TP_E2E=1 → main 把 userData 重導到暫存目錄(否則會碰到真實使用者資料,
//   而且會跟使用者正在跑的實例搶單一實例鎖,結果是整支腳本卡在 launch)。
// AI_TP_AUDIT=1 → 掛上狀態強制橋 window.__auditForce,這支腳本的導航靠它。
// 與 audit-states.mjs 完全相同。少了第一行時症狀是 launch 一直不出來,
// 而錯誤訊息不會提到 userData —— 這點值得寫下來。
process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'

const OUT = 'docs/audit/journey'
const VIEWPORT = { width: 1280, height: 800 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 啟動並篩出主視窗(有側欄的那個)。理由見 e2e/helpers/launch.ts。 */
async function launch() {
  const app = await electron.launch({ args: ['.'], timeout: 60_000 })
  let main
  for (let i = 0; i < 60 && !main; i++) {
    for (const w of app.windows()) {
      if (await w.evaluate(() => !!document.querySelector('aside')).catch(() => false)) {
        main = w
        break
      }
    }
    if (!main) await sleep(250)
  }
  if (!main) {
    await app.close().catch(() => {})
    throw new Error('15 秒內沒有任何視窗渲染出側欄')
  }
  await main.waitForLoadState('domcontentloaded')
  return { app, main }
}

async function nav(main, id) {
  await main.evaluate((x) => window.__auditForce?.('app.navigate', x), id).catch(() => {})
  await sleep(900)
}

/** 截圖 + 記錄。journey 的每一步都截圖:這是使用者視角的證據,文字描述說不夠。 */
async function shoot(main, label) {
  await main.screenshot({ path: join(OUT, `${label}.png`) }).catch(() => {})
  report.measured(label)
}

/** 主區內所有可點元素的「使用者可見名字」。 */
const READ_CLICKABLE = () => {
  const main_ = document.querySelector('main') || document.body
  const name = (e) =>
    (e.textContent || '').replace(/\s+/g, ' ').trim() ||
    e.getAttribute('aria-label') ||
    e.getAttribute('title') ||
    e.getAttribute('placeholder') ||
    e.tagName.toLowerCase()
  return [...main_.querySelectorAll('button, a[href], input, select, textarea')].map((e) => ({
    name: name(e).slice(0, 30),
    tag: e.tagName.toLowerCase(),
    disabled: e.disabled === true
  }))
}

const READ_TEXT = () => (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ').trim()

/** 依名稱點一個可點元素;回傳有沒有點到。 */
/**
 * 依名稱點一個可點元素;回傳有沒有點到。
 *
 * 為什麼同時比對 title:講稿列表的刪除鈕是 icon-only(沒有可見文字),
 * 它的可及名稱在 title 與 aria-label 上。只比對 textContent 會讓「刪除講稿」
 * 這一條永遠點不到 —— 而那正是最需要驗「真的刪掉沒有」的一條。
 * 這個坑 audit-states.mjs 的註解已經記過一次(waitClick 的前綴語義),
 * 這裡直接採用「文字或 title 或 aria-label 任一命中」。
 */
async function clickByText(main, fragment) {
  return main
    .evaluate((f) => {
      // 範圍是整份 document 而不是 main:確認對話框由 ConfirmHost 渲染在
      // App 层級(App.tsx 的 <ConfirmHost /> 是頁面的兄弟),不在 <main> 裡。
      // 只搜 main 的話「刪除講稿」的確認鈕永遠點不到 —— 而那正是最需要
      // 驗「真的刪掉沒有」的一顆。
      const list = [...document.querySelectorAll('button, a[href]')]
      const hit = list.find((b) => {
        const txt = (b.textContent || '').replace(/s+/g, ' ').trim()
        const ti = b.getAttribute('title') || ''
        const al = b.getAttribute('aria-label') || ''
        return txt.includes(f) || ti.includes(f) || al.includes(f)
      })
      if (!hit) return false
      hit.click()
      return true
    }, fragment)
    .catch(() => false)
}

// ─────────────────────────── 步驟 ───────────────────────────

/**
 * 1. 冷啟動第一眼。
 *
 * 問:我打開一個沒用過的 App,現在知道該做什麼嗎?
 * 判定不是「有沒有引導文案」,而是**「有沒有一個明確的下一步」**:
 * 頁面上可點的元素裡,能不能找出一個看起來就是「開始」的那個。
 */
async function stepFirstSight(main) {
  const text = await main.evaluate(READ_TEXT)
  const clicks = await main.evaluate(READ_CLICKABLE)

  const hasPrep = /還差|準備|Ollama|模型|尚未|還沒有/.test(text)
  report.note('冷啟動可點元素數', clicks.length)

  if (clicks.length === 0) {
    report.add('journey-no-path', '首次開啟', '主區沒有任何可點元素:使用者完全不知道能做什麼')
  }
  // 「開始提詞」必須在有講稿時才出現 —— 這不是缺陷,後面第 3 步會專門量它。
  // 這裡只檢查有沒有任何「繼續往下」的提示。
  if (!hasPrep && !/開始|建立|新增|新講稿/.test(text)) {
    report.add(
      'journey-no-hint',
      '首次開啟',
      '既沒有說缺什麼,也沒有任何指向下一步的文字(使用者只能自己猜)'
    )
  }
  await shoot(main, '01-冷啟動第一眼')
}

/**
 * 3. 想看浮層,但還沒有講稿。
 *
 * 這是這支工具存在的理由。卡片寫著浮層「隱藏中」,使用者讀到的訊息是
 * 「有個東西是關的」—— 而卡片上如果沒有開關,他就永遠打不開。
 *
 * 判定:有沒有任何一條路徑能在**沒有講稿**的情況下顯示浮層。
 * 「按熱鍵」算(使用者看得見熱鍵提示);「開始提詞」不算(它需要講稿)。
 */
async function stepSeeOverlayWithoutScript(main) {
  const text = await main.evaluate(READ_TEXT)
  const clicks = (await main.evaluate(READ_CLICKABLE)).map((c) => c.name)

  const statusChip = /顯示中|隱藏中/.test(text)
  const hotkeyHint = /浮層熱鍵/.test(text)
  const canOpen = clicks.some((n) => /顯示浮層|開啟浮層|顯示浮層視窗|預覽浮層/.test(n))

  report.note('浮層狀態晶片存在', statusChip)
  report.note('浮層熱鍵提示存在', hotkeyHint)
  report.note('無講稿時顯示浮層的按鈕', canOpen ? clicks.find((n) => /浮層/.test(n)) : '（無）')

  if (statusChip && !canOpen && !hotkeyHint) {
    report.add(
      'journey-no-path',
      '想看浮層',
      '總覽頁告訴使用者浮層「隱藏中」,但沒有任何按鈕能打開它,也沒提示熱鍵 —— ' +
        '一個只想看看浮層長什麼樣的人,在還沒有講稿時無路可走'
    )
  }
  await shoot(main, '02-想看浮層但沒講稿')
}

/** 4. 零資料的講稿頁。問:我知道下一步該做什麼嗎? */
async function stepEmptyScripts(main) {
  await nav(main, 'scripts')
  const text = await main.evaluate(READ_TEXT)
  const clicks = (await main.evaluate(READ_CLICKABLE)).map((c) => c.name)

  const isEmpty = /尚未建立講稿|沒有符合的講稿/.test(text)
  if (isEmpty) {
    // 空狀態的文案有沒有指向任何一個真的可以按的東西
    const mentionsAction = /新講稿|匯入|建立/.test(text)
    report.note('空狀態有指向動作', mentionsAction)
    if (!mentionsAction) {
      report.add(
        'journey-dead-end',
        '講稿列表（空）',
        '空狀態只寫「尚未建立講稿」,沒有指向旁邊就有的「新講稿」或匯入鈕 —— ' +
          '使用者要自己猜畫面上哪個東西能做這件事'
      )
    }
  }
  report.note('空講稿頁可點元素', clicks.join(' | ') || '（無）')
  await shoot(main, '03-講稿列表空狀態')
}

/**
 * 7. 錄完一場會議之後。
 *
 * 這是這個產品最大的流程斷點,也是我最想確認的一條:這是**提詞機**,
 * 但錄音產出的是**會議紀錄**。使用者開完會拿到逐字稿,最自然的下一步是
 * 「把這段變成我下次要用的講稿」—— 而程式裡沒有任何一條路做得到。
 * 唯一的下游動作是「匯出 .md 到磁碟」,那是給人看的,不是給這個 App 用的。
 */
async function stepAfterMeeting(main) {

  await nav(main, 'record')
  // 播一場會議進去,展開看使用者有什麼選擇
  const seeded = await main.evaluate(async () => {
    const req = indexedDB.open('ai-teleprompter')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const tx = db.transaction('sessions', 'readwrite')
    const store = tx.objectStore('sessions')
    const now = Date.now()
    store.add({
      title: '產品週會',
      startedAt: now - 1800_000,
      endedAt: now,
      segments: [
        { start: 0, speaker: 'them', text: '今天先聊一下上個季度的進度。' },
        { start: 12, speaker: 'me', text: '我們完成了三個功能，下個季度要開始做效能。' }
      ],
      report: {
        durationSec: 1800,
        mySec: 900,
        theirSec: 900,
        talkRatio: 0.5,
        myUnits: 1200,
        myCpm: 190,
        turnCount: 12,
        avgMyTurnSec: 75,
        longestMyTurnSec: 240,
        gapCount: 2,
        gapTotalSec: 14,
        theirQuestionCount: 3,
        steadiness: 70,
        suggestions: [],
        generatedAt: now
      }
    })
    await new Promise((res) => (tx.oncomplete = res))
    return true
  })
  if (!seeded) {
    report.unreached('after-meeting', '無法播種會議紀錄(IndexedDB 不可寫)')
    return
  }
  await nav(main, 'dashboard')
  await nav(main, 'record')
  await sleep(700)

  // 展開第一場,看使用者實際能按什麼
  await main
    .evaluate(() => {
      const card = document.querySelector('main .card')
      const btn = card?.querySelector('button')
      btn?.click()
    })
    .catch(() => {})
  await sleep(700)

  const clicks = (await main.evaluate(READ_CLICKABLE)).map((c) => c.name)
  report.note('展開會議後的可點元素', clicks.join(' | '))

  // 核心斷言:能不能把逐字稿變成講稿?
  const canMakeScript = clicks.some((n) => /變成講稿|存成講稿|加入講稿|建立講稿|轉為講稿|拿去提詞/.test(n))
  const canExport = clicks.some((n) => /匯出/.test(n))
  report.note('逐字稿可轉為講稿（按鈕存在）', canMakeScript)
  report.note('逐字稿可匯出檔案', canExport)

  // **這一整段是因為負向驗證失敗才寫的。**
  // 原本這裡只比對「有沒有一顆文字叫做存成講稿的按鈕」,於是把它的
  // onClick 指向空函式之後 —— 按鈕還在、文字還對,但按下去什麼都不發生 ——
  // 量測回報 0 筆問題。**按鈕存在不等於路徑存在**,這是和使用者視角
  // 最相關的一種假綠燈:畫面上看起來功能都有。
  // 所以真的點下去,再去 IndexedDB 確認 scripts 真的多了一筆。
  let actuallyWorks = false
  if (canMakeScript) {
  /** scripts 這個 store 現在有幾筆 —— 用來證明「按下去真的有生效」。 */
  const scriptCount = async () =>
    main.evaluate(async () => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction('scripts', 'readonly')
      return new Promise((res) => {
        const r = tx.objectStore('scripts').count()
        r.onsuccess = () => res(r.result)
        r.onerror = () => res(-1)
      })
    })

    const before = await scriptCount()

    await clickByText(main, '存成講稿')
    await sleep(1200)
    const after = await scriptCount()
    actuallyWorks = after > before
    report.note('按下後講稿數 before→after', before + ' → ' + after)
    report.note('逐字稿可轉為講稿（真的按下）', actuallyWorks)
  }

  if (canMakeScript && !actuallyWorks) {
    report.add(
      'journey-broken-flow',
      '錄完一場會議',
      '「存成講稿」按鈕存在,但按下去沒有真的產生講稿' +
        '(IndexedDB 的 scripts 數量沒有變化)—— 使用者會以為存好了,然後找不到它'
    )
  } else if (!canMakeScript && canExport) {
    report.add(
      'journey-broken-flow',
      '錄完一場會議',
      '會議紀錄只能「匯出 .md 到磁碟」,不能變成一份講稿。' +
        '這個 App 的主功能是提詞,但錄音產出的逐字稿無法回到提詞流程 —— ' +
        '使用者得自己複製貼上到講稿頁,這一步沒有任何 UI 指引'
    )
  }
  await shoot(main, '04-錄完會議後有什麼選擇')
}

/** 5. 匯入既有講稿之後,使用者還需要設定什麼? */
async function stepAfterImport(main) {
  const text = await main.evaluate(READ_TEXT)
  const clicks = (await main.evaluate(READ_CLICKABLE)).map((c) => c.name)
  const blockers = /必須先|請先設定|需要設定|尚未設定/.test(text)
  report.note('匯入後是否有擋路設定', blockers)
  report.note('匯入後可點元素', clicks.join(' | '))
  await shoot(main, '05-匯入講稿後')
}

/**
 * 6. 核心動作逐條驗證:每個按鈕都要真的產生效用。
 *
 * 這一則是上一則(「按鈕存在不等於路徑存在」)推廣到其餘動作。
 * 上一輪只驗「逐字稿 → 講稿」一條,理由是那條是唯一被量到的斷路 ——
 * 但「只驗一條」本身就是一個假設,盤點之後發現它站不住:
 *   - **開始提詞**(整個產品的主功能):有 6 個測試會點它,但沒有一個比對
 *     浮層收到的內容。visual.spec.ts 驗的是 hasFilter / hasRefractClass ——
 *     全是外觀。**浮層拿不到內容時,使用者會對著一片空白講整場會議。**
 *   - **刪除講稿**:只有 audit-states 量過,而它只量「對話框有沒有出現」。
 *     確認鍵點下去之後有沒有真的刪掉,從來沒被驗過。
 *
 * 驗證方式統一成:**點下去 → 去資料層(或另一個視窗)確認狀態真的變了**。
 * 刻意不用 toast 或按鈕樣式當證據 —— 那些是 UI 對動作的反應,
 * 而上一輪量到的正是「UI 在假裝成功」。
 */
async function stepCoreActions(app, main) {
  const countScripts = async () =>
    main.evaluate(async () => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction('scripts', 'readonly')
      return new Promise((res) => {
        const r = tx.objectStore('scripts').count()
        r.onsuccess = () => res(r.result)
        r.onerror = () => res(-1)
      })
    })

  await nav(main, 'scripts')
  await sleep(700)

  const beforeNew = await countScripts()
  const clickedNew = await clickByText(main, '新講稿')
  await sleep(1100)
  const afterNew = await countScripts()
  report.note('新講稿 scripts before→after', beforeNew + ' → ' + afterNew)
  if (!clickedNew) {
    report.unreached('core/new-script', '找不到「新講稿」按鈕')
  } else if (afterNew !== beforeNew + 1) {
    report.add(
      'journey-dead-button',
      '講稿列表',
      '按「新講稿」之後 scripts 數量是 ' + beforeNew + ' → ' + afterNew +
        '(預期 +1)—— 使用者按了但沒有東西被建立'
    )
  }
  await shoot(main, '06-按下新講稿之後')

  const SENTINEL = '這是驗證用講稿內容。開會時我會照著這段念。'
  await main
    .locator('textarea')
    .first()
    .fill(SENTINEL)
    .catch(() => {})
  await sleep(800)
  const clickedLaunch = await clickByText(main, '開始提詞')
  await sleep(2200)

  const overlay = app.windows().find((w) => w !== main)
  report.note('開始提詞按到了', clickedLaunch)
  report.note('浮層視窗存在', !!overlay)
  if (!overlay) {
    report.add(
      'journey-broken-flow',
      '開始提詞',
      '按「開始提詞」之後沒有任何浮層視窗 —— 這是整個 App 的主功能,' +
        '使用者按下去等於什麼都沒發生'
    )
  } else {
    await overlay.waitForLoadState('domcontentloaded').catch(() => {})
    await sleep(900)
    const overlayText = await overlay
      .evaluate(() => document.body?.innerText || '')
      .catch(() => '')
    const gotIt = overlayText.includes(SENTINEL.slice(0, 12))
    report.note('浮層帶到了講稿內容', gotIt)
    report.note('浮層文字前 80 字', JSON.stringify(overlayText.replace(/\s+/g, ' ').slice(0, 80)))
    if (!gotIt) {
      report.add(
        'journey-broken-flow',
        '開始提詞',
        '浮層視窗開了,但裡面沒有剛剛輸入的講稿內容。' +
          '使用者會對著空白或舊內容講整場會議 —— ' +
          '而現有測試只驗浮層的外觀(hasFilter / hasRefractClass),所以一直全綠'
      )
    }
    await overlay.screenshot({ path: join(OUT, '07-浮層真的有內容.png') }).catch(() => {})
    report.measured('core/overlay-has-script')
  }

  await nav(main, 'scripts')
  await sleep(800)
  const beforeDel = await countScripts()
  const clickedDel = await clickByText(main, '刪除這份講稿')
  await sleep(800)
  const dialogUp = clickedDel
    ? await main
        .evaluate(() => /刪除「.+」？/.test(document.body.innerText || ''))
        .catch(() => false)
    : false
  // 判斷對話框用「標題形狀」而不是固定字串:標題是 `刪除「<講稿標題>」？`,
  // 講稿標題是使用者自己取的,寫死任何一個都不會對(寫死「刪除這份講稿」
  // 就是我第一版的錯 —— 那其實是按鈕的 title,不是對話框的標題)。
  report.note('刪除有沒有先問', dialogUp)
  if (!clickedDel) {
    report.unreached('core/delete-script', '找不到刪除講稿的按鈕')
  } else if (!dialogUp) {
    report.add(
      'journey-broken-flow',
      '講稿列表',
      '按刪除之後沒有出現確認對話框 —— 誤觸會直接刪掉使用者的講稿'
    )
  } else {
    await clickByText(main, '刪除講稿')
    await sleep(1100)
    const afterDel = await countScripts()
    report.note('刪除講稿 scripts before→after', beforeDel + ' → ' + afterDel)
    if (afterDel >= beforeDel) {
      report.add(
        'journey-dead-button',
        '講稿列表',
        '確認「刪除講稿」之後 scripts 數量是 ' + beforeDel + ' → ' + afterDel +
          '(預期減少)—— 使用者以為刪掉了,重新打開還在'
      )
    }
  }
  await shoot(main, '08-刪除講稿之後')
}

// ─────────────────────────── main ───────────────────────────
const report = createReport('audit-journey')

async function main_() {
  mkdirSync(join(OUT), { recursive: true })
  const srcLen = guardSerializable(READ_CLICKABLE, 'readClickable')
  console.log(`journey 探針序列化檢查通過(${srcLen} 字元)`)

  const { app, main } = await launch()
  await main.setViewportSize(VIEWPORT).catch(() => {})
  await sleep(1200)

  console.log('步驟 1：冷啟動第一眼…')
  await stepFirstSight(main)
  console.log('步驟 2：想看浮層但沒有講稿…')
  await stepSeeOverlayWithoutScript(main)
  console.log('步驟 3：講稿列表空狀態…')
  await stepEmptyScripts(main)
  console.log('步驟 4：錄完一場會議之後…')
  await stepAfterMeeting(main)
  console.log('步驟 5：匯入既有講稿之後…')
  await stepAfterImport(main)
  console.log('步驟 6：核心動作逐條驗證…')
  await stepCoreActions(app, main)

  const problems = report.finish(join(OUT, 'report.json'))
  console.log(`\n輸出: ${OUT}/`)
  await app.close()
  return problems
}

/** 探針必須能序列化過去(page.evaluate 的字串化規則)。 */
function guardSerializable(fn, name) {
  const s = fn.toString()
  if (/=>\s*[^\s]/.test(s) && !s.includes('return')) {
    throw new Error(`${name} 看起來不是可序列化的函式`)
  }
  return s.length
}

main_()
  // 問題數必須進 exit code:這支工具如果抓到死路卻回傳 0,就是又一份綠燈報表。
  .then((problems) => {
    console.log(`\n使用者會卡住的地方:${problems.length} 筆`)
    process.exit(problems.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('ABORT:', e.stack || e.message)
    process.exit(1)
  })
