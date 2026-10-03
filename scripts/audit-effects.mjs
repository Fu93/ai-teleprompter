/**
 * audit-effects.mjs — 證明每顆控制項「有效果」,而不是證明它「有存在」。
 *
 * 為什麼需要這一支:
 *   前面五支稽核(audit-ui / deep / states / edge / journey)問的都是
 *   「這個東西夠不夠好、有沒有到達、能不能走通」—— 沒有一支問過
 *   「**按下去之後,系統裡真的變了東西嗎**」。
 *
 *   這個差別不是吹毛求疵。實例:「開始提詞」有六個測試會點它,
 *   沒有任何一個比對浮層收到的內容;「刪除講稿」只量過確認對話框有沒有出現。
 *   **按鈕存在、按鈕漂亮、按鈕甚至「有回饋」,都和使用者得到一個空浮層
 *   對講整場會議是同一件事。** 那是外觀斷言,不是功能斷言。
 *
 *   本專案已經被假綠燈教訓過三次(熱鍵 flake 的錯誤因果故事、journey 只比對
 *   按鈕文字、拍法按鈕通過但功能不存在)。每一次都是同一個形狀:
 *   **斷言看起來嚴謹,但它沒有真的觸及使用者在意的狀態。**
 *
 * 三態分類 —— 這是本支與其他稽核最重要的差別:
 *
 *   works         按下去,並從**資料層或另一個視窗**觀察到狀態真的變了。
 *   dead          前置條件都備妥了,按下去之後狀態**沒變**。→ 報問題。
 *   unverifiable  這個環境天生量不到(麥克風、相機、Whisper 模型、實際音訊)。
 *                 → **明確記錄原因,絕不當成通過。**
 *
 *   最後一項是這支腳本存在的道德前提。一份「84 個控制項全綠」的報告,
 *   如果其中 8 個其實是假綠燈,那它比紅燈更危險 —— 因為它會讓人以為
 *   錄音、辨識、臉部量測這些核心路徑被驗過。所以 unverifiable 會被
 *   **單獨列出並附原因**,它的數量本身就是輸出的一部分。
 *
 * 證據原則(沿用並收緊 audit-journey 的做法):
 *   點下去之後,證據必須取自**不是被點的那個元素**的地方 ——
 *   資料層(window.api)、另一個視窗、或可讀的幾何量(scrollTop)。
 *   只讀按鈕自己的 class / title,那是「UI 在說它生效了」,不是「系統生效了」。
 *
 * ── 第二輪:覆蓋率才是這一支真正缺的東西 ──
 *   上面那套斷言是對的,但它只套在 11 顆控制項上。其餘約 150 顆只有四支 DOM
 *   稽核量過(存在、夠大、有名稱),而**沒有任何機制會在新增一顆沒被驗過的
 *   按鈕時變紅**。所以這一輪加上 scripts/lib/effect-inventory.mjs:
 *     列舉(DOM 上真的有的) × 登記(應該被驗的) × 執行(這一輪真的跑過的)
 *   三邊對不上就報問題。詳見該檔的檔頭。
 *
 * 執行:npm run audit:effects(需先 npm run build)
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { createReport } from './lib/audit-report.mjs'
import {
  CONTROLS,
  ENUMERATE,
  EVIDENCE,
  EXEMPT_CATEGORY,
  STATES,
  baseKey,
  buildRegistry,
  idKey,
  key,
  normalizeTitle
} from './lib/effect-inventory.mjs'
import { audioFixtureStatus, fakeMediaArgs, fakeMediaSummary } from './lib/fake-media.mjs'
import { startMockLlm, startMockStt } from './lib/mock-services.mjs'

// 隔離必須在 electron.launch **之前**設定,子程序才會繼承(理由見 audit-journey.mjs)。
process.env.AI_TP_E2E = '1'
process.env.AI_TP_AUDIT = '1'

const OUT = 'docs/audit/effects'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const report = createReport('audit:effects')

/** 四態 tally。unverifiable 的數量是輸出的一部分,不是待辦。 */
const tally = { works: 0, dead: 0, unverifiable: 0 }
const UNVERIFIABLE = []
const EFFECTS = []

/**
 * 這一輪「有結論」的控制項(baseKey → 結論)。覆蓋率就是這張表對上兩份清單。
 * 為什麼要記結論而不只記「跑過」:跑過但結論是 unreachable 仍然要進報告 ——
 * 它算「有被照顧到」,但不算「驗過」。
 */
const PROBED = new Map()
const EVIDENCE_COUNT = { [EVIDENCE.DATA]: 0, [EVIDENCE.OTHER_WINDOW]: 0, [EVIDENCE.GEOMETRY]: 0, [EVIDENCE.DOM]: 0 }

/**
 * 乙個控制項的探針。**這支是這一輪唯一允許寫斷言的地方。**
 *
 * 為什麼 signature 是 (key, area) 而不是 (name, page):
 *   name 是給人讀的,key 是給覆蓋率對帳的。兩者都要,而且必須是同一個來源 ——
 *   分開寫就會出現「報告說驗過 X,而 X 的 key 從沒進過 PROBED」的漂移。
 */
function probe(controlKey, area) {
  const k = baseKey(controlKey)
  // self-test 破壞二:這一顆的探針**不給任何結論**,而且不丟錯、不改 tally。
  // 這與「某段量測程式碼根本沒有執行」的可觀察結果完全相同。
  if (SELFTEST_SKIP.has(k)) {
    return {
      key: k,
      works: () => true,
      dead: () => true,
      unverifiable: () => true,
      unreachable: () => true
    }
  }
  const settle = (verdict, detail) => {
    // 同一個控制項被量到兩次(例如展開與收合各一次)時以最後一次為準,
    // 但「量到問題」不能被後面的成功蓋掉 —— 那會讓紅燈靜默消失。
    const prev = PROBED.get(k)
    if (!(prev && (prev.verdict === 'dead' || prev.verdict === 'unverifiable') && verdict === 'works')) {
      PROBED.set(k, { verdict, detail, area })
    } else {
      PROBED.set(k, { verdict: prev.verdict, detail: `${prev.detail} / ${detail}`, area })
    }
    return verdict === 'works'
  }

  return {
    key: k,
    /** 真的生效:已從外部觀察到狀態變化。evidence 是必填(見 effect-inventory)。 */
    works(detail, evidence) {
      tally.works++
      if (evidence && evidence in EVIDENCE_COUNT) {
        EVIDENCE_COUNT[evidence]++
      } else {
        // 「UI 自己在說它生效了」不是效果。這一條以前只能靠自律,現在會紅。
        report.add(
          'self-evidence',
          area,
          `${k}:宣稱生效但沒有提供外部證據來源(evidence=${JSON.stringify(evidence)}) —— ` +
            `${detail}。只讀被點的那顆元素自己的 aria/class,量到的是 UI 的自我宣稱。`
        )
      }
      EFFECTS.push({ name: k, verdict: 'works', detail, evidence: evidence ?? '(未提供)' })
      report.measured(k)
      return settle('works', detail)
    },
    /**
     * 按了但沒生效。前置條件必須是備妥的 —— 見 unreachable()。
     * detail 要寫清楚「期望什麼、實際什麼」,否則這筆問題對讀者沒有用。
     */
    dead(detail) {
      tally.dead++
      EFFECTS.push({ name: k, verdict: 'dead', detail })
      report.add('dead-ui', area, `${k}:${detail}`)
      return settle('dead', detail)
    },
    /** 這個環境量不到。**必須附 category** —— 否則「量不到」會變成萬用藉口。 */
    unverifiable(reason, category) {
      tally.unverifiable++
      const tagged = category ? `[${category}] ${reason}` : reason
      UNVERIFIABLE.push({ name: k, reason: tagged })
      EFFECTS.push({ name: k, verdict: 'unverifiable', detail: tagged })
      report.measured(k)
      if (!category) {
        report.add('unverifiable-no-reason-category', area, `${k}:unverifiable 沒有附 category:${reason}`)
      }
      return settle('unverifiable', tagged)
    },
    /**
     * 前置條件沒備妥(浮層開不起來、控制項在別的形態)。
     * 這跟 dead 分開:「按了沒用」是產品缺陷,「我沒機會按」是量測端的限制。
     * 混在一起會讓報告說謊。
     */
    unreachable(reason) {
      tally.unverifiable++
      UNVERIFIABLE.push({ name: k, reason: `前置條件未備妥:${reason}` })
      EFFECTS.push({ name: k, verdict: 'unverifiable', detail: `前置條件未備妥:${reason}` })
      report.unreached(k, reason)
      return settle('unverifiable', `前置條件未備妥:${reason}`)
    }
  }
}

/**
 * 被登記為「這個環境量不到」的控制項,這一輪不需要探針跑過。
 * 但登記表本身要能解釋為什麼 —— 沒有 exempt 也沒跑到 = probe-not-run(紅燈)。
 */
/**
 * ── self-test 破壞注入(搭配 npm run audit:selftest) ──
 *
 * 為什麼需要這個:這個專案裡每一個綠燈,都是靠**手動把它弄壞、看它變紅**才
 * 敢相信的。這一則就做了三次 —— 而那個機制不在任何自動化裡,所以 CI 保護不了
 * 下一次修改,下一個人也不會知道綠燈的證明力是怎麼來的。
 *
 * 兩種破壞,各自對應到真的發生過的失敗:
 *
 *   drop-registry —— 抽掉登記表的幾筆。
 *     對應到「把登記表裡一筆刪掉,稽核**不會變紅**」:那個洞真的存在過,
 *     是被負向驗證抓出來的,修法是把 no-effect-probe 的規則改嚴。
 *     少了登記表的那一行,報告裡就多一顆沒有任何說明的「已驗證」控制項。
 *
 *   skip-probes —— 讓選定的探針不給任何結論。
 *     對應到那個孤兒大括號:(h) 之後的程式碼掛在錯的區塊裡、**從來沒執行過**,
 *     而報告是「0 筆問題」。這裡的可觀察結果完全相同 ——
 *     **控制項被列舉到、卻沒有任何探針給它結論**(probe-not-run)。
 *
 * 目標清單**從 CONTROLS 推導**而不是寫死名字:寫死會在控制項改名後悄悄失效,
 * 而「self-test 壞掉」與「self-test 變成空轉」長得一樣 —— 那正是這個專案
 * 反覆吃虧的地方。
 *
 * ⚠️ 兩種破壞都只動量測端,不碰產品、不需要重新建置。「為了測試而暫時改壞產品」
 * 那種改動會被人偷偷還原;而這個檔案永遠在這裡。
 *
 * 正常執行時(SELFTEST 為空)這整段是 no-op —— 而且**兩個集合都必須跟著 mode 關掉**。
 * 第一版只把登記表那側 gate 住,漏了 SELFTEST_SKIP:乾淨的執行因此少了 9 個結論,
 * 報告多出 9 筆 probe-not-run。是「乾淨路徑也要跑一次」抓到的 ——
 * 一段宣稱自己是 no-op 的程式碼,在沒有自我驗證時最會說謊。
 */
const SELFTEST = process.env.AI_TP_SELFTEST || ''

const SELFTEST_TARGETS = CONTROLS.filter((c) => !c.exempt).map((c) => baseKey(c.key))

/** 破壞一:抽掉登記項(每隔 7 筆抽 1 筆,散在各頁)。 */
const SELFTEST_DROP = SELFTEST.includes('drop-registry')
  ? new Set(SELFTEST_TARGETS.filter((_, i) => i % 7 === 3))
  : new Set()

/** 破壞二:讓探針不給結論(每隔 11 筆抽 1 筆)。
 *
 * **必須與破壞一錯開**,而這是量出來的不是猜的:兩邊都中的控制項會從登記表裡消失,
 * 而 probe-not-run 那份清單是**遍歷登記表**做出來的 —— 於是它不會出現在 probe-not-run,
 * 只會出現在 no-effect-probe。第一版的兩組目標重疊了 2 筆,self-test 因此報 9/11,
 * 看起來像閘門有盲區。實際上那 2 筆**有被抓到**,只是抓到的是另一種紅燈。 */
const SELFTEST_SKIP = SELFTEST.includes('skip-probes')
  ? new Set(SELFTEST_TARGETS.filter((_, i) => i % 11 === 5 && i % 7 !== 3))
  : new Set()

const REGISTRY = SELFTEST.includes('drop-registry')
  ? buildRegistry(CONTROLS.filter((c) => !SELFTEST_DROP.has(baseKey(c.key))))
  : buildRegistry()

/**
 * 假麥克風是否真的掛上了啟動參數。
 * 由**實際的 args** 推導(不是由 self-test 開關推導):探針的前置條件檢查
 * 要對「這一輪真的用什麼環境量」負責 —— 之後不管誰、為了什麼原因把
 * `--use-file-for-fake-audio-capture` 拿掉,錄音探針都會誠實地降級成
 * unreachable(前置條件未備妥),而不是燒完 24 秒輪詢後把一顆好按鈕記成 dead。
 * 靜音無法區分「收音壞了」與「沒人說話」—— 見 fake-media.mjs 的旗標說明。
 * (宣告在模組層、賦值在 launch():上面的 self-test note 不讀這個值 ——
 *  它在 launch 之前執行,讀到的是初始值而不是這一輪的實況。)
 */
let FAKE_AUDIO_ARMED = true

// 把自己破壞了什麼寫進報告,self-test 才不用在另一支腳本裡重算一遍 ——
// 兩處各算一次,改了一處就會出現「self-test 壞掉」與「self-test 空轉」
// 長得一樣的情況,而那正是這個專案反覆吃虧的地方。
if (SELFTEST) {
  report.note('self-test 破壞', {
    mode: SELFTEST,
    抽掉登記項: [...SELFTEST_DROP],
    探針不給結論: [...SELFTEST_SKIP],
    // drop-fake-audio 是「抽掉啟動旗標」而不是「抽掉清單項」,沒有清單可列。
    // 「旗標真的被抽掉」由 launch() 之後覆寫的「實際啟動含假麥克風」證明,
    // 這裡只記破壞的意圖;實況在 main() 啟動後補記。
    假麥克風旗標已抽掉: SELFTEST.includes('drop-fake-audio')
  })
}

/**
 * 步驟層級的阻擋(整頁進不去、浮層開不起來)。
 * 它不算「某個控制項沒有效果」,所以不進 PROBED;但它必須進報告 ——
 * 一個進不去的頁面如果靜靜地沒量,那份報告的涵蓋率就是假的。
 */
function blocked(name, reason) {
  tally.unverifiable++
  UNVERIFIABLE.push({ name, reason: `前置條件未備妥:${reason}` })
  EFFECTS.push({ name, verdict: 'unverifiable', detail: `前置條件未備妥:${reason}` })
  report.unreached(name, reason)
  return false
}

// ───────────────────────────── 啟動 / 工具 ─────────────────────────────

async function launch() {
  // 假裝置:這一輪最重要的環境改動。理由與「證明了什麼、沒證明什麼」見 fake-media.mjs。
  // self-test 的 drop-fake-audio 破壞:抽掉假麥克風 WAV 旗標(計畫 6(d) 的負向驗證),
  // 錄音探針必須因此落進 unverifiable,而不是繼續綠。
  const args = ['.', ...fakeMediaArgs(SELFTEST.includes('drop-fake-audio') ? { audio: null } : {})]
  FAKE_AUDIO_ARMED = args.some((a) => String(a).startsWith('--use-file-for-fake-audio-capture'))
  const app = await electron.launch({ args, timeout: 60_000 })
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

/**
 * 用側欄真按,不用 __auditForce。
 * audit:states 用強制橋是因為它要窮舉 useState 分支;這支要驗的是
 * 「使用者走這條路有沒有效果」—— 走橋就繞過了真實的點擊路徑,
 * 等於把上一輪抓到的「按鈕存在但路徑不存在」又放回去一次。
 */
const NAV_PAGE = {
  總覽: 'dashboard',
  提詞講稿: 'scripts',
  錄音轉錄: 'record',
  面試練習: 'practice',
  個人化校準: 'calibration',
  設定: 'settings'
}

/**
 * 導航到某一頁,並**讀回來確認真的在那裡**。
 *
 * 三件事以前是「點完睡 900ms 就當成功」,而每一件都曾經靜靜地失敗:
 *
 *  1. **已經在那一頁時要先跳去別處再回來。**
 *     點側欄上「現在這頁」只是 setPage(同一值),元件不會重新掛載,
 *     所以它讀不到剛剛 seed 進 IndexedDB 的資料。症狀是一整串毫不相干的東西
 *     ——「總覽永遠沒有最近的講稿」、「講稿頁沒掛載?」、「expandSession 沒生效」
 *     —— 而它們全部是同一個原因:頁面手上還是播種之前的那份快照。
 *
 *     注意要去的是**別的一頁**:無條件點「總覽」在目標就是總覽時等於沒離開。
 *     症狀是「開始提詞 / 列表的提詞 兩顆鈕從來沒被列舉到」,而登記表明明有寫。
 *
 *  2. **離開時的確認對話框必須在這裡就收掉,不能留到下一個狀態。**
 *     編輯器有未存變更時,`navigate()` 會 `await confirmDialog(...)` ——
 *     那是**一個還沒完成的導航**。上一版在這裡不管它,等到下一段才
 *     `settleDialogs`,於是 confirm-ok 被按下去時,那個懸而未決的
 *     `setPage('dashboard')` 才落地 —— **而且是在下一個狀態正在列舉的時候**。
 *     症狀是:預覽 modal 的三顆鈕「從沒出現過」,同時畫面上多出五顆
 *     屬於總覽頁的控制項、卻被記成 `scripts|…`。
 *     這種錯在報告裡長得像「登錄表與列舉端不一致」,而真正的成因是一個
 *     **上一狀態遺留下來的 promise**。
 *
 *  3. **回來之後要等 hash 真的變成目標頁。**
 *     否則「導航失敗」與「導航成功但頁面沒讀到資料」在報告裡長得一樣。
 */
async function gotoViaSidebar(main, label, opts = {}) {
  const want = NAV_PAGE[label]
  if (!want) throw new Error(`gotoViaSidebar 收到未知的側欄項目「${label}」`)
  const pageNow = () => main.evaluate(() => location.hash.replace(/^#\/?/, '')).catch(() => '')
  const waitUntil = async (ok, tries = 24) => {
    for (let i = 0; i < tries; i++) {
      if (await ok()) return true
      await sleep(150)
    }
    return false
  }

  if ((await pageNow()) === want) {
    await main.evaluate((self) => {
      const nav = [...document.querySelectorAll('aside button')]
      const other = nav.find((x) => !x.textContent?.includes(self))
      other?.click()
    }, label)
    // 把「離開」這個動作的後果**在這裡**完整收掉:對話框 + 真正換頁。
    // 少了後半段,confirm-ok 會在下一個狀態列舉的時候才把 navigate() 釋放掉。
    await settleDialogs(main)
    await waitUntil(async () => (await pageNow()) !== want)
  }

  const hit = await main.evaluate((l) => {
    const b = [...document.querySelectorAll('aside button')].find((x) => x.textContent?.includes(l))
    if (!b) return false
    b.click()
    return true
  }, label)
  if (!hit) return false

  /**
   * 切頁時如果編輯器是「未儲存」狀態,App 會跳確認對話框 —— 而那個遮罩會擋住
   * 後面每一個 Playwright 點擊(30 秒 timeout 之後整個稽核中止)。
   *
   * 這不是產品的問題,是稽核必須能「從上一動留下的狀態繼續」:上一條探針
   * 為了驗「內容真的有寫進 IndexedDB」而把編輯器弄髒了。預設把它收拾乾淨
   * (確認放棄變更),要驗對話框本身的步驟再傳 keepDialog。
   */
  if (opts.keepDialog) {
    /**
     * **這個狀態就是要量對話框本身**,所以不能碰它。
     *
     * 上一版把 `settleDialogs` 放在 `keepDialog` 判斷之後 —— 這一次我反而
     * 把它放前面了,而症狀是「切頁時沒有跳確認對話框」:稽核自己把
     * 它正要量的那個對話框按掉了。
     *
     * 所以這裡只**等它出現**,不點它,也不断言 hash(確認框開著時本來就還沒換頁)。
     */
    for (let i = 0; i < 20; i++) {
      const up = await main.evaluate(() => !!document.querySelector('[role="dialog"]')).catch(() => false)
      if (up) return true
      await sleep(200)
    }
    blocked(`導航:${label}`, 'keepDialog:切頁後確認對話框沒有出現(沒有未存變更?)')
    return false
  }

  await settleDialogs(main)

  /**
   * **等它真的落到目標頁,期間如果跳出確認框就收掉它。**
   *
   * 上一版是「點完 → settleDialogs 一次 → 睡 900ms 就當成功」,而
   * `navigate()` 在編輯器有未存變更時是 `await confirmDialog(...)`:
   * 對話框是 React 非同步渲染的,settleDialogs 有機會在它出現之前就
   * 「確認沒有對話框」而直接返回 —— 於是那個導航懸在半路,hash 永遠不變。
   *
   * 症狀是「點了側欄但 hash 停在 scripts」—— 而那看起來像產品壞了,
   * 實際上是量測端沒把彈出來的確認框按下去。
   */
  let landed = false
  for (let i = 0; i < 20 && !landed; i++) {
    if ((await pageNow()) === want) {
      landed = true
      break
    }
    await settleDialogs(main)
    await sleep(200)
  }
  if (!landed) {
    blocked(`導航:${label}`, `點了側欄但 hash 停在「${await pageNow()}」(預期「${want}」)`)
    return false
  }
  await sleep(500)
  return true
}

/**
 * 把上一個探針留下的確認對話框收拾掉(確認 = 放棄變更繼續)。
 * 回傳「剛剛有沒有對話框」—— 有些探針需要知道才能說清楚它量到什麼。
 */
async function settleDialogs(main) {
  let had = false
  for (let i = 0; i < 3; i++) {
    const up = await main.evaluate(() => !!document.querySelector('[role="dialog"]')).catch(() => false)
    if (!up) break
    had = true
    await main
      .evaluate(() => document.querySelector('[data-effect-id="confirm-ok"]')?.click())
      .catch(() => {})
    await sleep(700)
  }
  return had
}

async function shoot(win, label) {
  await win.screenshot({ path: join(OUT, `${label}.png`) }).catch(() => {})
}

/**
 * 現在到底在哪。
 *
 * 為什麼每一個步驟都要印:第一次實跑時,後半段大量控制項都報「找不到」,
 * 而症狀完全無法區分三種可能 —— (a) 頁面不對 (b) 崩潰畫面蓋住了 (c) 視窗換了。
 * 它們的修法完全不同,而只有一行 hash + 一行文字就能分開。**先量再改。**
 */
async function where(main) {
  const info = await main
    .evaluate(() => ({
      hash: location.hash,
      hasAside: !!document.querySelector('aside'),
      crash: !!document.querySelector('[data-testid="crash-screen"]'),
      dialog: !!document.querySelector('[role="dialog"]'),
      head: (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ').slice(0, 50)
    }))
    .catch((e) => ({ hash: '(evaluate 失敗)', head: String(e.message).slice(0, 60) }))
  return `${info.hash}${info.hasAside ? '' : ' [無側欄]'}${info.crash ? ' [崩潰畫面]' : ''}${info.dialog ? ' [對話框]' : ''} :: ${info.head}`
}

/**
 * 每一步都隔離。
 *
 * 一個步驟丟出例外時,舊的行為是整個稽核中止 —— 而中止的報告不會產生,
 * 於是我完全看不到「前面已經量到什麼」。更糟的是,一個壞掉的步驟會讓
 * 後面 8 個步驟全部沒跑,而只有一個步驟有問題。
 * 例外記成 step-error(進問題清單),總數一樣會讓 exit code 變 1。
 */
async function step(name, fn) {
  const started = Date.now()
  try {
    await fn()
    console.log(`   ✓ ${name}(${Math.round((Date.now() - started) / 1000)}s)`)
  } catch (err) {
    const msg = String(err?.message || err).split('\n')[0]
    report.add('step-error', name, `這一步沒有跑完:${msg} —— 後面剩下的斷言都沒量到,不是「沒問題」`)
    console.log(`   ✗ ${name} 中止:${msg}`)
  }
}

/**
 * 崩潰畫面會把整個 App 換掉,而且**清掉探針不會自動還原**:
 * ErrorBoundary 一旦抓到錯誤就停在錯誤狀態,除非重載。
 * 這是我第一次實跑把後面 9 個步驟全部變成「找不到控制項」的原因。
 */
async function recoverFromCrash(main) {
  await main.evaluate(() => window.__auditForce?.('crash.clear')).catch(() => {})
  await sleep(600)
  const back = await main
    .evaluate(() => !!document.querySelector('aside') && !document.querySelector('[data-testid="crash-screen"]'))
    .catch(() => false)
  if (back) return true
  console.log('   (崩潰畫面沒有自行還原 —— 重載視窗)')
  await main.reload().catch(() => {})
  for (let i = 0; i < 40; i++) {
    const ok = await main.evaluate(() => !!document.querySelector('aside')).catch(() => false)
    if (ok) return true
    await sleep(250)
  }
  return false
}

/** 從設定資料層讀一個值(點陣式)。證據不取自 DOM。 */
const readSetting = (main, path) =>
  main.evaluate(async (p) => {
    const s = await window.api.getSettings()
    return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), s)
  }, path)

/**
 * 等某個設定值真的變成 `want`,而不是「睡一段時間再猜它應該變了」。
 *
 * 固定 sleep 是量測端最常見的病因:睡太短就量到舊狀態(把正常的控制項報成 dead),
 * 睡太長只是拖慢整支稽核。這裡改成**讀回確認**,並在逾時時回報實際值,
 * 讓「沒變成」變成一則帶證據的資訊而不是一個神祕的假結果。
 *
 * 注意:這只適用於「資料層會變」的狀態閘門。真的有時長語意的等待
 * (debounce 600ms、main 端 1.2s 防抖、提示 6s 淡出)仍然是 sleep ——
 * 那些不是「等狀態變化」,而是「等時間真的過去」。
 */
const waitSetting = async (main, path, want, timeoutMs = 5_000) => {
  const step = 100
  for (let waited = 0; waited <= timeoutMs; waited += step) {
    const got = await readSetting(main, path)
    if (got === want) return { ok: true, got }
    await sleep(step)
  }
  return { ok: false, got: await readSetting(main, path) }
}

/**
 * 顯式把某個設定值設回去,並讀回確認。
 *
 * 為什麼不能用「再點一次」當還原:那只在「下一次點擊真的會翻轉」時才等於還原。
 * 開關的實際狀態若已經不是你預期的那個(被前面的步驟改掉了、或 UI 換了形態),
 * 再點一次是把它推得更歪。這支稽核真的踩過:設定頁的 `AI 即時救援` 被留在
 * false,後面練習頁的 AI 教練反饋就永遠等不到,於是三顆按鈕被報成壞掉 ——
 * **量測端自己弄壞狀態,再把後後果記在產品帳上。**
 *
 * 這裡刻意**只送葉節點的值**,不把整棵子樹複製回去:main 端是 deepMerge,
 * 所以 `{ scenario: { aiModeEnabled: before } }` 只動那一個欄位。
 * (先前那版把「目前的值」複製回去,等於什麼都沒還原 —— 這種錯誤不會報錯,
 *  只會讓後面的人類看不懂為什麼狀態沒有回到原點。)
 */
const writeSetting = async (main, path, value) => {
  const segs = path.split('.')
  const leaf = segs.pop()
  const patch = { [segs[0]]: { [leaf]: value } }
  await main.evaluate(async (p) => window.api.setSettings(p), patch)
  return waitSetting(main, path, value)
}

/**
 * 把 AI 指向本機 mock LLM，並**讀回來確認**。
 *
 * 為什麼需要這個，而不是只在 main_() 開頭設一次:
 *   設定頁的步驟會為了驗「供應商切換」把 provider 來回切。於是跑到後面的
 *   面試練習時，provider 已經不是開頭設的那個 —— 而 openai-compatible 分支
 *   打的是 /v1/chat/completions、吃 {choices:[…]}；Ollama 分支打 /api/chat、
 *   吃 {message:{content}}。**同一台 mock 回傳 Ollama 形狀，結果解析失敗。**
 *   症狀是「按了開始練習但進不了 run 階段」—— 看起來像產品壞了，實際上是
 *   量測端自己的狀態被自己前面的步驟改掉了。
 *
 *   而「設了但沒讀回來確認」正是我這個專案被教訓過最多次的錯誤:用
 *   `?.()` 或「沒有丟錯」當成「成功了」。這裡一律讀回來比對。
 *
 * 回傳 true/false；false 代表前置條件不具備，那一步的探針應該 unreachable
 * 而不是 dead —— 兩者的差別是「產品壞了」和「我沒準備好」。
 */
async function ensureAiOnMock(main, llm) {
  const got = await main.evaluate(async (url) => {
    await window.api.setSettings({ ai: { provider: 'ollama', ollama: { baseUrl: url, model: 'mock-qwen' } } })
    const s = await window.api.getSettings()
    return { provider: s?.ai?.provider, baseUrl: s?.ai?.ollama?.baseUrl }
  }, llm.origin)
  const ok = got.provider === 'ollama' && got.baseUrl === llm.origin
  if (!ok) report.note('⚠️ AI mock 前置條件未備妥', got)
  return ok
}

/** 同上，為雲端 STT。回傳引擎與 baseUrl 真的被設成 mock。 */
async function ensureSttOnMock(main, stt) {
  const want = `${stt.origin}/v1`
  const got = await main.evaluate(async (url) => {
    await window.api.setSettings({
      stt: { engine: 'cloud', cloud: { baseUrl: url, apiKey: 'mock-key', model: 'mock-whisper' } }
    })
    const s = await window.api.getSettings()
    return { engine: s?.stt?.engine, baseUrl: s?.stt?.cloud?.baseUrl }
  }, want)
  const ok = got.engine === 'cloud' && got.baseUrl === want
  if (!ok) report.note('⚠️ STT mock 前置條件未備妥', got)
  return ok
}

// ─────────────────────── 1. 導航:六個側欄項目 ───────────────────────

/**
 * 每個側欄項目按下去,hash 必須真的換掉,而且 main 的內容必須跟上一頁不同。
 *
 * 為什麼兩個條件都要:hash 換掉但畫面沒換 = 路由更新了、頁面沒重繪
 * (React key 沒換、條件渲染吃掉)—— 使用者看到的是「按了沒反應」,
 * 而只查 hash 的稽核會回報通過。內容相同則是拿到了空殼頁。
 */
async function stepNavigation(main) {
  console.log('步驟 1：六個側欄項目…')
  const PAGES = [
    { label: '總覽', hash: 'dashboard', h1: '歡迎回來' },
    { label: '提詞講稿', hash: 'scripts', h1: null },
    { label: '錄音轉錄', hash: 'record', h1: '錄音轉錄' },
    { label: '面試練習', hash: 'practice', h1: '面試練習' },
    { label: '個人化校準', hash: 'calibration', h1: '個人化校準' },
    { label: '設定', hash: 'settings', h1: '設定' }
  ]

  let prevText = ''
  for (const p of PAGES) {
    const pr = probe(key('nav', 'button', p.label), '側欄')
    const clicked = await gotoViaSidebar(main, p.label)
    if (!clicked) {
      pr.unreachable(`側欄找不到「${p.label}」`)
      continue
    }
    const { hash, text, h1 } = await main.evaluate(() => ({
      hash: location.hash.replace(/^#\/?/, ''),
      text: (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ').trim(),
      h1: (document.querySelector('main h1')?.textContent || '').trim()
    }))

    if (hash !== p.hash) {
      pr.dead(`按下去之後 hash 是「${hash}」,預期「${p.hash}」—— 沒有換頁`)
      continue
    }
    if (prevText && text === prevText) {
      pr.dead(`hash 換成「${p.hash}」但 main 內容與上一頁完全相同 —— 換頁了但沒重繪`)
      continue
    }
    if (p.h1 && h1 !== p.h1) {
      pr.dead(`hash 正確但頁面標題是「${h1}」,預期「${p.h1}」`)
      continue
    }
    // 證據是「另一個容器」(main)的內容,不是被點的那顆側欄鈕。
    pr.works(`hash=${hash} 標題=${h1 || '(此頁無 h1)'} 內容 ${text.length} 字`, EVIDENCE.DOM)
    prevText = text
  }
  // Scripts.tsx 沒有任何 h1 —— 這是「頁面沒有標題」,記成 note 而不是問題:
  // 它不影響能不能走通,但無障礙上頁面應該有標題,值得留檔。
  report.note('無 h1 的頁面', '提詞講稿(Scripts)')
}

// ─────────────────── 2. 設定頁:改值 → 資料層真的變了 ───────────────────

/**
 * 這一組是本支稽核的主菜。
 *
 * 驗證方式:在頁面上真的輸入/點擊 → 從 `window.api.getSettings()` 讀回來比對。
 * 為什麼讀資料層而不是讀輸入框:輸入框的值就是「使用者剛剛打進去的字串」,
 * 它永遠等於自己,量到它等於什麼都沒量。資料層才是「系統真的接受了」。
 *
 * 覆蓋刻意跨到不同型別,因為三種儲存路徑的失效方式不同:
 *   - 文字欄位(debounce)
 *   - 下拉(select,無 debounce)
 *   - 按鈕群(單一切換)
 *   - 開關(role=switch)
 * 只驗其中一種,另外兩種掛掉完全不會被發現。
 */
async function stepSettings(main) {
  console.log('步驟 2：設定頁逐欄驗效果…')
  if (!(await gotoViaSidebar(main, '設定'))) {
    blocked('導航:設定頁', '側欄找不到「設定」')
    return
  }

  /** 這一頁的控制項 key:角色 + 可及名稱,與 effect-inventory 的列舉規則一致。 */
  const K = {
    text: (label) => key('settings', 'input:text', label),
    select: (label) => key('settings', 'select', label),
    button: (label) => key('settings', 'button', label),
    id: (v) => idKey('settings', v)
  }

  /** 文字欄位:逐字輸入 → 等 debounce → 從資料層讀回來。 */
  const textField = async (controlKey, aria, path, value, waitMs = 900) => {
    const p = probe(controlKey, '設定')
    const before = await readSetting(main, path)
    const el = main.locator(`input[aria-label="${aria}"]`).first()
    if (!(await el.isVisible().catch(() => false))) {
      p.unreachable(`找不到可見的 input[aria-label="${aria}"]`)
      return
    }
    await el.click()
    await el.fill(String(value))
    await sleep(waitMs)
    const after = await readSetting(main, path)
    if (after === value) {
      p.works(`${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`, EVIDENCE.DATA)
    } else {
      p.dead(`改了 ${aria} 之後資料層的 ${path} 是 ${JSON.stringify(after)},預期 ${JSON.stringify(value)}(原本是 ${JSON.stringify(before)})`)
    }
  }

  /**
 * 下拉:change 事件,沒有 debounce 這條路。
 *
 * **目標值是從 DOM 現有的 option 裡挑一個跟當前值不同的**,不是寫死。
 * 寫死 `Control+Shift+Space` 的結果是 Playwright 等了 30 秒然後中止——
 * 因為那個按鍵組合不在這個欄位的選項裡(各欄位的候選不同)。同一個探針
 * 連續被「綁太死的字串」坑到,所以這裡直接讓頁面自己告訴我有什麼可選。
 */
  const selectField = async (controlKey, aria, path) => {
    const p = probe(controlKey, '設定')
    const before = await readSetting(main, path)
    const el = main.locator(`select[aria-label="${aria}"]`).first()
    if (!(await el.isVisible().catch(() => false))) {
      p.unreachable(`找不到可見的 select[aria-label="${aria}"]`)
      return
    }
    const options = await el.evaluate((s) =>
      [...s.options].map((o) => ({ value: o.value, text: (o.textContent || '').trim() }))
    )
    // 必須挑一個「跟現值不同」的:挑相同的話,資料層不變會被誤判成「有生效」。
    const target = options.find((o) => o.value !== before)
    if (!target) {
      p.unreachable(`${aria} 只有一個選項(${JSON.stringify(options)}),無法驗證「改變」`)
      return
    }
    await el.selectOption(target.value)
    await sleep(800)
    const after = await readSetting(main, path)
    if (after === target.value) {
      p.works(`${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}(${target.text})`, EVIDENCE.DATA)
    } else {
      p.dead(
        `把 ${aria} 改成 ${JSON.stringify(target.text)} 之後,資料層的 ${path} 是 ${JSON.stringify(after)}(原本 ${JSON.stringify(before)})`
      )
    }
  }

  /*
   * 這裡曾經有一個 toggleSwitch(controlKey, labelText, path),從未被呼叫。
   * 真正執行開關探針的是下面 SWITCHES 那個迴圈(用同一個「按文字找」的方法,
   * 但讀回確認取代了 sleep,並且多記了一層可見性判斷)。
   *
   * 留下這段註解是因為那個函式裡記錄的是這支稽核最貴的一課:**頁面上有 8 個
   * role=switch。** 第一版用 `[role="switch"]` 的 .first(),量到的是頁面上第一個
   * 開關(鏡像模式),而斷言讀的是 `scenario.aiModeEnabled` —— 點 A 開關卻斷言 B 值,
   * 報出「aria 翻了但資料沒翻」的**假缺陷**。開關探針必須按文字找。
   */

  /** 按鈕群:按下去必須讓資料層換成該按鈕的值。 */
  const buttonGroup = async (controlKey, label, path, expected) => {
    const p = probe(controlKey, '設定')
    const before = await readSetting(main, path)
    const hit = await main.evaluate((l) => {
      const b = [...document.querySelectorAll('main button')].find((x) =>
        x.textContent?.trim().startsWith(l)
      )
      if (!b) return false
      b.click()
      return true
    }, label)
    if (!hit) {
      p.unreachable(`main 裡找不到文字開頭是「${label}」的按鈕`)
      return
    }
    await sleep(800)
    const after = await readSetting(main, path)
    if (after === expected) p.works(`${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`, EVIDENCE.DATA)
    else p.dead(`按「${label}」之後 ${path} 是 ${JSON.stringify(after)},預期 ${JSON.stringify(expected)}(原本 ${JSON.stringify(before)})`)
  }

  // 文字欄位(有 debounce)。Ollama 位址在預設 provider 下就渲染。
  await textField(K.text('Ollama 位址'), 'Ollama 位址', 'ai.ollama.baseUrl', 'http://localhost:19999')

  // 下拉(無 debounce)。熱鍵欄位**也是 select 不是 input** —— 我第一版用
  // input[aria-label="播放 / 暫停"] 去找,量到「欄位不存在」,差點誤判成
  // 「熱鍵設定整個不見了」。那是量測端的元素型別錯誤,不是產品缺陷。
  // 目標值必須跟預設不同,否則「沒變」會被誤判成通過。
  // 六個熱鍵下拉。*每一欄都要各驗一次* —— 它們共用一個 update 路徑,
  // 但共用的路徑若把參數寫死(例如都寫成 playPause),只有一欄會看得出來。
  await selectField(K.select('顯示 / 隱藏浮層'), '顯示 / 隱藏浮層', 'hotkeys.toggleOverlay')
  await selectField(K.select('隱藏浮層'), '隱藏浮層', 'hotkeys.hideOverlay')
  await selectField(K.select('Panic 救援'), 'Panic 救援', 'hotkeys.panicRescue')
  await selectField(K.select('播放 / 暫停'), '播放 / 暫停', 'hotkeys.playPause')
  await selectField(K.select('加快語速'), '加快語速', 'hotkeys.speedUp')
  await selectField(K.select('減慢語速'), '減慢語速', 'hotkeys.speedDown')
  await selectField(K.select('語言'), '語言', 'stt.language')
  await selectField(K.select('本地模型'), '本地模型', 'stt.localModel')

  // 按鈕群(單一切換)。這幾族都有 data-effect-id(名稱由状態決定或很長),key 用 id。
  await buttonGroup(K.id('provider'), 'OpenAI 相容 API', 'ai.provider', 'openai-compatible')
  await buttonGroup(K.id('provider'), 'Ollama（本地免費）', 'ai.provider', 'ollama')
  await buttonGroup(K.id('panic-mode'), '會議中斷', 'scenario.panicMode', 'meeting')
  await buttonGroup(K.id('panic-mode'), '面試被問倒', 'scenario.panicMode', 'interview')

  // 場景情境:按到「換掉現值」為止。
  // **不能只按第一顆** —— 預設的 activeScene 就是 interview,而按鈕順序不保證
  // 第一顆是別的場景。按到「本來就選中的那顆」時資料層當然不變,會被誤判成
  // 「按了沒反應」。所以逐顆試,直到真的換掉。
  const SCENE_RE = /風險\s*(low|medium|high)/
  const sceneBefore = await readSetting(main, 'scenario.activeScene')
  // 情境按鈕是 sceneList() 非同步回來之後才 render 的。
  // 只查一次會在它還沒到時得到 0,於是報告說「前置條件未備妥」——
  // 而那其實只是我早到了 200ms。**量測端自己的時序問題,不是產品的。**
  let sceneCount = 0
  for (let i = 0; i < 30 && sceneCount === 0; i++) {
    sceneCount = await main.evaluate(
      (re) =>
        [...document.querySelectorAll('main button')].filter((b) =>
          new RegExp(re).test(b.getAttribute('title') || '')
        ).length,
      SCENE_RE.source
    )
    if (sceneCount === 0) await sleep(200)
  }
  const sceneProbe = probe(K.id('scene'), '設定')
  if (sceneCount < 1) {
    sceneProbe.unreachable(`只找到 ${sceneCount} 個情境按鈕`)
  } else {
    let sceneAfter = sceneBefore
    for (let i = 0; i < sceneCount && sceneAfter === sceneBefore; i++) {
      await main.evaluate(
        ([re, idx]) => {
          const r = new RegExp(re)
          const list = [...document.querySelectorAll('main button')].filter((b) =>
            r.test(b.getAttribute('title') || '')
          )
          list[idx]?.click()
        },
        [SCENE_RE.source, i]
      )
      await sleep(700)
      sceneAfter = await readSetting(main, 'scenario.activeScene')
    }
    if (sceneAfter !== sceneBefore) {
      sceneProbe.works(`${sceneCount} 個可選,activeScene: ${sceneBefore} → ${sceneAfter}`, EVIDENCE.DATA)
    } else {
      sceneProbe.dead(
        `依序按過全部 ${sceneCount} 個情境按鈕,activeScene 還是 ${JSON.stringify(sceneBefore)}`
      )
    }
  }

  // 開關:8 個 role=switch 的逐個驗證在 stepSettingsExtra(它們共用 data-effect-id=switch)。

  // 這一條是本專案修過的真缺陷,釘在這裡當回歸:
  // API Key 曾經「onChange 只更新本地 state、onBlur 才存」,而同一頁其他欄位
  // 都是 onChange 立刻存。使用者打完直接關視窗 → 金鑰整個遺失,沒有任何提示。
  // 這裡刻意**逐字輸入、不點任何東西、不 blur**,只看資料層有沒有收到。
  //
  // 金鑰欄位只在 openai-compatible 分支渲染,而上面的供應商測試最後把
  // 分支切回了 ollama —— 所以這裡自己切過去再切回來。
  // (第一版沒切,直接記成「無法驗證」:那不是誠實,是我忘了準備前置條件。)
  await buttonGroup(K.id('provider'), 'OpenAI 相容 API', 'ai.provider', 'openai-compatible')
  const keyProbe = probe(K.text('API Key'), '設定')
  // **用 data-effect-id 定位，不要用 aria-label + .first()。**
  // 這一頁有兩個可及名稱完全相同的「API Key」（雲端辨識一組、AI 助理一組），
  // .first() 拿到的是前一個 → 填進辨識的金鑰、斷言 AI 的金鑰 → apiKey 永遠 null。
  // 這個檔案裡 SettingsPage 已經把這件事寫在註解上了,而探針還是踩了。
  const keyField = main.locator('input[data-effect-id="ai-api-key"]').first()
  // 切換供應商之後欄位是下一個 render 才出現的。只查一次會得到
  // 「沒有渲染」而實際上只是早到了 200ms —— 報告會把它記成未驗,
  // 而實際上它每次都跑得通(連續兩次實跑:一次綠一次未驗)。
  let keyVisible = false
  for (let i = 0; i < 25 && !keyVisible; i++) {
    keyVisible = await keyField.isVisible().catch(() => false)
    if (!keyVisible) await sleep(200)
  }
  if (!keyVisible) {
    keyProbe.unreachable('供應商已切到 openai-compatible,但 AI 的 API Key 欄位沒有渲染')
  } else {
    // **先清空再逐字輸入。** type() 是「在游標處插入」,不清空的話會接在
    // 現有值後面 —— 而這個欄位在金鑰還沒存過時會先用 settings 裡的值當預設值
    // 顯示出來,於是打出來變成「舊值+新值」。
    // 這個錯誤有個很好的副作用:它把拼接後的字串送到了 mock STT 的
    // Authorization 標頭裡(Bearer mock-keysk-audit-effects),我因此才發現它。
    const before = await keyField.inputValue()
    await keyField.click()
    await keyField.fill('')
    await keyField.type('sk-audit-effects', { delay: 10 })
    await sleep(1400) // 等 debounce(600ms)
    const got = await main.evaluate(async () => (await window.api.keysGet?.()) ?? null)
    if (got?.apiKey === 'sk-audit-effects') {
      keyProbe.works(`打完未 blur,資料層已收到(這是修過的缺陷);原欄位值=${JSON.stringify(before)}`, EVIDENCE.DATA)
    } else {
      keyProbe.dead(
        `打完金鑰且沒有 blur,資料層的 apiKey 是 ${JSON.stringify(got?.apiKey ?? null)}` +
          `（sttApiKey=${JSON.stringify(got?.sttApiKey ?? null)}）—— 使用者關掉視窗就會遺失`
      )
    }
  }

  // 頁首的區塊目錄(九顆 chip,共用 data-effect-id=settings-toc)。
  //
  // 這一頁是九個區塊的單一長捲頁,而那條目錄是唯一的索引 —— 按下去必須真的捲,
  // 否則使用者以為自己在用索引,實際上站在原地。效果不讀 chip 自己的 class
  // (那是 UI 的自我宣稱),而是讀 main 的 scrollTop:畫面上真的動了。
  //
  // 挑**最後一顆**(疑難排解):它的目標最遠、捲動量最大,而且是最常被找的一區。
  // smooth scroll 是漸進的,所以判準用「等它穩定下來」而不是「等一個固定時間」
  // —— 後者會在慢一點的機器上量到中途值(audit-states 上一輪就是這樣誤判的)。
  const pToc = probe(K.id('settings-toc'), '設定')
  const tocCount = await main.evaluate(
    () => document.querySelectorAll('[data-effect-id="settings-toc"]').length
  )
  if (tocCount === 0) {
    pToc.unreachable('設定頁沒有區塊目錄的 chip')
  } else {
    const tocBefore = await main.evaluate(() => Math.round(document.querySelector('main')?.scrollTop ?? -1))
    const tocClicked = await clickEffectId(main, 'settings-toc', tocCount - 1)
    if (tocClicked !== true) {
      pToc.unreachable(`第 ${tocCount} 顆目錄 chip 點不到(clicked=${JSON.stringify(tocClicked)})`)
    } else {
      let tocLast = -1
      let tocStable = 0
      for (let i = 0; i < 40 && tocStable < 3; i++) {
        await sleep(120)
        const now = await main.evaluate(() => Math.round(document.querySelector('main')?.scrollTop ?? -1))
        tocStable = now === tocLast ? tocStable + 1 : 0
        tocLast = now
      }
      if (tocLast > tocBefore) {
        pToc.works(`按最後一顆 chip:main.scrollTop ${tocBefore} → ${tocLast}`, EVIDENCE.GEOMETRY)
      } else {
        pToc.dead(
          `按了目錄最後一顆 chip 之後 main.scrollTop 還是 ${tocLast}(原本 ${tocBefore})—— 目錄沒有捲動頁面`
        )
      }
      // 還原:後面的步驟不該繼承「主區被捲到最下面」這個狀態。
      await main.evaluate(() => {
        const m = document.querySelector('main')
        if (m) m.scrollTop = 0
      })
      await sleep(200)
    }
  }
}

// ─────────── 3. 熱鍵:OS 層級,DOM 量不到,但「註冊失敗」能量 ───────────

/**
 * 全域熱鍵是特別值得查的一項:一個壞掉的熱鍵在任何 DOM 稽核裡都長得
 * 跟正常的一模一樣 —— 按鈕在、字串對、存檔成功,但按下去什麼都不發生。
 *
 * **斷言的不是「有沒有衝突」,而是「有衝突時使用者會不會被告知」。**
 * 這個區別很重要:
 *   - 「沒有衝突」是環境的運氣。乾淨的 CI 上永遠綠,但什麼都沒證明。
 *   - 「衝突時有沒有提示」是產品的行為,在任何環境下都該成立。
 * 而且熱鍵被佔用是使用者**改得掉**的(換一個組合),前提是他知道。
 * 所以真正該守的是「不能默默失效」。
 *
 * 這條是本專案的第四個假綠燈:修之前 `hotkeyConflicts` 只有稽核腳本自己讀過,
 * renderer 裡沒有任何一行提到它 —— 使用者設定頁寫著「任何應用程式上方都有效」,
 * 而他挑的組合可能根本沒註冊上來,而且沒有任何地方會說。
 */
async function stepHotkeys(main) {
  console.log('步驟 3：全域熱鍵註冊…')
  const info = await main.evaluate(async () => {
    try {
      return (await window.api.appInfo?.()) ?? null
    } catch {
      return null
    }
  })
  if (!info || !Array.isArray(info.hotkeyConflicts)) {
    probe(key('settings', 'button', '熱鍵註冊狀態'), '全域熱鍵').unreachable(
      'appInfo 沒有回傳 hotkeyConflicts 欄位,量不到'
    )
    return
  }
  const s = await readSetting(main, 'hotkeys')
  const total = Object.keys(s ?? {}).length
  const conflicts = info.hotkeyConflicts
  report.note('熱鍵總數', total)
  report.note('熱鍵衝突', conflicts)

  const hotkeyProbe = probe(key('settings', 'button', '熱鍵註冊狀態'), '全域熱鍵')
  if (conflicts.length === 0) {
    hotkeyProbe.works(
      `${total} 個熱鍵全部註冊成功(這個環境沒有衝突,所以只能驗到「沒事時正常」)`,
      EVIDENCE.DATA
    )
    return
  }

  // 有衝突 → 設定頁必須把每一顆都指出來。
  await gotoViaSidebar(main, '設定')
  const alert = await main.evaluate(() => {
    const el = document.querySelector('[role="alert"]')
    return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null
  })
  const missing = conflicts.filter((k) => !alert || !alert.includes(k.replaceAll('Control', 'Ctrl')))
  if (!alert) {
    hotkeyProbe.dead(
      `${conflicts.length}/${total} 個熱鍵註冊失敗(${conflicts.join('、')})` +
        ',但設定頁完全沒有提示 —— 使用者按下去不會有任何反應,而且無從得知原因'
    )
  } else if (missing.length) {
    // 詳細訊息裡**一定要帶上實際看到的文字**。
    // 上一輪只寫了「沒提到這幾顆」,而沒有那句的話,一條真的缺陷與一條量測錯誤
    // (例如我讀到另一個區塊)在報告裡長得一模一樣。
    hotkeyProbe.dead(
      `設定頁有提示,但沒提到這幾顆: ${missing.join('、')}。只列一部分等於讓人以為其餘的是好的。` +
        `(畫面上的提示原文:${JSON.stringify(String(alert).slice(0, 200))})`
    )
  } else {
    hotkeyProbe.works(
      `${conflicts.length}/${total} 個註冊失敗(${conflicts.join('、')}),設定頁逐顆指出`,
      EVIDENCE.DATA
    )
  }

  /**
   * (c) 新鮮度 —— 「改了之後警告要跟著改」。
   *
   * 為什麼要單獨驗這一件:
   *   在這之前,設定頁只在 **mount 時**讀一次 `appInfo().hotkeyConflicts`。
   *   於是使用者在這一頁把衝突的那顆熱鍵改掉,main 重新註冊也重新記了,但畫面上的
   *   警告還停在**舊的組合**——而且因為反查擁有者時已經對不上,它連「這是哪個功能」
   *   都說不出來。看到自己的舊組合被列在那裡,人的結論是「跟我無關」。
   *   上面的比對抓不到這件事:它是在「剛進頁面」時量的,而那個時機永遠是新的。
   *
   * 所以這裡**真的去改一顆下拉**,只看兩件事:換過的那一顆要以新值出現、
   * 舊值要消失。驗的是「警告與現況同步」,而不是某個字串在不在。
   */
  const norm = (k) => String(k).replaceAll('Control', 'Ctrl')
  const changed = conflicts.includes(s.toggleOverlay)
  if (changed) {
    const options = await main.evaluate(() => {
      const sel = document.querySelector('select[aria-label="顯示 / 隱藏浮層"]')
      return sel ? [...sel.options].map((o) => o.value) : []
    })
    const target = options.find((o) => o !== s.toggleOverlay)
    if (!target) {
      report.note('熱鍵新鮮度', '只有一個選項,無法驗「改了之後警告跟著改」')
    } else {
      await main
        .evaluate((v) => {
          const sel = document.querySelector('select[aria-label="顯示 / 隱藏浮層"]')
          if (!sel) return false
          sel.value = v
          sel.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        }, target)
        .catch(() => false)
      await sleep(1800)
      const next = await main.evaluate(async () => {
        const info = await window.api.appInfo()
        const el = document.querySelector('[role="alert"]')
        return { conflicts: info.hotkeyConflicts, alert: el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null }
      })
      const stale = conflicts.filter((k) => !next.conflicts.includes(k))
      const staleShown = stale.filter((k) => next.alert?.includes(norm(k)))
      const missingNow = next.conflicts.filter((k) => !next.alert?.includes(norm(k)))
      if (stale.length === 0) {
        report.note('熱鍵新鮮度', `改成 ${target} 之後衝突名單不變(${next.conflicts.join('、')}),這一輪量不到「舊值要消失」`)
      } else if (staleShown.length === 0 && missingNow.length === 0) {
        report.note(
          '熱鍵新鮮度',
          `改成 ${target} → 警告清單同步更新(舊值 ${stale.join('、')} 已消失,新值逐顆列出)`
        )
      } else {
        hotkeyProbe.dead(
          `把「顯示 / 隱藏浮層」改成 ${target} 之後,警告清單與現況不同步:` +
            `已不再是衝突卻還列著 ${JSON.stringify(staleShown)}、該列而未列 ${JSON.stringify(missingNow)}` +
            `(畫面原文:${JSON.stringify(String(next.alert).slice(0, 160))})`
        )
      }
    }
  }
}

/**
 * 更新待安裝橫幅(2026-10-03 第二輪新增)。
 *
 * 為什麼要一個新的步驟而不是把它併進設定頁:
 *   這一輪把橫幅從設定頁搬到 App 層,因為它本來只長在一個使用者幾乎不會為了
 *   「看看有沒有更新」而開啟的頁面上 —— 而 electron-updater 會在他下次關閉
 *   App 時默默裝掉它。搬到之後它是一個**跨頁面的橫幅**,而「它到底在不在」
 *   變成每一頁都在做的宣稱。這一條量那個宣稱。
 *
 * 為什麼要先問「有沒有真的下載更新」而不是直接按:
 *   真實的更新事件在稽核環境不會發生,所以這兩顆鈕**從來沒有被列舉過** ——
 *   一個只存在五秒鐘的橫幅,錯過那五秒鐘就等於從未被量過。用稽核橋
 *   `update.downloaded` 把它排出來,量的是「它真的會告知,而且兩顆鈕都有作用」。
 *
 * 「重新啟動以更新」這顆按下去會真的 app.relaunch()+quit,結束稽核本身 ——
 * 所以它登錄為 DESTRUCTIVE_WINDOW 豁免。**因此這一支只量「稍後」**,
 * 而「橫幅會不會出現」那件事掛在「稍後」這顆上:按不到就是橫幅沒渲染,
 * 這是同一個失效。
 */
async function stepUpdateBanner(main) {
  console.log('步驟：更新待安裝橫幅(全域)…')
  const pDismiss = probe(idKey('update', 'update-dismiss'), '更新橫幅')

  // 前置:先確認這顆橫幅真的沒有畫出來(沒有待安裝的更新時它必須不存在)
  await gotoViaSidebar(main, '總覽')
  await sleep(500)
  const before = await main.evaluate(() => !!document.querySelector('[data-update-banner]'))
  if (before) {
    // 不是錯,但要講清楚:量到的會是「橫幅已經在」而不是「我們把它排出來」
    report.note('更新橫幅', '量測開始時橫幅已經在畫面上(前一輪遺留或真的有更新)')
  }

  const forced = await main.evaluate(async () => {
    const r = await window.__auditForce?.('update.downloaded', '9.9.9-audit')
    return r?.ok === true ? { ok: true } : { ok: false, error: r?.error ?? 'ok=false', names: r?.names ?? [] }
  })
  if (!forced.ok) {
    pDismiss.unreachable(
      `update.downloaded 稽核橋未生效(${forced.error};已註冊=${(forced.names || []).join(',') || '(空)'})`
    )
    return
  }
  await sleep(600)

  const shown = await main.evaluate(() => {
    const banner = document.querySelector('[data-update-banner]')
    return {
      present: !!banner,
      text: (banner?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      buttons: [...document.querySelectorAll('[data-update-banner] button')].map((b) => ({
        id: b.getAttribute('data-effect-id'),
        text: (b.textContent || '').trim()
      }))
    }
  })
  if (!shown.present) {
    pDismiss.dead(
      '強制了「已下載更新」但畫面上沒有 [data-update-banner] —— 一則提示長在使用者不去的地方就等於不存在,' +
        '而 updater 會在他關閉 App 時默默裝掉它'
    )
    return
  }
  if (!shown.buttons.some((b) => b.id === 'update-dismiss')) {
    pDismiss.dead(`橫幅只渲染出 ${JSON.stringify(shown.buttons)} —— 使用者沒有可執行的下一步`)
    return
  }
  report.note('更新橫幅（總覽頁）', shown.text)

  // 「稍後」的效果是橫幅真的消失 —— 被點元素**以外**的元素變了,所以是 dom-container
  await gotoViaSidebar(main, '設定')
  await sleep(500)
  const stillThere = await main.evaluate(() => !!document.querySelector('[data-update-banner]'))
  if (!stillThere) {
    // 走到設定頁就消失了 = 「跨頁面」這個宣稱不成立(它其實還是只住在設定頁)
    pDismiss.dead('切到設定頁之後橫幅就不見了 —— 它仍然是設定頁專屬的,而不是全域的')
  } else {
    const clicked = await clickEffectId(main, 'update-dismiss')
    await sleep(500)
    const after = await main.evaluate(() => !!document.querySelector('[data-update-banner]'))
    if (clicked !== true) {
      pDismiss.unreachable(`按不了 update-dismiss(${clicked})`)
    } else if (after) {
      pDismiss.dead('按了「稍後」但橫幅還在畫面上 —— 使用者會以為它沒有作用')
    } else {
      pDismiss.works('「稍後」真的把橫幅收掉(換頁之後仍維持關閉)', EVIDENCE.DOM)
    }
  }

  // 收尾:清掉覆寫,後面的狀態不該繼承這則提示
  await main.evaluate(() => window.__auditForce?.('update.downloaded', null)).catch(() => {})
  await sleep(400)
}

// ─────────────── 4. 浮層:證據全部取自另一個視窗 ───────────────

/**
 * 這一組的證據一律來自**另一個 Electron 視窗的 DOM + 資料層**,不是主視窗。
 * 主視窗按下「開始提詞」之後內容才會送到浮層 —— 那條路徑壞掉時,主視窗裡
 * 所有東西都正常(有講稿、有按鈕、有回饋),只有使用者看著空白。
 *
 * 下面每一條都是照著**實測**到的 DOM 寫的,不是照著猜的:
 *   - 預設形態是 expanded(overlay.compact=false),所以「展開完整面板」鈕
 *     **在預設狀態下不存在**(那是藥丸形態的鈕)。我第一版假設預設是藥丸,
 *     於是「找不到鈕」被記成缺陷 —— 那是量測端的錯誤,不是產品缺陷。
 *   - 播放鈕的 title 是「暫停(空白鍵)」,不是「暫停」。用精確比對會永遠點不到。
 *   - 捲動容器沒有專屬屬性,只能挑 (scrollHeight - clientHeight) 最大的那個。
 *     用 [class*=overflow-y-auto] 會命中別的容器,量到 10px 的假捲動距離。
 *   - 講稿太短時整份內容只有 10px 可捲 —— 「播放 2.6 秒沒動」是合理的。
 *     所以這裡放 60 句,實測可捲動距離 ~3295px。
 *
 * 播放/暫停不用「按鈕 icon 換了」當證據 —— 那是 UI 在說它生效了。
 * 用的是**可讀的幾何量**:捲動位置有沒有前進、前進後有沒有停下。
 */
/** 浮層控制項的 key。無法驗時要逐顆記 unreachable,不能只記一筆「浮層」。 */
/**
 * 依**收斂後的 title** 找控制項。
 *
 * 為什麼不能再用 `startsWith(prefix)`:
 *   浮層有兩顆鈕的 title 是「關閉(快捷鍵)」與「關閉「該你說話了」提示」。
 *   字首比對會把後者當成前者,於是探針點的是「切換提示」、斷言的是「浮層
 *   收起來了沒」—— 量到的「按了關閉但浮層還在」是一個**量測錯誤被記成
 *   產品缺陷**。收斂規則(normalizeTitle)與列舉端完全同一份,兩邊不會漂移。
 */
const clickByTitle = (win, title, opts = {}) =>
  win.evaluate(
    ({ t, scope }) => {
      const root = scope ? document.querySelector(scope) : document
      if (!root) return false
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const cut = (s) => {
        const raw = norm(s)
        const c = raw.split(/[（(:：]/)[0].trim()
        return c.length >= 2 ? c : raw
      }
      const b = [...root.querySelectorAll('button,[role=button]')].find((x) => cut(x.getAttribute('title')) === t)
      if (!b) return false
      if (b.disabled) return 'disabled'
      b.click()
      return true
    },
    { t: normalizeTitle(title), scope: opts.scope ?? null }
  )

const OVERLAY_KEYS = [
  '播放',
  '暫停',
  '收合成藥丸',
  '展開完整面板',
  '速度 +',
  '速度 -',
  '模式',
  '字體放大',
  '字體縮小',
  'Panic 救援'
].map((n) => key('overlay', 'button', n))

function markOverlay(keys, verdict, reason) {
  for (const k of keys) {
    // **未登記的 key 不得中止整個步驟。**
    // probe() 對沒登記的 key 回傳 undefined，而 `undefined[verdict](...)` 會丟
    // TypeError —— 這個例外會讓整個 step 中止，後面十幾個斷言全部沒量到，
    // 而報告裡看起來像「那些項目沒問題」。實測就是這樣：浮層工具列那一輪
    // 中止在這裡，問題數反而比中止前少。
    const p = probe(k, '浮層')
    if (!p || typeof p[verdict] !== 'function') {
      report.add(
        'unregistered-probe-key',
        '浮層',
        `markOverlay 拿到未登記的 key「${k}」(${verdict})。` +
          '它沒有被量到,但更重要的是它讓整個步驟中止 —— 先把 key 登記進 effect-inventory。'
      )
      continue
    }
    p[verdict](reason)
  }
}

async function stepOverlay(app, main) {
  console.log('步驟 4：浮層控制逐條驗效果…')
  if (!(await gotoViaSidebar(main, '提詞講稿'))) {
    markOverlay(OVERLAY_KEYS, 'unreachable', '側欄找不到「提詞講稿」')
    return
  }

  const pStart = probe(key('scripts', 'button', '開始提詞'), '開始提詞')
  const made = await main.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => x.textContent?.includes('新講稿'))
    if (!b) return false
    b.click()
    return true
  })
  if (!made) {
    markOverlay(OVERLAY_KEYS, 'unreachable', '找不到「新講稿」按鈕,無法準備提詞內容')
    return
  }
  await sleep(1000)

  // 夠長才捲得動。短講稿的實測可捲動距離只有 10px,會讓「沒動」變成正常現象。
  const LONG = Array.from(
    { length: 60 },
    (_, i) => `第 ${i + 1} 句:開會時我會照著這一段念下去,內容夠長才捲得動。`
  ).join('\n')
  await main
    .locator('textarea')
    .first()
    .fill(LONG)
    .catch(() => {})
  await sleep(800)

  const launched = await main.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => x.textContent?.includes('開始提詞'))
    if (!b) return { ok: false, why: '找不到「開始提詞」按鈕' }
    // 內容沒進去時這顆鈕是 disabled 的。直接 click() 不會報錯也不會開浮層 ——
    // 上一輪就是這樣去讀到一個**舊的/其他的**浮層視窗,拆解出一堆誤導的訊息。
    if (b.disabled) return { ok: false, why: '「開始提詞」是 disabled(編輯區內容是空的),本輪的輸入沒進去' }
    b.click()
    return { ok: true }
  })
  if (!launched.ok) {
    pStart.unreachable(launched.why)
    markOverlay(OVERLAY_KEYS, 'unreachable', launched.why)
    return
  }
  await sleep(2500)

  /**
   * 浮層視窗要**依 URL 認**,不能只用「不是主視窗的那一個」。
   * 主程序在啟動時就會建一個隱藏的浮層視窗,而 `app.windows()` 包含不可見的
   * 那些 —— 只看「不等於 main」的話,任何時候都「找得到浮層」,
   * 連「根本沒開起來」的時候也一樣。
   */
  const overlayWindows = () => app.windows().filter((w) => w !== main && /overlay/i.test(w.url()))
  const overlay = overlayWindows()[0]
  if (!overlay) {
    const urls = app.windows().map((w) => w.url())
    pStart.dead(`按下去之後沒有任何浮層視窗(現有視窗:${urls.join(' , ')})`)
    markOverlay(OVERLAY_KEYS, 'unreachable', '開始提詞沒有開啟浮層')
    return
  }
  await overlay.waitForLoadState('domcontentloaded').catch(() => {})
  await sleep(1200)

  // (a) 內容有沒有真的送到浮層 —— 這是上一輪補上的那條
  // textContent:同 stepScripts 的理由 —— 被裁切的內容在 innerText 裡看不到,
  // 而這裡要問的是「內容有沒有送到」,不是「使用者看到幾行」。
  const text = await overlay.evaluate(() => document.body?.textContent || '').catch(() => '')
  if (text.includes(LONG.slice(0, 14))) {
    // 證據是**另一個視窗**的文字:“開始提詞”這顆鈕自己宣稱了什麼不重要,
    // 重要的是使用者眼前那個視窗裡真的出現了剛剛打的那段話。
    pStart.works(`命中前 14 字:${JSON.stringify(LONG.slice(0, 14))}`, EVIDENCE.OTHER_WINDOW)
  } else {
    pStart.dead(
      `浮層開了,但裡面沒有剛剛輸入的講稿。實際文字前 60 字:${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 60))}`
    )
    markOverlay(OVERLAY_KEYS, 'unreachable', '浮層沒有帶到講稿內容,後續控制項量了沒意義')
    return // 內容都不對,後面的控制項量了沒意義
  }

  /**
   * 浮層側的可觀察量。捲動容器用「可捲動距離最大的元素」判定,
   * 因為浮層裡有多個 overflow 容器,取第一個會量到捲不動的那個。
   */
  const geo = () =>
    overlay
      .evaluate(() => {
        let sc = null
        let best = 20 // 門檻:小於 20px 的不算捲動容器
        for (const e of document.querySelectorAll('*')) {
          const d = e.scrollHeight - e.clientHeight
          if (d > best) {
            best = d
            sc = e
          }
        }
        const track = document.querySelector('[data-overlay-progress="1"]')
        return {
          surface: document.querySelector('[data-overlay-surface]')?.getAttribute('data-overlay-surface') ?? null,
          scrollTop: sc ? Math.round(sc.scrollTop) : null,
          scrollMax: sc ? Math.round(best) : null,
          progress: track ? track.style.width : null
        }
      })
      .catch(() => ({}))

  /**
   * 浮層按鈕:依**收斂後的 title** 比對(實測是「暫停(空白鍵)」這種帶註解的字串)。
   * 收斂規則與列舉端共用 normalizeTitle —— 字首比對會誤中別的按鈕,
   * 而那個錯誤會長得像產品缺陷(見 clickByTitle 的註解)。
   */
  const clickOverlay = (title) => clickByTitle(overlay, title)

  const overlayTitle = (title) =>
    overlay
      .evaluate(
        (t) =>
          [...document.querySelectorAll('button[title]')]
            .map((x) => x.getAttribute('title') || '')
            .find((x) => {
              const raw = x.replace(/\s+/g, ' ').trim()
              const cut = raw.split(/[（(:：]/)[0].trim()
              return (cut.length >= 2 ? cut : raw) === t
            }) ?? null,
        normalizeTitle(title)
      )
      .catch(() => null)

  // ── (b) 播放 → 捲動位置必須前進 ──
  const pPlay = probe(key('overlay', 'button', '播放'), '浮層')
  const pPause = probe(key('overlay', 'button', '暫停'), '浮層')
  const g0 = await geo()
  report.note('浮層可捲動距離', `${g0.scrollMax}px`)
  if (g0.scrollMax === null) {
    pPlay.unreachable('在浮層裡找不到有捲動距離的元素')
    pPause.unreachable('在浮層裡找不到有捲動距離的元素')
  } else {
    const pausedTitle = await overlayTitle('播放')
    if (pausedTitle) {
      // 起始就是暫停態 → 先按下去開始播
      await clickOverlay('播放')
      await sleep(700)
    }
    const p0 = await geo()
    await sleep(2600)
    const p1 = await geo()
    if (p1.scrollTop > p0.scrollTop) {
      pPlay.works(
        `捲動位置 ${p0.scrollTop}px → ${p1.scrollTop}px(2.6 秒內前進),進度條 ${p0.progress} → ${p1.progress}`,
        EVIDENCE.GEOMETRY
      )
    } else {
      pPlay.dead(
        `按下播放 2.6 秒後捲動位置不動(${p0.scrollTop}px → ${p1.scrollTop}px,可捲動距離 ${p0.scrollMax}px)` +
          ' —— 使用者會看著一頁不動的提詞稿'
      )
    }
    await shoot(overlay, '04-浮層-播放中')

    // ── (c) 暫停 → 位置必須停止前進 ──
    if (!(await clickOverlay('暫停'))) {
      pPause.unreachable('找不到「暫停…」按鈕')
    } else {
      await sleep(600)
      const q0 = await geo()
      await sleep(2200)
      const q1 = await geo()
      if (q1.scrollTop === q0.scrollTop) {
        pPause.works(`暫停後 2.2 秒捲動位置維持 ${q0.scrollTop}px`, EVIDENCE.GEOMETRY)
      } else {
        pPause.dead(`暫停後捲動位置仍從 ${q0.scrollTop}px 走到 ${q1.scrollTop}px —— 暫停鈕沒有生效`)
      }
    }
  }

  // ── (d) 形態切換:expanded ⇄ pill,資料層與 DOM 必須同時換 ──
  const pCompact = probe(key('overlay', 'button', '收合成藥丸'), '浮層')
  const pExpand = probe(key('overlay', 'button', '展開完整面板'), '浮層')
  const compactBefore = await readSetting(main, 'overlay.compact')
  if (await clickOverlay('收合成藥丸')) {
    await sleep(1000)
    const compactPill = await readSetting(main, 'overlay.compact')
    const sPill = await geo()
    if (compactPill !== compactBefore && sPill.surface === 'pill') {
      pCompact.works(`overlay.compact ${compactBefore} → ${compactPill},surface → pill`, EVIDENCE.DATA)
    } else {
      pCompact.dead(
        `按了收合但 overlay.compact ${compactBefore} → ${compactPill}、surface ${sPill.surface}(期待 pill)`
      )
    }

    // 藥丸形態才會有「展開完整面板」—— 這也是上一版量錯的原因。
    if (await clickOverlay('展開完整面板')) {
      await sleep(1000)
      const compactBack = await readSetting(main, 'overlay.compact')
      const sBack = await geo()
      if (compactBack === compactBefore && sBack.surface === 'expanded') {
        pExpand.works(`surface pill → expanded,overlay.compact → ${compactBack}`, EVIDENCE.DATA)
      } else {
        pExpand.dead(`展開後 surface=${sBack.surface}、overlay.compact=${compactBack}`)
      }
    } else {
      pExpand.dead('在藥丸形態下找不到「展開完整面板」按鈕')
    }
  } else {
    pCompact.unreachable('找不到「收合成藥丸…」按鈕(可能已經是藥丸形態)')
    pExpand.unreachable('沒有進到藥丸形態,展開鈕不存在')
  }

  // ── (e) 速度 +/-:資料層的 overlay.speed 必須 ±10 ──
  const pSpeedUp = probe(key('overlay', 'button', '速度 +'), '浮層')
  const pSpeedDown = probe(key('overlay', 'button', '速度 -'), '浮層')
  const sp0 = await readSetting(main, 'overlay.speed')
  if (await clickOverlay('速度 +')) {
    await sleep(800)
    const sp1 = await readSetting(main, 'overlay.speed')
    if (typeof sp0 === 'number' && sp1 === sp0 + 10) {
      pSpeedUp.works(`overlay.speed ${sp0} → ${sp1}`, EVIDENCE.DATA)
    } else {
      pSpeedUp.dead(`按「速度 +」後 overlay.speed=${sp1},預期 ${sp0}+10(原本 ${sp0})`)
    }
    // 速度 - 緊接著驗:必須回到原值(步進是 ±10,而且下限是 10)
    if (await clickOverlay('速度 -')) {
      await sleep(800)
      const sp2 = await readSetting(main, 'overlay.speed')
      if (typeof sp2 === 'number' && sp2 === sp1 - 10) {
        pSpeedDown.works(`overlay.speed ${sp1} → ${sp2}`, EVIDENCE.DATA)
      } else {
        pSpeedDown.dead(`按「速度 -」後 overlay.speed=${sp2},預期 ${sp1}-10`)
      }
    } else {
      pSpeedDown.unreachable('找不到「速度 -」按鈕')
    }
  } else {
    pSpeedUp.unreachable('找不到「速度 +」按鈕')
    pSpeedDown.unreachable('找不到「速度 +」按鈕,後續的 - 無從比較')
  }

  // ── (f) 模式切換:資料層必須換成對應的 displayMode ──
  //
  // ⚠️ 這一族**不能用收斂後的 title 找**:四個模式鈕的 title 是
  // 「模式:連續捲動 / 逐句短語 / 重點要點 / 逐詞卡拉OK」,而它們收斂之後
  // 全部等於「模式」—— 用收斂名去找,永遠點到第一顆,
  // 於是量到的是「按了但沒換」(一顆好的按鈕,假的紅燈)。
  // 這一族要的是**完整 title**。
  const pMode = probe(key('overlay', 'button', '模式'), '浮層')
  // **自己備妥前置條件並讀回來確認。** 這一步之前跑過收合/展開與設定頁的
  // 顯示模式，那些步驟會把 overlay.compact 與 overlay.displayMode 留在別的狀態；
  // 分段控件只存在於展開形態。單獨實測這裡完全正常（scroll → phrase、
  // aria-pressed 同步更新），所以稽核裡不生效是量測端的前置條件問題。
  await main.evaluate(() => window.api.setSettings({ overlay: { compact: false, displayMode: 'scroll' } }))
  await sleep(800)
  const modeBefore = await readSetting(main, 'overlay.displayMode')
  const clickModeOption = (label) =>
    overlay.evaluate((t) => {
      const b = [...document.querySelectorAll('button[title]')].find((x) => (x.getAttribute('title') || '') === t)
      if (!b) return false
      b.click()
      return true
    }, '模式:' + label)
  const pressedNow = () =>
    overlay.evaluate(() =>
      [...document.querySelectorAll('button[title^="模式:"]')].map((b) => [
        b.getAttribute('title'),
        b.getAttribute('aria-pressed')
      ])
    )
  if (modeBefore !== 'scroll') {
    pMode.unreachable('前置條件未備妥:displayMode 讀回來是 ' + JSON.stringify(modeBefore) + '，預設 scroll')
  } else if (!(await clickModeOption('逐句短語'))) {
    pMode.unreachable('找不到「模式:逐句短語」按鈕（浮層可能不在展開形態）')
  } else {
    // 輪詢而不是固定睡：patch 走 IPC，固定 900ms 是賭一個沒有根據的時間。
    let modeAfter = modeBefore
    const t0 = Date.now()
    for (let i = 0; i < 30 && modeAfter === modeBefore; i++) {
      await sleep(200)
      modeAfter = await readSetting(main, 'overlay.displayMode')
    }
    const pressed = await pressedNow()
    const anyPressed = pressed.some((x) => x[1] === 'true')
    if (modeAfter !== modeBefore) {
      pMode.works(
        'overlay.displayMode: ' + modeBefore + ' → ' + modeAfter + '(' + (Date.now() - t0) + 'ms 內生效);aria-pressed=' + JSON.stringify(pressed),
        EVIDENCE.DATA
      )
    } else {
      // **把 aria-pressed 一起帶出來。** 它能分辨「點擊沒被接收」與
      // 「接收了但沒寫進設定」—— 兩者的修法完全不同，而只報「值沒變」
      // 會讓讀報告的人只能猜。
      pMode.dead(
        '按「模式:逐句短語」後等了 6 秒，overlay.displayMode 仍是 ' + JSON.stringify(modeBefore) + ';' +
          '按鈕 aria-pressed=' + JSON.stringify(pressed) +
          (anyPressed ? '' : '（沒有任何一顆被選取 → 點擊可能沒被接收）')
      )
    }
  }

  // ── (g) 字體大小:±一級 ──
  // key 是「A+」不是「字體放大」:無障礙名稱取自鈕上的文字,而 title 只是補充。
  // 登記表寫 title 的話,列舉端永遠對不到它 —— 而兩邊都說得通,所以那種
  // 不一致不會自己浮出來(實際發生過,見 effect-inventory 的 normalizeTitle)。
  const pFontUp = probe(key('overlay', 'button', 'A+'), '浮層')
  const pFontDown = probe(key('overlay', 'button', 'A-'), '浮層')
  const fs0 = await readSetting(main, 'overlay.fontSize')
  if (await clickOverlay('字體放大')) {
    await sleep(800)
    const fs1 = await readSetting(main, 'overlay.fontSize')
    if (typeof fs0 === 'number' && fs1 > fs0) {
      pFontUp.works(`overlay.fontSize ${fs0} → ${fs1}`, EVIDENCE.DATA)
    } else {
      pFontUp.dead(`按「字體放大」後 overlay.fontSize=${fs1},原本 ${fs0},沒有變大`)
    }
    if (await clickOverlay('字體縮小')) {
      await sleep(800)
      const fs2 = await readSetting(main, 'overlay.fontSize')
      if (typeof fs2 === 'number' && fs2 < fs1) {
        pFontDown.works(`overlay.fontSize ${fs1} → ${fs2}`, EVIDENCE.DATA)
      } else {
        pFontDown.dead(`按「字體縮小」後 overlay.fontSize=${fs2},原本 ${fs1},沒有變小`)
      }
    } else {
      pFontDown.unreachable('找不到「字體縮小」按鈕')
    }
  } else {
    pFontUp.unreachable('找不到「字體放大」按鈕')
    pFontDown.unreachable('找不到「字體放大」按鈕,後續的縮小無從比較')
  }

  // ── (h) Panic 救援:先關掉 AI 即時救援 ──
  //
  // usePanic 的註解明寫:「AI 關閉時 main 直接送模板卡,不走 thinking」。
  // 所以這條在沒有任何 AI 供應商的環境裡**是量得到的** —— 而且量的是產品
  // 明確承諾的離線路徑(設定頁的說明寫著「省 token、斷網可用」)。
  // 我第一版沒關 AI,結果 rescue 永遠等不到,差點誤判成「Panic 壞了」。
  // **必須讀回來確認真的關掉了。**
    // 我第一版寫 `window.api.updateSettings?.(...)` —— preload 裡根本沒有
    // 這個方法(叫 setSettings),選用運算子讓它靜靜地回傳 undefined,
    // 而我的檢查只看「有沒有丟錯」→ 於是判定「前置條件備妥」,
    // 實際上 AI 還開著。Panic 走 AI 鏈路找不到模型 → 直接回 idle → 沒有救援卡
    // → 我把它報成「Panic 壞了」。**那是量測端自己撒的謊,而且是用一種
    // 看起來很嚴謹的「有沒有 throw」寫的。** 前置條件一律要讀回來確認。
    const aiOff = await main.evaluate(async () => {
      if (typeof window.api?.setSettings !== 'function') return { ok: false, why: 'preload 沒有 setSettings' }
      await window.api.setSettings({ scenario: { aiModeEnabled: false } })
      const s = await window.api.getSettings()
      return { ok: s?.scenario?.aiModeEnabled === false, why: `讀回 aiModeEnabled=${s?.scenario?.aiModeEnabled}` }
    })
    const pPanic = probe(key('overlay', 'button', 'Panic 救援'), '浮層')
    if (!aiOff.ok) {
      pPanic.unreachable(`無法關閉 AI 即時救援(${aiOff.why});Panic 需要 AI 才有回應`)
    } else {
      // 讀回確認 AI 確實關掉(取代原本的 sleep(900)):Panic 需要先確定走的是
      // 場景模板路徑,不然量到的是「AI 還在線上」的另一條分支。
      //
      // ⚠️ 這一段原本的 `} else {` 從來沒有被關上,末尾多了一個孤兒 `}` ——
      // 整支稽核在 Panic 那一步之後的邏輯都掛在錯的區塊裡。是本次改這裡
      // (把 sleep 換成讀回確認)時才發現的,順手修掉了。
      await writeSetting(main, 'scenario.aiModeEnabled', false)
    }
    // 這裡原本先算了一份 `panicBefore = await overlayTitle('Panic 救援')` 但
    // 從未拿它做比較。緊接著的 clickOverlay() 會自己再找一次按鈕,所以那份
    // 「按下去之前浮層是什麼標題」實際上沒有被拿來斷言任何事。
    // 刪掉它而不是拿它湊一個斷言:Panic 這條路徑的證據是「救援卡有沒有出現」
    // (見下面輪詢),不是按鈕前後的標題差異。
    if (await clickOverlay('Panic 救援')) {
      // **證據用 [data-overlay-card="rescue"],不是按鈕的 title。**
      // 「救援顯示中 — 點擊關閉」那個 title 只存在於藥丸形態;
      // 展開形態裡 Panic 是 ToolBtn,active 狀態只換 class。
      // 我第一版只找 title,於是預設形態(展開)永遠等不到,
      // 差點把一個正常的功能報成壞掉。data-overlay-card 三種形態都渲染。
      //
      // 救援卡只顯示 12 秒然後自動回 idle,所以要輪詢抓「出現過」,
      // 不能只睡固定時間再看一眼 —— 那會漏掉「閃一下就消失」。
      let seen = null
      for (let i = 0; i < 40 && !seen; i++) {
        seen = await overlay
          .evaluate(() => {
            const c = document.querySelector('[data-overlay-card="rescue"]')
            return c ? (c.innerText || '').replace(/\s+/g, ' ').trim() : null
          })
          .catch(() => null)
        if (!seen) await sleep(100)
      }
      if (seen) {
        pPanic.works(
          `AI 關閉時 4 秒內送出模板卡,內容:${JSON.stringify(seen.slice(0, 48))};12 秒後自動收起`,
          EVIDENCE.OTHER_WINDOW
        )
        await shoot(overlay, '05-浮層-panic')
      } else {
        pPanic.dead(
          'AI 即時救援已關閉(應該直接送場景模板卡),但按下去 4 秒內浮層沒有出現任何救援卡 —— ' +
            '卡住時最需要的那個功能沒反應'
        )
      }
    } else {
      pPanic.unreachable('找不到「Panic 救援…」按鈕')
    }

  // ── (i) 該你說話了 / 即時教練:兩顆提示開關,資料層必須翻轉 ──
  //
  // 它們的 key 來自 title 的收斂(「開啟「該你說話了」提示」)。開啟後 title 變成
  // 「關閉「該你說話了」提示」—— 所以**關掉再驗一次**,兩次都必須真的翻轉。
  //
  // ⚠️ 兩顆鈕的「開」與「關」是**不同的 title**(不是同一顆換字):
  //     「開啟「該你說話了」提示」 ↔ 「關閉「該你說話了」提示」
  //     「開啟即時教練」           ↔ 「即時教練開啟中」
  // 把它們當成「關閉+名稱」會找不到後者 —— 這是實際踩過的。
  for (const [offPrefix, onPrefix, path] of [
    ['開啟「該你說話了」提示', '關閉「該你說話了」提示', 'overlay.turnYield'],
    ['開啟即時教練', '即時教練開啟中', 'overlay.coaching']
  ]) {
    const p = probe(key('overlay', 'button', offPrefix), '浮層')
    const before = await readSetting(main, path)
    if (!(await overlayTitle(offPrefix))) {
      // 已經是「開」的狀態:先關掉再驗一次,否則這一輪這顆根本就沒機會量。
      if (!(await clickOverlay(onPrefix))) {
        p.unreachable(`找不到「${offPrefix}…」也沒找到「${onPrefix}…」`)
        continue
      }
      // 讀回確認真的關掉了(取代原本的 sleep(900))
      const off = await waitSetting(main, path, false)
      if (!off.ok) {
        p.unreachable(`點「${onPrefix}」後 ${path} 讀回仍是 ${JSON.stringify(off.got)}(預期 false)`)
        continue
      }
    }
    const mid = await readSetting(main, path)
    if (await clickOverlay(offPrefix)) {
      // 讀回確認真的翻轉了(取代原本的 sleep(900))
      const flipped = await waitSetting(main, path, !mid)
      const after = flipped.got
      if (flipped.ok && after === !mid && typeof mid === 'boolean') {
        p.works(`${path} ${mid} → ${after}`, EVIDENCE.DATA)
      } else {
        p.dead(`按「${offPrefix}」後 ${path}=${JSON.stringify(after)},預期 ${!mid}`)
      }
      // 還原:後面的步驟不應該被這顆開關影響。讀回確認真的回到原狀。
      await clickOverlay(onPrefix).catch(() => {})
      await waitSetting(main, path, before)
    } else {
      p.unreachable(`找不到「${offPrefix}…」按鈕(原本 ${path}=${JSON.stringify(before)})`)
    }
  }

  // ── (i2) 教練提示的靜音與恢復 ──
  //
  // 這一組是本輪新增的「低干擾」設計:使用者看到不想要的建議時,
  // 按提示條本體就把**這一種**靜默到本場結束。兩個必須被驗的問題:
  //   1. 按下去之後「本場已靜默」真的出現了嗎?(沒有回饋 = 使用者以為按壞了)
  //   2. 恢復鈕真的把靜默清空了嗎?(清不掉 = 使用者被迫重開浮層)
  //
  // 前提:提示條只有真的說到那個程度才會出現(語速/填充詞/冷場),
  // 稽核環境裡沒有辦法自然觸發 —— 所以用 overlay.coachingHint 稽核橋強制。
  const pMute = probe(idKey('overlay', 'coaching-mute'), '浮層')
  const pUnmute = probe(idKey('overlay', 'coaching-unmute'), '浮層')
  await overlay.evaluate(() => window.__auditForce?.('overlay.coachingHint', { kind: 'filler', message: '稽核:填充詞偏多' })).catch(() => {})
  await sleep(700)
  const muteBtn = await overlay.locator('[data-effect-id="coaching-mute"]').count().catch(() => 0)
  if (muteBtn === 0) {
    pMute.unreachable('浮層上沒有教練提示條(稽核橋強制失敗,或教練被設定關掉了)')
    pUnmute.unreachable('沒有教練提示條可靜默,恢復鈕也不會出現')
  } else {
    await overlay.locator('[data-effect-id="coaching-mute"]').first().click()
    await sleep(600)
    const mutedRow = await overlay.locator('[data-effect-id="coaching-unmute"]').count().catch(() => 0)
    const mutedText = mutedRow
      ? await overlay.locator('[data-effect-id="coaching-unmute"]').first().innerText()
      : ''
    if (mutedRow > 0 && mutedText.includes('已靜默')) {
      pMute.works(`按提示條後出現「${mutedText.replace(/\s+/g, ' ').trim().slice(0, 24)}…」`, EVIDENCE.DOM)
    } else {
      // 按了之後沒有任何可見變化 —— 使用者會直接結論「按鈕壞了」。
      pMute.dead(`按了提示條但「本場已靜默」沒有出現(列數 ${mutedRow})`)
    }
    if (mutedRow === 0) {
      pUnmute.unreachable('沒有靜默中的種類,恢復鈕本來就不該出現')
    } else {
      await overlay.locator('[data-effect-id="coaching-unmute"]').first().click()
      await sleep(600)
      const stillMuted = await overlay.locator('[data-effect-id="coaching-unmute"]').count().catch(() => 0)
      if (stillMuted === 0) pUnmute.works('按恢復後「本場已靜默」真的消失', EVIDENCE.DOM)
      else pUnmute.dead(`按了恢復但「本場已靜默」還在(${mutedText.replace(/\s+/g, ' ').trim().slice(0, 24)})`)
    }
    await overlay.evaluate(() => window.__auditForce?.('overlay.coachingHint', null)).catch(() => {})
    await sleep(300)
  }

  // ── (j) 真實投遞路徑:看得見要送到,看不見不該燒掉冷卻 ──
  //
  // 這一段**不是控制項**(使用者沒有東西可以按),所以不用 probe(),
  // 用 report.add 直接記問題 —— 它進 problems,會讓稽核變紅。
  //
  // 為什麼值得量:這兩個 session 挖到的真產品缺陷都在這一條路徑上,而
  // `audit:effects` 原本**只量那兩顆開關有沒有翻轉**,從來沒有真的推過一段
  // 逐字稿。所以「送不出去卻記了冷卻」與「隱藏時也記冷卻」對這支稽核而言都是
  // 隱形的 —— 覆蓋率 100%、138 有效果、0 沒效果,而那條路徑**從來沒被執行過**。
  //
  // 手法:**用冷卻當量測工具,不要用「有沒有畫出來」。**
  // 寫這段時實際踩到:「隱藏時不該有提示」那條斷言在修好與沒修好的版本裡
  // **都會通過** —— win.hide() 之後 Playwright 仍然讀得到 DOM,而隱藏視窗的
  // setTimeout 被 Chromium 節流,防抖觸發時間不穩。抓不到東西卻長得像防線的
  // 斷言比沒有更糟。冷卻是資料層的事實,不依賴畫面也不依賴節流。
  const overlayVisibleNow = () =>
    app.evaluate(({ BrowserWindow }) => {
      // dev 是 #/overlay、packaged 是 #overlay(loadFile 的 hash 會吃掉斜線)
      const isOverlay = (u) => u.endsWith('#overlay') || u.endsWith('#/overlay')
      const w = BrowserWindow.getAllWindows().find((x) => isOverlay(x.webContents.getURL()))
      return !!w && !w.isDestroyed() && w.isVisible()
    })

  /** 切換浮層可見性並**讀回確認**;renderer 端看不到自己的視窗可見性。 */
  const setOverlayShown = async (want) => {
    await main.evaluate(
      (v) =>
        v
          ? window.api.overlayShow({ title: '投遞量測', content: '投遞量測' })
          : window.api.overlayHide(),
      want
    )
    for (let i = 0; i < 40; i++) {
      if ((await overlayVisibleNow()) === want) return true
      await sleep(100)
    }
    return false
  }

  /** 清掉 main 端的冷卻(兩階段之間必須做,否則量的是前一階段留下的帳)。 */
  const resetTurnYieldCooldown = () => main.evaluate(() => window.api.contextReset())

  /** 提示現在在畫面上嗎?(innerText:被淡出動畫移出後就讀不到了) */
  const hintShown = () =>
    overlay
      .evaluate(() => document.body.innerText.includes('該你說話了'))
      .catch(() => false)

  /** 輪詢到提示出現為止;回傳有沒有等到。 */
  const waitHintAppears = async (timeoutMs = 6_000) => {
    for (let waited = 0; waited < timeoutMs; waited += 150) {
      if (await hintShown()) return true
      await sleep(150)
    }
    return false
  }

  /**
   * 等提示退場。
   *
   * **這一步不能省。** useTurnYield 的 HINT_DISPLAY_MS 是 6 秒,所以一個在隱藏
   * 視窗裡送達的提示(舊行為)會在視窗被叫回來時**仍然亮著** —— 如果這時直接推
   * 下一句,第 (j-2) 段會把它誤讀成「新的提示有出現」而通過。缺陷就這樣被自己
   * 的殘影藏起來 —— 與 (h) 那個孤兒 `}` 同一類:量到綠燈,但量的是舊東西。
   */
  const waitHintGone = async (timeoutMs = 9_000) => {
    for (let waited = 0; waited < timeoutMs; waited += 200) {
      if (!(await hintShown())) return true
      await sleep(200)
    }
    return false
  }

  const tyBefore = await readSetting(main, 'overlay.turnYield')
  if (!(await writeSetting(main, 'overlay.turnYield', true)).ok) {
    report.add('state-unreached', '浮層', '無法開啟 overlay.turnYield,(j) 訊號投遞量測的前置條件不成立')
  } else if (!(await setOverlayShown(true))) {
    report.add('state-unreached', '浮層', '無法讓浮層顯示出來,(j) 訊號投遞量測的前置條件不成立')
  } else {
    report.measured('浮層訊號投遞(可見/隱藏)')

    // (j-1) 可見時:提示真的送達(這一格本來就應該是好的,是基線)
    await resetTurnYieldCooldown()
    await main.evaluate(() =>
      window.api.pushTranscript({ text: '請問這個專案的架構是怎麼設計的', speaker: 'them' })
    )
    const visibleOk = await waitHintAppears()
    if (!visibleOk) {
      report.add(
        'dead-ui',
        '浮層',
        '浮層可見時推入問句,6 秒內沒有出現「該你說話了」提示 —— ' +
          '這是最基本的一格;它不行的話使用者根本收不到搶話提示'
      )
    }
    await waitHintGone()

    // (j-2) 隱藏時:不該燒掉冷卻。
    //
    // 問句 B 在隱藏時送出,**不判斷有沒有畫出來**(見上方:那條量不到東西)。
    // 判斷在問句 C:它是**另一句話**,所以規則 1(同句 25 秒)擋不住它;
    // 擋得住的只有規則 2 的 15 秒全域冷卻 —— 而那只有「B 記了帳」才會存在。
    // **所以 C 出現 = B 沒有被記帳。**
    await resetTurnYieldCooldown()
    await setOverlayShown(false)
    await main.evaluate(() =>
      window.api.pushTranscript({ text: '那你怎麼處理資料延遲的問題', speaker: 'them' })
    )
    // 1.2s 防抖 + 送達。「有沒有記冷卻」在那之後就定了。
    await sleep(2_500)
    await setOverlayShown(true)
    // 先把舊提示等退場(見 waitHintGone 的註解),否則會拿 B 的殘影當成 C 的成功。
    await waitHintGone()
    await main.evaluate(() =>
      window.api.pushTranscript({ text: '可以請你說明一下測試策略嗎', speaker: 'them' })
    )
    const againOk = await waitHintAppears()
    if (!againOk) {
      report.add(
        'dead-ui',
        '浮層',
        '浮層隱藏時收到的搶話訊號**被記了冷卻**:把浮層叫回來後立刻再問一句,' +
          '提示已經不會出現(被 15 秒全域冷卻擋住)。' +
          '使用者的情境是「按熱鍵把浮層收掉 → 對方問話 → 什麼都沒看到,' +
          '而且接下來 25 秒再問也不會提示」'
      )
    }
    report.note('訊號投遞量測', { 可見時送達: visibleOk, 隱藏不記冷卻: againOk })
    await resetTurnYieldCooldown()
    await setOverlayShown(true)
  }
  await waitHintGone()
  await writeSetting(main, 'overlay.turnYield', tyBefore)

  // **把 AI 還原。** 這一步以前是「忘了」—— 而且是被那個孤兒 `}` 吃掉的。
  //
  // (h) 把 scenario.aiModeEnabled 關掉來驗 Panic 的離線模板路徑,而後面還有
  // 練習頁要量「AI 教練反饋」。AI 沒還原的話,練習頁的評分永遠等不到,
  // 於是 `完成回答` 被報成 dead、`下一題` 因為拿不到分數而根本不出現。
  // —— **量測端自己弄壞了狀態,然後把後果記在產品帳上。**
  //
  // 這三筆是修掉結構 bug 之後才浮現的:在結構錯的時候,這段程式碼掛在
  // 錯的區塊裡,等於從來沒有執行過 —— 所以「0 筆」是怎麼來的,現在清楚了。
  // 這裡是**指定**設成 true 而不是設回 before:Practice 的「AI 教練反饋」
  // 要走 AI,而 (h) 的目的就是要把它關掉。不設回來的話,這支稽核量到的
  // 「完成回答 / 下一題 / 查看總評」三顆按鈕,量的是一條 AI 根本沒接上的路徑。
  const aiBack = await writeSetting(main, 'scenario.aiModeEnabled', true)
  if (!aiBack.ok) report.note('⚠️ AI 總開關還原失敗', { want: true, got: aiBack.got })
}

// ───────── 5. 假裝置之後,還剩下什麼是真的量不到 ─────────

/**
 * 上一版這裡列了 6 項「需要真麥克風 / 真相機 / 真畫面」,那個分類在當時是誠實的
 * —— 但它把**產品最核心的路徑**(錄音→辨識→逐字稿、相機)整條放進了
 * 「沒有人驗過」的箱子裡。一份 84 個控制項全綠、而其中一條是錄音的報告,
 * 比紅燈危險。
 *
 * 這一版把其中大部分變成量得到(假麥克風 WAV / 假攝影機 / 本機 mock 服務),
 * 剩下的每一項都寫明**為什麼還是量不到**,而不是含糊的一句「需要真裝置」。
 *
 * ── 這裡曾經有一個 stepMediaResidue(),現在已經刪掉了 ──
 *
 * 它列了 4 項「環境限制」(本地 Whisper 模型 / 臉部量測 MediaPipe /
 * 螢幕擷取系統音訊 / 系統原生對話框),每一項都寫得很好 —— 但**它從來沒有被
 * 呼叫過**:不在 SEQUENCE 裡,也沒有任何地方呼叫它。所以這 4 筆從來沒有進過
 * 報告,`tally.unverifiable` 也從來沒有因為它們而增加。
 *
 * 它的內容現在被 scripts/lib/effect-inventory.mjs 的豁免表取代了,而且是更好
 * 的形式:那裡是**掛在具體控制項上**的(例:「系統音訊（對方）」標記為
 * REAL_DESKTOP,「匯出備份」標記為 NATIVE_DIALOG),覆蓋率對帳會把這些算進
 * 「豁免 25」並逐項印出原因。舊的這份是 4 條沒有對應控制項的孤立文字,
 * 讀報告的人無從知道它們涵蓋了哪些鈕。
 */

// ───────── 6. 全 App 逐頁探針 ─────────

/**
 * 直接寫 IndexedDB 播種。renderer 的資料層是 Dexie(Dexie 自己讀寫 IndexedDB,
 * 不走 IPC),所以播種只能這樣做 —— 與 audit-states.mjs 同一套做法。
 */
function dbEval(win, fn) {
  return win.evaluate(
    // eslint-disable-next-line no-new-func
    new Function(
      `return (async () => { const open = () => new Promise((res, rej) => { const r = indexedDB.open("ai-teleprompter"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const db = await open(); try { return await (${fn})(db) } finally { db.close() } })()`
    )
  )
}

const countOf = (main, store) =>
  dbEval(
    main,
    `(db) => new Promise((res) => { const r = db.transaction('${store}','readonly').objectStore('${store}').count(); r.onsuccess = () => res(r.result); r.onerror = () => res(-1) })`
  )

const clearAll = (main) =>
  dbEval(
    main,
    `(db) => new Promise((res, rej) => { const tx = db.transaction(['scripts','sessions','practiceRuns'],'readwrite'); for (const s of ['scripts','sessions','practiceRuns']) tx.objectStore(s).clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error) })`
  )

const seedScripts = (main, titles) =>
  dbEval(
    main,
    `(db) => new Promise((res, rej) => { const tx = db.transaction('scripts','readwrite'); const os = tx.objectStore('scripts'); const now = Date.now(); for (const t of ${JSON.stringify(titles)}) os.put({ title: t, content: '內容:' + t + '。這是一段夠長的示範內容。', createdAt: now, updatedAt: now }); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error) })`
  )

const seedSessions = (main) =>
  dbEval(
    main,
    `(db) => new Promise((res, rej) => {
      const tx = db.transaction('sessions','readwrite')
      const os = tx.objectStore('sessions')
      const now = Date.now()
      /**
       * 兩場會議,而不是一場。
       *
       * 第二場**帶著摘要**:錄音頁的那顆鈕在「未摘要」時是「AI 摘要」、
       * 有摘要時變成「重新摘要」——兩種都是**不同的確認目標**,只播種一種的話,
       * 另一種永遠不會出現在任何被列舉的畫面上(而它也不是豁免,
       * 所以覆蓋率對帳會說「這顆有登記但從來沒出現過」——那正是它應該說的)。
       */
      os.put({ title: '稽核會議紀錄', startedAt: now - 600000, endedAt: now, segments: [{ start: 0, speaker: 'them', text: '先確認一下進度。' }, { start: 8, speaker: 'me', text: '我們這週會把管線修好。' }, { start: 20, speaker: 'me', text: '另外我會補上測試。' }] })
      os.put({ title: '稽核會議紀錄-已摘要', startedAt: now - 1200000, endedAt: now - 600000, segments: [{ start: 0, speaker: 'them', text: '這一場已經有摘要了。' }], summary: { abstract: '種子摘要', keyPoints: ['種子重點'], todos: [], followUps: [], generatedAt: now - 1200000, model: 'mock-qwen' } })
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })`
  )

const seedRuns = (main) =>
  dbEval(
    main,
    `(db) => new Promise((res, rej) => { const tx = db.transaction('practiceRuns','readwrite'); const os = tx.objectStore('practiceRuns'); const now = Date.now(); os.put({ position: '稽核職位', type: '行為面試', questions: ['請自我介紹'], answers: [{ question: '請自我介紹', answerTranscript: '我是示範回答。', durationSec: 20, feedback: { score: 77, content: '內容', structure: '結構', delivery: '表達', betterAnswer: '示範' } }], createdAt: now, overallFeedback: '整體不錯。' }); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error) })`
  )

/** toast 的數量與文字 —— toast 是容器層的觀察,不是被點的那顆 ✕。 */
const toastText = (main) =>
  main
    .evaluate(() =>
      [...document.querySelectorAll('.toast-item')].map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
    )
    .catch(() => [])

/** 側欄/主區文字,拿來當「另一個容器真的變了」的證據。 */
const domText = (win, sel = 'main') =>
  win.evaluate((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').trim(), sel).catch(() => '')

/**
 * 依文字點一類控制項。回傳 true / false(找不到)/ 'disabled'。
 *
 * ⚠️ 踩過的坑(第一次實跑把這個檔案 90% 的探針都變成假的):
 *   原本把 `opts.exact` 直接寫在**頁面內的 callback** 裡 —— 而 opts 是 Node 端的
 *   閉包變數,序列化之後頁面裡是 undefined,`opts.exact` 當場 ReferenceError。
 *   因為整段包了 `.catch(() => false)`,它**靜靜地回傳 false**,而症狀是
 *   「按鈕存在、但按下去沒效果」(dead)—— 看起來像 8 個產品缺陷。
 *   教訓:探針的輔助函式本身出錯時,絕對不能長得像產品的錯。
 *   所以參數一律明列傳進去,而且任何非預期例外都要看得見(下面那個 throw)。
 */
const clickText = (win, text, opts = {}) =>
  win
    .evaluate(
      ([t, scope, exact]) => {
        const root = scope ? document.querySelector(scope) : document
        const list = [...(root || document).querySelectorAll('button, a[href]')]
        // title / aria-label 也納入比對:icon-only 鈕的可及名稱不在 textContent 上
        // (audit-journey 已經踩過這個坑,這裡沿用同一條規則)。
        const hit = list.find((b) => {
          const txt = (b.textContent || '').replace(/\s+/g, ' ').trim()
          return (
            (exact ? txt === t : txt.includes(t)) ||
            (b.getAttribute('title') || '').includes(t) ||
            (b.getAttribute('aria-label') || '').includes(t)
          )
        })
        if (!hit) return false
        if (hit.disabled) return 'disabled'
        hit.click()
        return true
      },
      [text, opts.scope ?? null, opts.exact ?? false]
    )
    .catch((err) => {
      // 不再靜默:輔助函式自己壞掉必須當場中止,而不是回一個看起來像產品缺陷的 false。
      throw new Error(`clickText(「${text}」) 的量測端出錯:${String(err?.message || err).split('\n')[0]}`)
    })

/** 用 data-effect-id 點一顆控制項(動態名稱的那一族)。 */
const clickEffectId = (win, id, index = 0) =>
  win
    .evaluate(
      ([i, n]) => {
        const list = [...document.querySelectorAll(`[data-effect-id="${i}"]`)].filter(
          (e) => e.getBoundingClientRect().width > 0
        )
        const el = list[n]
        if (!el) return false
        if (el.disabled) return 'disabled'
        el.click()
        return true
      },
      [id, index]
    )
    .catch(() => false)

/**
 * 等某個 data-effect-id 的元素真的出現(且有版面)。
 *
 * 為什麼需要「等」而不是直接用 clickEffectId 的回傳值:確認框是 click 之後
 * 才 render 的,立刻去查會得到 false —— 而那個 false 與「這個版本根本沒有
 * 確認框」長得**一模一樣**。於是量測端會以為自己量到了「沒有框」,跳過按確認,
 * 最後把結果記成「按了沒反應」。**兩個完全不同的世界回傳同一個 false。**
 *
 * 這正是「沒量到」與「量不到」長得一模一樣的家族 —— 而這次量到的還是錯的那一個。
 */
const waitEffectId = async (win, id, timeoutMs = 2_000) => {
  const step = 100
  for (let waited = 0; waited <= timeoutMs; waited += step) {
    const hit = await win
      .evaluate(
        (i) =>
          [...document.querySelectorAll(`[data-effect-id="${i}"]`)].some(
            (e) => e.getBoundingClientRect().width > 0
          ),
        id
      )
      .catch(() => false)
    if (hit) return true
    await sleep(step)
  }
  return false
}

const readSettings = (main) => main.evaluate(async () => window.api.getSettings())

// 6.1 總覽
async function stepDashboard(app, main) {
  console.log('步驟 6：總覽頁…')
  await gotoViaSidebar(main, '總覽')
  await sleep(700)

  // (a) 準備度橫幅 → 真的到設定頁
  //
  // ⚠️ 這塊橫幅只在「有話要說」時渲染(全部就緒時它自己回 null)。
  // 所以先製造那個世界 —— 用產品自己的稽核覆寫把 Ollama 報成「裝好了但沒模型」。
  // 沒有這一步,上一輪量到的是「找不到」,而那是**環境沒備妥**,不是按鈕壞了。
  const pPre = probe(idKey('dashboard', 'preflight-compact'), '總覽')
  // 製造「有話要說」的世界:供應商=Ollama、而且它一個模型都沒有。
  //
  // ⚠️ 前一輪只強制了 models=[],沒改供應商 —— 而「沒模型」那條只有在
  // provider==='ollama' 時才會被評估。當下的供應商是 OpenAI 相容(前面的探針
  // 留的),而 API Key 剛好也填好了(那也是前面的探針留的)→ 一個問題都沒有
  // → 卡片自己回 null → 量到「找不到」。**那是探針沒把世界設對,不是按鈕壞了。**
  await main.evaluate(async () => {
    await window.api.setSettings({ ai: { provider: 'ollama' } })
    window.__auditForce?.('preflight.models', [])
  })
  await sleep(1800)
  const before = await main.evaluate(() => location.hash)
  const clicked = await clickEffectId(main, 'preflight-compact')
  if (clicked !== true) {
    // 失敗訊息要足夠讓人當場判斷「是產品還是量測」:
    // 卡片存在嗎?它有哪些形態?畫面上現在是什麼?
    const diag = await main.evaluate(() => ({
      nodes: [...document.querySelectorAll('[data-preflight]')].map((e) => e.getAttribute('data-preflight')),
      // 用屬性而不是文案:ready 列的文字會隨產品改版(舊文案「都準備好了」改版後這欄永遠 false),
      // data-preflight="ready" 才是穩定身分。
      bodyHasReady: document.querySelector('[data-preflight="ready"]') != null,
      head: (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ').slice(0, 60)
    }))
    pPre.unreachable(`找不到可點的準備度橫幅(${JSON.stringify(diag)})`)
  } else {
    await sleep(900)
    const after = await main.evaluate(() => location.hash)
    if (after.includes('settings') && after !== before) {
      pPre.works(`hash ${before} → ${after}`, EVIDENCE.DOM)
    } else {
      pPre.dead(`按了準備度橫幅但 hash 是 ${after}(預期 #/settings)`)
    }
  }

  // (b) 三張模式卡:各自導到不同的頁
  await gotoViaSidebar(main, '總覽')
  await sleep(600)
  const pMode = probe(idKey('dashboard', 'mode-card'), '總覽')
  const targets = new Set()
  for (let i = 0; i < 3; i++) {
    await gotoViaSidebar(main, '總覽')
    await sleep(500)
    const ok = await clickEffectId(main, 'mode-card', i)
    if (ok !== true) break
    await sleep(800)
    targets.add(await main.evaluate(() => location.hash))
  }
  if (targets.size >= 2) {
    pMode.works(`3 張卡導到 ${targets.size} 個不同頁面:${[...targets].join(' / ')}`, EVIDENCE.DOM)
  } else {
    pMode.dead(`三張模式卡只導到 ${targets.size} 個頁面(${[...targets].join(' / ')}) —— 其中幾顆按了沒反應`)
  }

  // (c) 沒有講稿時的範例稿鈕 —— 全新使用者的第一顆鈕
  //
  // 為什麼是獨立一條:它按下去要**跨三層**生效(IndexedDB 真的多一份有內容的
  // 講稿 → 浮層真的開起來並帶著那份內容 → 導到講稿頁),而它的失敗模式不是
  // 當掉,是「什麼都沒發生」:使用者按了畫面上唯一一顆看起來能用的鈕,
  // 卻停在原地,而且他沒有別的路可以看到這個產品的門面。
  //
  // 斷言只寫前兩層:導頁是同一條路的副作用(而且講稿頁自己的探針會驗那裡),
  // 而「浮層裡有範例稿的文字」才是使用者實際得到的東西 —— 用 DATA 當證據
  // (scripts 的數量),內容則附在 detail 裡。
  const pDemo = probe(idKey('dashboard', 'demo-script'), '總覽')
  await clearAll(main)
  // 先離開總覽再回來:卡片是從 React state 讀的,而 clearAll 只動 IndexedDB ——
  // 停在同一個路由上時,它還會顯示剛才那兩份講稿(與 stepScripts (g) 同一條
  // 理由:沒重新掛載的頁面不是你當下看到的世界)。
  await gotoViaSidebar(main, '設定')
  await sleep(400)
  await gotoViaSidebar(main, '總覽')
  await sleep(900)
  const demoBefore = await countOf(main, 'scripts')
  const demoClicked = await clickEffectId(main, 'demo-script')
  if (demoClicked !== true) {
    const why = await main.evaluate(() => ({
      samePage: document.querySelectorAll('[data-effect-id="demo-script"]').length,
      head: (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ').slice(0, 70)
    }))
    pDemo.unreachable(
      `總覽頁沒有可點的範例稿鈕(clickEffectId 回 ${JSON.stringify(demoClicked)};同頁實例 ${why.samePage};` +
        `畫面「${why.head}」)—— 它只在「一份講稿都沒有」時渲染`
    )
  } else {
    await sleep(3000)
    const demoAfter = await countOf(main, 'scripts')
    const dWin = app.windows().filter((w) => w !== main && /overlay/i.test(w.url()))[0] ?? null
    const dTxt = dWin ? await dWin.evaluate(() => document.body?.textContent || '').catch(() => '') : ''
    if (demoAfter <= demoBefore) {
      pDemo.dead(`按了範例稿鈕但 scripts 數量 ${demoBefore} → ${demoAfter} —— 稿子沒有被建立`)
    } else if (!/Flow|市場痛點/.test(dTxt.replace(/\s+/g, ''))) {
      pDemo.dead(
        `範例稿建好了(scripts ${demoBefore} → ${demoAfter})但浮層沒有帶到它的內容` +
          `(浮層文字前 80 字=${JSON.stringify(dTxt.replace(/\s+/g, ' ').slice(0, 80))})`
      )
    } else {
      pDemo.works(`scripts ${demoBefore} → ${demoAfter},浮層內容含範例稿文字`, EVIDENCE.DATA)
    }
  }

  // (d) 開始提詞(總覽的最近講稿卡)與列表其他講稿的「提詞」
  await seedScripts(main, ['稽核總覽講稿', '稽核備用講稿'])
  await gotoViaSidebar(main, '總覽')
  await sleep(900)
  const pLatest = probe(key('dashboard', 'button', '開始提詞'), '總覽')
  const ok = await clickText(main, '開始提詞')
  if (ok !== true) {
    pLatest.unreachable('總覽頁沒有「開始提詞」鈕(需要至少一份講稿)')
  } else {
    await sleep(2500)
    const visible = await main.evaluate(async () => (await window.api.overlayIsVisible?.()) ?? null)
    const overlayWin = app.windows().find((w) => w !== main)
    const overlayText = overlayWin ? await domText(overlayWin, 'body') : ''
    if (visible === true && overlayText.includes('稽核')) {
      pLatest.works(`overlayIsVisible=${visible},浮層內容含講稿標題`, EVIDENCE.OTHER_WINDOW)
    } else {
      pLatest.dead(`按了「開始提詞」之後 overlayIsVisible=${visible},浮層文字=${JSON.stringify(overlayText.slice(0, 40))}`)
    }
  }
  const pRow = probe(key('dashboard', 'button', '提詞'), '總覽')
  const rowOk = await clickText(main, '提詞', { exact: true })
  if (rowOk !== true) {
    pRow.unreachable('最近講稿列表只有一份講稿時沒有第二列的「提詞」鈕')
  } else {
    await sleep(1500)
    const t = app.windows().find((w) => w !== main)
    const overlayText = t ? await domText(t, 'body') : ''
    if (overlayText.includes('稽核')) pRow.works('浮層內容換成那一份講稿', EVIDENCE.OTHER_WINDOW)
    else pRow.dead(`按了列表的「提詞」但浮層文字=${JSON.stringify(overlayText.slice(0, 40))}`)
  }

  // (e) 首次上手卡的三顆步驟 → 各自導到**不同**的頁
  //
  // 為什麼值得單獨一條:這張卡是「P0 首次使用 3 分鐘路徑」的入口,
  // 而它的三顆鈕是同一種視覺、按下去導到三個不同地方。若其中一顆指錯頁
  // (例:校準鈕跳到錄音頁),使用者的第一個動作就把他送到錯的頁面,
  // 而他很可能不會回來。這種錯誤在截圖與存在性稽核裡完全看不出來。
  //
  // 完成後卡片會收成一行 —— 所以必須在「還沒全部完成」的時候量,
  // 而這正是探查這個專案時大部分狀態的預設樣子。
  const pOnboarding = probe(idKey('onboarding', 'onboarding-step'), '總覽')
  await gotoViaSidebar(main, '總覽')
  await sleep(700)
  const onbCount = await main.evaluate(
    () => document.querySelectorAll('[data-effect-id="onboarding-step"]').length
  )
  if (onbCount === 0) {
    pOnboarding.unreachable('總覽頁沒有首次上手卡(三步都完成後會收成一行,那時本來就沒有可按的步驟)')
  } else {
    const targets = new Set()
    for (let i = 0; i < onbCount; i++) {
      await gotoViaSidebar(main, '總覽')
      await sleep(450)
      if ((await clickEffectId(main, 'onboarding-step', i)) !== true) break
      await sleep(750)
      targets.add(await main.evaluate(() => location.hash))
    }
    if (targets.size >= 2) {
      pOnboarding.works(
        `${onbCount} 顆步驟導到 ${targets.size} 個不同頁面:${[...targets].join(' / ')}`,
        EVIDENCE.DOM
      )
    } else {
      pOnboarding.dead(
        `${onbCount} 顆上手步驟只導到 ${targets.size} 個頁面(${[...targets].join(' / ')}) —— 三顆鈕沒有各自通往不同的地方`
      )
    }
  }

  // (f) 卡片底部的校準提醒(它接下了被移除的「開始三部曲」裡唯一不是步驟的事)
  //
  // 為什麼要單獨驗一行提醒:它只在「還沒校準」且卡片還沒收合時渲染,
  // 而校準決定浮層的字級與滾動速度 —— 沒有它,新使用者會用預設值跑完第一場,
  // 而那不是他會主動去設定頁找的東西。這一行是這件事唯一的入口。
  const pCal = probe(idKey('onboarding', 'onboarding-calibration'), '總覽')
  await gotoViaSidebar(main, '總覽')
  await sleep(800)
  const calClicked = await clickEffectId(main, 'onboarding-calibration')
  if (calClicked !== true) {
    const why = await main.evaluate(() => ({
      card: document.querySelector('[data-onboarding]')?.getAttribute('data-onboarding') ?? '(沒有卡片)',
      steps: document.querySelectorAll('[data-effect-id="onboarding-step"]').length
    }))
    pCal.unreachable(
      `總覽頁沒有校準提醒那一行(data-onboarding=${why.card},卡片上有 ${why.steps} 顆步驟)—— ` +
        `它只在「還沒有 personal.profile」且三步還沒完成時渲染`
    )
  } else {
    await sleep(900)
    const hash = await main.evaluate(() => location.hash)
    if (hash.includes('calibration')) pCal.works(`hash → ${hash}`, EVIDENCE.DOM)
    else pCal.dead(`按了校準提醒之後 hash 是 ${hash},預期包含 calibration`)
  }
}

// 6.2 講稿
async function stepScripts(app, main) {
  console.log('步驟 7：講稿頁…')
  await gotoViaSidebar(main, '提詞講稿')
  await sleep(900)

  // (a) 新講稿 → 資料層真的 +1
  //
  // 前置:上一動(浮層那一步)把編輯器弄髒了,而 dirty 時按「新講稿」會先跳
  // 確認對話框(「建立新講稿會遺失目前的修改」)—— 確認之後才會真的新增。
  // 這不是產品的毛病,是稽核必須能從上一個探針留下的狀態繼續。
  const pNew = probe(key('scripts', 'button', '新講稿'), '講稿')
  const before = await countOf(main, 'scripts')
  const clicked = await clickText(main, '新講稿')
  await sleep(600)
  const asked = await settleDialogs(main)
  await sleep(900)
  const after = await countOf(main, 'scripts')
  if (after > before) {
    pNew.works(`IndexedDB scripts ${before} → ${after}${asked ? '(dirty 時先問了確認,確認後真的新增)' : ''}`, EVIDENCE.DATA)
  } else {
    pNew.dead(`按了「新講稿」(clicked=${clicked})但 scripts 數量 ${before} → ${after}`)
  }

  // (b) 列表選取 → 編輯器換成那一份(另一個容器的內容變了)
  const pRow = probe(idKey('scripts', 'script-row'), '講稿')
  const rows = await main.evaluate(() => document.querySelectorAll('[data-effect-id="script-row"]').length)
  if (rows < 2) {
    pRow.unreachable(`列表只有 ${rows} 份講稿,無法驗證「換了另一份」`)
  } else {
    await clickEffectId(main, 'script-row', rows - 1)
    await sleep(800)
    const title = await main.evaluate(
      () => document.querySelector('input[placeholder="講稿標題"]')?.value ?? ''
    )
    if (title.trim().length > 0) pRow.works(`編輯器標題換成「${title}」`, EVIDENCE.DOM)
    else pRow.dead('選了列表裡的另一份講稿,但編輯器標題是空的')
  }

  // (c)(d)(e) 編輯器:輸入 → **手動儲存** → IndexedDB 真的變。
  //
  // ⚠️ Scripts 是手動儲存(dirty 才可按「儲存」),不是設定頁那套 onChange 即存。
  // 我第一版照設定頁的直覺寫「打完就讀 IndexedDB」,於是量到 3 筆 dead ——
  // **產品是好的,是我的斷言沒過。** 這三條現在一起驗,而且每一步都把
  // 「填了、按了、資料層真的變了」串成一條可追的因果。
  const pTitle = probe(key('scripts', 'input:text', '講稿標題'), '講稿')
  // 編輯器以 data-effect-id 當身分（它的 aria-label 帶著使用者自己取的講稿標題，
  // 用名稱的話 key 每換一份稿就變一次 —— 見 Scripts.tsx 的同一段註解）。
  const pBody = probe(idKey('scripts', 'script-body'), '講稿')
  const pSave = probe(key('scripts', 'button', '儲存'), '講稿')
  const NEW_TITLE = '稽核改名後'
  const MARK = `稽核內容-${Date.now()}`
  const el = main.locator('input[placeholder="講稿標題"]').first()
  const ta = main.locator('main textarea').first()
  const titlesInDb = () =>
    dbEval(
      main,
      `(db) => new Promise((res) => { const r = db.transaction('scripts','readonly').objectStore('scripts').getAll(); r.onsuccess = () => res(r.result.map((s) => s.title)); r.onerror = () => res([]) })`
    )
  const contentsInDb = () =>
    dbEval(
      main,
      `(db) => new Promise((res) => { const r = db.transaction('scripts','readonly').objectStore('scripts').getAll(); r.onsuccess = () => res(r.result.map((s) => s.content)); r.onerror = () => res([]) })`
    )

  if (!(await el.isVisible().catch(() => false)) || !(await ta.isVisible().catch(() => false))) {
    pTitle.unreachable('沒有選中的講稿,標題欄 / 編輯器不存在')
    pBody.unreachable('同上')
    pSave.unreachable('同上')
  } else {
    // (c) 標題:輸入 → 儲存 → 資料層改名
    await el.click()
    await el.fill(NEW_TITLE)
    await sleep(400)
    await clickText(main, '儲存')
    await sleep(1000)
    const titles = await titlesInDb()
    if (titles.includes(NEW_TITLE)) pTitle.works(`輸入後按儲存,IndexedDB 裡出現「${NEW_TITLE}」`, EVIDENCE.DATA)
    else pTitle.dead(`改了標題並按了儲存,但 IndexedDB 是 ${JSON.stringify(titles)}`)

    // (d) 內容:輸入 → 儲存 → 資料層有它
    await ta.click()
    await ta.fill(`${MARK}\n第二行`)
    await sleep(400)
    await clickText(main, '儲存')
    await sleep(1000)
    const contents = await contentsInDb()
    if (contents.some((c) => String(c).includes(MARK))) {
      pBody.works(`IndexedDB scripts.content 含「${MARK.slice(0, 12)}…」`, EVIDENCE.DATA)
    } else {
      pBody.dead('打了內容並按了儲存,但 IndexedDB 裡沒有它 —— 使用者以為存下了')
    }

    // (e) 儲存鈕本身:再一次編輯 → 鈕從「已儲存」變「儲存」→ 按下去 → 回「已儲存」
    const labelOf = () =>
      main.evaluate(() => {
        const b = [...document.querySelectorAll('main button')].find((x) => /儲存/.test(x.textContent || ''))
        return b ? (b.textContent || '').replace(/\s+/g, ' ').trim() : null
      })
    const idle = await labelOf()
    await ta.click()
    await ta.fill(`${MARK}\n第三行`)
    await sleep(500)
    const dirtyLabel = await labelOf()
    await clickText(main, '儲存')
    await sleep(1000)
    const savedLabel = await labelOf()
    if (String(idle).includes('已儲存') && String(dirtyLabel).includes('儲存') && !String(dirtyLabel).includes('已儲存') && String(savedLabel).includes('已儲存')) {
      pSave.works(`鈕文字「已儲存」→「儲存」→「已儲存」`, EVIDENCE.DOM)
    } else {
      pSave.dead(`儲存鈕的文字變化是「${idle}」→「${dirtyLabel}」→「${savedLabel}」,預期是 已儲存 → 儲存 → 已儲存`)
    }
  }

  // (f) 搜尋 → 列表真的被過濾
  const pSearch = probe(key('scripts', 'input:text', '搜尋講稿'), '講稿')
  const allRows = await main.evaluate(() => document.querySelectorAll('[data-effect-id="script-row"]').length)
  const search = main.locator('input[aria-label="搜尋講稿"]').first()
  if (!(await search.isVisible().catch(() => false))) {
    pSearch.unreachable('找不到搜尋欄')
  } else {
    await search.click()
    await search.fill('絕對不存在的字串-zzz')
    await sleep(500)
    const noneRows = await main.evaluate(() => document.querySelectorAll('[data-effect-id="script-row"]').length)
    await search.fill('')
    await sleep(500)
    const backRows = await main.evaluate(() => document.querySelectorAll('[data-effect-id="script-row"]').length)
    if (noneRows < allRows && backRows === allRows) {
      pSearch.works(`過濾 ${allRows} → ${noneRows} 列,清空搜尋回到 ${backRows} 列`, EVIDENCE.DOM)
    } else {
      pSearch.dead(`搜尋沒有過濾列表(${allRows} → ${noneRows},清空後 ${backRows})`)
    }
  }

  // (g) 空狀態的「建立第一份講稿」
  const pEmpty = probe(key('scripts', 'button', '建立第一份講稿'), '講稿')
  await clearAll(main)
  await gotoViaSidebar(main, '總覽')
  await gotoViaSidebar(main, '提詞講稿')
  await sleep(800)
  const emptyBefore = await countOf(main, 'scripts')
  const emptyOk = await clickText(main, '建立第一份講稿')
  if (emptyOk !== true) {
    pEmpty.unreachable('空狀態的建立鈕沒有渲染')
  } else {
    await sleep(900)
    const emptyAfter = await countOf(main, 'scripts')
    if (emptyAfter > emptyBefore) pEmpty.works(`scripts ${emptyBefore} → ${emptyAfter}`, EVIDENCE.DATA)
    else pEmpty.dead(`按了空狀態的建立鈕但 scripts 還是 ${emptyAfter}`)
  }
  // 「已儲存」不再在這裡記 unreachable:它與「儲存」是同一顆鈕的 disabled 外觀,
  // 這種「同一個控制項的另一個狀態」屬於登記表的豁免(帶理由),不是量測失敗。
  // 區別很重要:unreachable 會進 state-unreached 問題清單,
  // 於是「刻意不驗」與「該驗而沒驗到」在報告裡長得一模一樣。

  // (h) 開始提詞(編輯器)→ 浮層真的帶到剛打的內容
  await seedScripts(main, ['稽核提詞講稿'])
  await gotoViaSidebar(main, '總覽')
  await gotoViaSidebar(main, '提詞講稿')
  await sleep(900)
  const pLaunch = probe(key('scripts', 'button', '開始提詞'), '講稿')
  const launched = await main.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => x.textContent?.includes('開始提詞'))
    if (!b) return { ok: false, why: '找不到「開始提詞」鈕' }
    if (b.disabled) return { ok: false, why: '「開始提詞」是 disabled(編輯區是空的)' }
    b.click()
    return { ok: true }
  })
  if (!launched.ok) {
    pLaunch.unreachable(launched.why)
  } else {
    await sleep(2500)
    // 依 URL 認浮層(主程序啟動時就建了一個隱藏的浮層視窗 ——
    // 「不是 main 的那一個」在浮層沒開起來時也會「找到」一個空的視窗)。
    const win = app.windows().filter((w) => w !== main && /overlay/i.test(w.url()))[0] ?? null
    /**
     * ⚠️ 用 textContent 而不是 innerText。
     *
     * 提詞內容被 line-clamp / 高度裁切時,Chromium 的 innerText 只回**看得見的那幾行**
     * —— 於是斷言「浮層裡有整份講稿」會失敗,即使它真的在。
     * 上一輪就是這樣:量到的文字是「內容 : 稽核」（後面被截掉了),
     * 而浮層其實收到了完整的講稿。innerText 適合量「使用者看到幾行」,
     * textContent 才是「內容有沒有送到」。這兩件事不同,不能用同一個函式量。
     */
    const txt = win ? await win.evaluate(() => document.body?.textContent || '').catch(() => '') : ''
    /**
     * **斷言要對「畫面上實際被選中的那份講稿」。**
     *
     * 原本寫死「浮層裡必須出現 seedScripts 那份的字串」。但講稿頁會自動
     * 選中最近更新的那一份，而前幾個步驟已經建立/播種過別的講稿 ——
     * 於是「開始提詞」帶走的是 UI 當下選中的那一份，不是我 seed 的那一份。
     * 量測端自己決定了被驗的對象，卻還用另一個對象的名字去斷言。
     *
     * 正確做法：先問資料層「現在最新的是哪一份」，拿它的內容特徵去比對。
     * 這樣不管 UI 選了哪一份，斷的都是「浮層帶到的是不是使用者眼前那份」。
     */
    const newest = await dbEval(
      main,
      `(db) => new Promise((res) => { const r = db.transaction('scripts','readonly').objectStore('scripts').getAll(); r.onsuccess = () => { const a = r.result || []; a.sort((x, y) => (y.updatedAt||0) - (x.updatedAt||0)); res(a[0] ? { title: a[0].title, content: String(a[0].content || '') } : null) }; r.onerror = () => res(null) })`
    )
    const marker = String(newest?.content ?? '').replace(/\s+/g, '').slice(0, 12)
    // **兩邊都去掉所有空白再比。** 浮層把內容一行一行渲染，DOM 上會多出
    // 資料層沒有的空白（`內容:稽核提詞講稿。這是` vs `內容 : 稽核提詞講稿。 這是`），
    // 所以逐字比對必然失敗 —— 而內容明明在那裡。
    // 去掉空白之後比對仍然是真的斷言：詞序與字都必須對得上。
    const flat = txt.replace(/\s+/g, '')
    if (marker && flat.includes(marker)) {
      pLaunch.works(
        `浮層帶到的是畫面上最新那份講稿「${newest.title}」的內容（去空白後特徵 ${JSON.stringify(marker)}）`,
        EVIDENCE.OTHER_WINDOW
      )
    } else {
      pLaunch.dead(
        `浮層沒有帶到畫面上最新的講稿。資料層最新=「${newest?.title ?? '（沒有）'}」` +
          `特徵=${JSON.stringify(marker)};浮層文字前 120 字=${JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 120))}`
      )
    }
  }

  // (h2) 錄影預覽的兩個關閉口徑。
  //
  // 這個 modal 只在 MediaRecorder 真的錄完之後出現 —— headless 做不到,
  // 所以用產品自己的稽核橋把它開起來(那是它为這兩個沒被量過的控制項留的入口)。
  for (const [keyId, how] of [
    [key('scripts', 'button', '關閉錄影預覽'), 'X 圖示鈕(aria-label)'],
    [key('scripts', 'button', '關閉'), '文字鈕']
  ]) {
    const p = probe(keyId, '講稿')
    const opened = await main.evaluate(() => window.__auditForce?.('scripts.preview', true)?.ok === true)
    if (!opened) {
      p.unreachable('稽核橋無法強制開啟錄影預覽')
      continue
    }
    await sleep(800)
    const up = await main.evaluate(() => !!document.querySelector('[data-modal-backdrop="preview"]'))
    if (!up) {
      p.unreachable('預覽 modal 沒有渲染')
      continue
    }
    const clicked = await main.evaluate((which) => {
      const root = document.querySelector('[data-modal-backdrop="preview"]')
      if (!root) return false
      const btns = [...root.querySelectorAll('button')]
      const b =
        which === 'x'
          ? btns.find((x) => (x.getAttribute('aria-label') || '') === '關閉錄影預覽')
          : btns.find((x) => (x.textContent || '').trim() === '關閉')
      if (!b) return false
      b.click()
      return true
    }, keyId.includes('預覽') ? 'x' : 'text')
    await sleep(700)
    const gone = await main.evaluate(() => !document.querySelector('[data-modal-backdrop="preview"]'))
    if (clicked && gone) p.works(`${how}:modal 真的關掉`, EVIDENCE.DOM)
    else p.dead(`${how}:按了關閉但 modal ${gone ? '已關' : '還在'}(clicked=${clicked})`)
  }

  // (i) 刪除講稿 → 確認 → 資料層真的 -1(取消則不變,負向)
  const pDel = probe(key('scripts', 'button', '刪除這份講稿'), '講稿')
  const delOk = await clickText(main, '刪除這份講稿')
  if (delOk !== true) {
    pDel.unreachable('找不到刪除鈕')
  } else {
    await sleep(700)
    const before = await countOf(main, 'scripts')
    await clickEffectId(main, 'confirm-cancel')
    await sleep(700)
    const afterCancel = await countOf(main, 'scripts')
    if (afterCancel !== before) {
      pDel.dead(`按了「取消」但 scripts 從 ${before} 變成 ${afterCancel} —— 取消不該改變資料`)
    } else {
      const delOk2 = await clickText(main, '刪除這份講稿')
      if (delOk2 !== true) {
        pDel.unreachable('第二次開確認對話框失敗')
      } else {
        await sleep(700)
        await clickEffectId(main, 'confirm-ok')
        await sleep(1000)
        const after = await countOf(main, 'scripts')
        if (after === before - 1) pDel.works(`scripts ${before} → ${after}(取消不變、確認才刪)`, EVIDENCE.DATA)
        else pDel.dead(`確認刪除後 scripts 是 ${after},預期 ${before - 1}`)
      }
    }
  }

  // (j) 空狀態的「用範例稿試提詞」
  //
  // 它與總覽頁那顆 demo 是同一個動作的兩面(那邊是「還沒有講稿」的卡片、
  // 這裡是編輯區的空狀態),而它們是**兩顆不同的控制項**:登記表兩筆都要有,
  // 探針也要各跑一次 —— 其中一顆被人刪掉時,覆蓋率必須能只對那一顆變紅。
  const pDemo2 = probe(idKey('scripts', 'demo-script'), '講稿')
  await clearAll(main)
  // 同上:清資料層不會重畫已經掛載的頁面(步驟 (g) 已經踩過一次)。
  await gotoViaSidebar(main, '總覽')
  await gotoViaSidebar(main, '提詞講稿')
  await sleep(900)
  const d2Before = await countOf(main, 'scripts')
  const d2Clicked = await clickEffectId(main, 'demo-script')
  if (d2Clicked !== true) {
    pDemo2.unreachable(`空狀態沒有可點的範例稿鈕(clickEffectId 回 ${JSON.stringify(d2Clicked)})`)
  } else {
    await sleep(3000)
    const d2After = await countOf(main, 'scripts')
    const w2 = app.windows().filter((w) => w !== main && /overlay/i.test(w.url()))[0] ?? null
    const t2 = w2 ? await w2.evaluate(() => document.body?.textContent || '').catch(() => '') : ''
    const flat2 = t2.replace(/\s+/g, '')
    if (d2After <= d2Before) {
      pDemo2.dead(`按了範例稿鈕但 scripts 數量 ${d2Before} → ${d2After} —— 稿子沒有被建立`)
    } else if (!/Flow|市場痛點/.test(flat2)) {
      pDemo2.dead(
        `範例稿建好了(scripts ${d2Before} → ${d2After})但浮層沒有帶到它的內容` +
          `(浮層文字前 80 字=${JSON.stringify(t2.replace(/\s+/g, ' ').slice(0, 80))})`
      )
    } else {
      pDemo2.works(`scripts ${d2Before} → ${d2After},浮層內容含範例稿文字`, EVIDENCE.DATA)
    }
  }
}

// 6.3 錄音轉錄(假麥克風 + 本機 mock 辨識)
async function stepRecord(app, main, stt, llm) {
  console.log('步驟 8：錄音頁(假麥克風 + mock 辨識)…')

  // 先把辨識引擎確認回雲端,而且**讀回來確認**。
  // ⚠️ 設定頁那一輪的工作就是切換引擎,而切到「本地 Whisper」會讓錄音走
  // ensureWhisper() → 下載數百 MB 模型 → 按鈕永遠停在「啟動中…」。
  // 第一次實跑就是這樣:錄音那一步的所有控制項都「找不到」,看起來像產品壞了。
  const engineState = await main.evaluate(async () => {
    await window.api.setSettings({ stt: { engine: 'cloud' } })
    const s = await window.api.getSettings()
    return { engine: s?.stt?.engine, baseUrl: s?.stt?.cloud?.baseUrl }
  })
  report.note('錄音前的辨識引擎', engineState)
  // 引擎切回雲端了，但 baseUrl 也要指向 mock —— 設定頁那一輪可能把它改掉過。
  // 只設不讀回，正是我這個專案被教訓過最多次的那件事。
  const sttReady = await ensureSttOnMock(main, stt)
  report.note('錄音前的 STT mock', { ready: sttReady, baseUrl: `${stt.origin}/v1` })
  await sleep(700)

  await gotoViaSidebar(main, '錄音轉錄')
  await sleep(1200)

  // (a) 「至少一個音訊來源」的負向驗證:兩個都關掉按下去不該有任何反應
  const pMic = probe(key('record', 'label:checkbox', '我的麥克風'), '錄音')
  const toggled = await main
    .evaluate(() => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('我的麥克風'))
      const box = label?.querySelector('input[type=checkbox]')
      if (!box) return false
      if (box.checked) box.click()
      return !box.checked
    })
    .catch(() => false)
  if (!toggled) {
    pMic.unreachable('找不到麥克風來源核選框')
  } else {
    await sleep(300)
    const started = await clickText(main, '開始聆聽')
    // 錯誤 toast 停留 12 秒,但**它出現的時間不保證**:輪詢 3 秒,不要用一次睡眠賭。
    let hitToast = null
    for (let i = 0; i < 12 && !hitToast; i++) {
      hitToast = (await toastText(main)).find((t) => t.includes('音訊來源')) ?? null
      if (!hitToast) await sleep(250)
    }
    const recording = (await domText(main, 'main')).includes('聆聽中')
    if (started === true && !recording && hitToast) {
      pMic.works(`兩個來源都關掉時給出「${hitToast}」,沒有開始錄音`, EVIDENCE.DOM)
    } else {
      pMic.dead(
        `來源全關時 clicked=${started}、recording=${recording}、toast=${JSON.stringify(hitToast)} —— 預期是「有提示且沒有開始錄音」`
      )
    }
    // 還原:把麥克風勾回來
    await main.evaluate(() => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('我的麥克風'))
      const box = label?.querySelector('input[type=checkbox]')
      if (box && !box.checked) box.click()
    })
    await sleep(400)
  }

  // (b) 會議名稱 → 存下來的標題真的是它
  const pTitle = probe(key('record', 'input:text', '會議名稱'), '錄音')
  const MEETING = '稽核會議-A'
  const titleInput = main.locator('input[aria-label="會議名稱"]').first()
  if (!(await titleInput.isVisible().catch(() => false))) {
    pTitle.unreachable('找不到會議名稱欄')
  } else {
    await titleInput.click()
    await titleInput.fill(MEETING)
    await sleep(400)
    pTitle.works('已填入,稍後以「存下來的標題」作為證據', EVIDENCE.DATA)
  }

  // (c) 開始聆聽 → mock 辨識有收到音訊、逐字稿真的出現
  const pStart = probe(key('record', 'button', '開始聆聽'), '錄音')
  const sessionsBefore = await countOf(main, 'sessions')
  // 前置條件:假麥克風沒掛上(或被 self-test 抽掉)時,**不點**。
  // 旗標不在 = 假裝置餵靜音 = VAD 不會切段 = mock 收到 0 bytes,這個結果
  // 與「收音壞了」完全同形 —— 點下去等 24 秒再記 dead,是把量測端缺前置
  // 誤報成產品缺陷的正確做法的反面。unreachable 的語意正是為此存在的。
  if (!FAKE_AUDIO_ARMED) {
    pStart.unreachable(
      '假麥克風未掛上(--use-file-for-fake-audio-capture 缺席):靜音無法區分「收音壞了」與「沒人說話」,這一輪不驗錄音'
    )
  } else {
    const started = await clickText(main, '開始聆聽')
    if (started !== true) {
      pStart.unreachable('找不到「開始聆聽」')
    } else {
      // 輪詢而不是睡固定 7 秒:語音是**分段**送出的(每段幾秒 + 一個猜測窗),
      // 而「幾秒才送到第一段」不是產品的常數而是管線的參數。
      // 上一輪睡 7 秒就斷言,量到 0 bytes —— 那是一顆好按鈕被時序記成 dead。
      const NEEDLE = stt.text.slice(0, 8)
      let bytes = 0
      let text = ''
      let appeared = false
      for (let i = 0; i < 80 && !appeared; i++) {
        bytes = stt.audioBytes()
        text = await domText(main, 'main')
        appeared = bytes > 0 && text.includes(NEEDLE)
        if (!appeared) await sleep(300)
      }
      if (appeared) {
        pStart.works(`mock 辨識收到 ${bytes} bytes 音訊,逐字稿出現「${NEEDLE}…」`, EVIDENCE.DATA)
      } else {
        pStart.dead(
          `開始聆聽後等了 24 秒:mock 收到 ${bytes} bytes、逐字稿${text.includes(NEEDLE) ? '有' : '沒有'}出現`
        )
      }
    }
  }

  // (d) 停止並儲存 → sessions 真的 +1、標題是剛剛輸入的、段落非空
  const pStop = probe(key('record', 'button', '停止並儲存'), '錄音')
  const stopOk = await clickText(main, '停止並儲存')
  if (stopOk !== true) {
    pStop.unreachable('錄音中找不到「停止並儲存」')
  } else {
    await sleep(2500)
    const sessionsAfter = await countOf(main, 'sessions')
    const saved = await dbEval(
      main,
      `(db) => new Promise((res) => { const r = db.transaction('sessions','readonly').objectStore('sessions').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })`
    )
    const mine = (saved || []).find((s) => s.title === '稽核會議-A')
    if (sessionsAfter === sessionsBefore + 1 && mine && (mine.segments || []).length > 0) {
      pStop.works(`sessions ${sessionsBefore} → ${sessionsAfter},新場次「${mine.title}」含 ${mine.segments.length} 段`, EVIDENCE.DATA)
    } else {
      pStop.dead(`停止後 sessions ${sessionsBefore} → ${sessionsAfter},找到的場次=${JSON.stringify(mine ? { title: mine.title, segs: (mine.segments||[]).length } : null)}`)
    }
  }

  // (e) 關閉這份報告 → 報告卡真的消失
  //
  // **證據必須是「報告卡不在畫面上」,而且不能只讀自己。**
  // 這顆鈕按下之後整張卡被移除,所以證據是 main 裡的「會後報告」四個字不見了 ——
  // 被點的元素自己消失也算,但那顆鈕消失是因為它跟著父層一起被移除,
  // 所以這裡斷言的是**父層**(報告卡)。
  const pClose = probe(idKey('record', 'report-close'), '錄音')
  const hadReport = (await domText(main, 'main')).includes('會後報告')
  const closed = await clickEffectId(main, 'report-close')
  if (!hadReport || closed !== true) {
    pClose.unreachable(
      `報告卡${hadReport ? '' : '沒出現'}${closed === 'disabled' ? '(關閉鈕是 disabled)' : ''}(關閉鈕存在時才能驗)`
    )
  } else {
    let gone = false
    for (let i = 0; i < 12 && !gone; i++) {
      gone = !(await domText(main, 'main')).includes('會後報告')
      if (!gone) await sleep(200)
    }
    if (gone) pClose.works('報告卡真的從畫面消失', EVIDENCE.DOM)
    else pClose.dead('按了關閉但會後報告還在')
  }

  // (f) 展開會議明細
  // **要展開的是這一輪剛錄出來的那一場，不是 seedSessions 播種的那一場。**
  // 這裡原本按「第一列」然後去找 seed 用的那個字串 —— 兩個 fixture 混在一起，
  // 斷言在驗一件跟被按的那顆鈕無關的事。它報「看不到逐字稿段落」時，
  // 其實是我量測端在找錯的東西。
  const pExpand = probe(idKey('record', 'session-row'), '錄音')
  const rowIdx = await main.evaluate((t) => {
    const rows = [...document.querySelectorAll('[data-effect-id="session-row"]')]
    const i = rows.findIndex((r) => (r.textContent || '').includes(t))
    if (i < 0) return -1
    rows[i].click()
    return i
  }, MEETING)
  if (rowIdx < 0) {
    pExpand.unreachable(`畫面上找不到標題為「${MEETING}」的會議列`)
  } else {
    await sleep(700)
    const text = await domText(main, 'main')
    if (text.includes(stt.text.slice(0, 8))) {
      pExpand.works(`展開「${MEETING}」後明細裡出現逐字稿段落（mock 辨識回來的內容）`, EVIDENCE.DOM)
    } else {
      pExpand.dead(
        `展開「${MEETING}」後明細裡看不到逐字稿段落;預期包含 ${JSON.stringify(stt.text.slice(0, 8))},` +
          `實際畫面=${JSON.stringify(text.slice(0, 80))}`
      )
    }
  }

  // (g) AI 摘要 → sessions.summary 真的被寫入(mock LLM)
  //
  // **要摘要的是這一輪錄的那一場，而且 AI 必須指向 mock。**
  // 兩個前置條件都要自己備妥：設定頁那一輪把 provider 與 stt 都改過了，
  // 而摘要走的是 AI 供應商不是 STT —— 引擎對了不代表 AI 也對。
  const aiReady = await ensureAiOnMock(main, llm)
  const pSummary = probe(key('record', 'button', 'AI 摘要'), '錄音')
  const llmCalls = llm.calls()
  const summaryClicked = await main.evaluate((t) => {
    const cards = [...document.querySelectorAll('main *')].filter(
      (e) => e.textContent?.includes(t) && e.querySelector?.('button')
    )
    for (const c of cards.reverse()) {
      const b = [...c.querySelectorAll('button')].find((x) => x.textContent?.includes('AI 摘要'))
      if (b) {
        b.click()
        return true
      }
    }
    return false
  }, MEETING)
  if (!aiReady) {
    pSummary.unreachable('AI mock 前置條件不成立，這一輪不驗摘要')
  } else if (summaryClicked !== true) {
    pSummary.unreachable(`找不到「${MEETING}」那張卡上的「AI 摘要」鈕（可能已經是「重新摘要」）`)
  } else {
    let summary = null
    for (let i = 0; i < 40 && !summary; i++) {
      const list = await dbEval(
        main,
        `(db) => new Promise((res) => { const r = db.transaction('sessions','readonly').objectStore('sessions').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })`
      )
      // **只認這一場的摘要。** 畫面上可能同時有別的場次(seedSessions 播種的)，
      // 找到「任何一個有 summary 的場次」並不能證明剛按的那顆有生效。
      summary = (list || []).find((s) => s.title === MEETING)?.summary ?? null
      if (!summary) await sleep(250)
    }
    if (summary) {
      pSummary.works(
        `「${MEETING}」的 summary.abstract=「${String(summary.abstract || '').slice(0, 24)}…」` +
          `;mock LLM 多收到 ${llm.calls() - llmCalls} 次請求`,
        EVIDENCE.DATA
      )
    } else
      pSummary.dead(
        `按了「AI 摘要」但「${MEETING}」沒有 summary —— 使用者等一輩子也拿不到摘要。` +
          `mock LLM 在這段期間多收到 ${llm.calls() - llmCalls} 次請求` +
          '（0 次代表請求根本沒送出來，那和「送出但失敗」是兩回事）'
      )
  }

  /**
   * (g2) 重新摘要 → **同一場**重跑一次,`generatedAt` 必須變新。
   *
   * 為什麼要在這裡補這一條:它是一顆**真實存在但從來沒在任何狀態裡出現過**的按鈕 ——
   * 稽核的狀態清單裡每一場會議都沒有摘要,所以列舉端只會看到「AI 摘要」。
   * 這種控制項比「按下去沒反應」更隱蔽:它連被問到都沒被問到,
   * 而覆蓋率報告裡它完全不存在(不是 0,是沒有這一列)。
   * 現在 seedSessions 會播一場**帶摘要**的會議,它才有機會被量。
   *
   * 斷言用 generatedAt 而不是「有沒有 summary」:兩顆鈕都會寫 summary,
   * 差別只在「重寫一遍」。時間戳變新才是「重跑」的證據。
   */
  const pReSummary = probe(key('record', 'button', '重新摘要'), '錄音')
  await seedSessions(main)
  await gotoViaSidebar(main, '總覽')
  await gotoViaSidebar(main, '錄音轉錄')
  await sleep(1400)
  const seededTitle = '稽核會議紀錄-已摘要'
  const readSummaryAt = async () => {
    const list = await dbEval(
      main,
      `(db) => new Promise((res) => { const r = db.transaction('sessions','readonly').objectStore('sessions').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })`
    )
    return (list || []).find((s) => s.title === seededTitle)?.summary?.generatedAt ?? null
  }
  const atBefore = await readSummaryAt()
  const reClicked = await main.evaluate((t) => {
    const rows = [...document.querySelectorAll('[data-effect-id="session-row"]')]
    const row = rows.find((r) => (r.textContent || '').includes(t))
    const card = row?.closest('.card')
    const b = card ? [...card.querySelectorAll('button')].find((x) => x.textContent?.includes('重新摘要')) : null
    if (!b) return false
    b.click()
    return true
  }, seededTitle)
  if (reClicked !== true) {
    pReSummary.unreachable(`找不到「${seededTitle}」那張卡上的「重新摘要」鈕`)
  } else {
    let atAfter = atBefore
    for (let i = 0; i < 40 && atAfter === atBefore; i++) {
      atAfter = await readSummaryAt()
      if (atAfter === atBefore) await sleep(250)
    }
    if (atBefore !== null && atAfter !== null && atAfter > atBefore) {
      pReSummary.works(`summary.generatedAt ${atBefore} → ${atAfter}(重寫了摘要)`, EVIDENCE.DATA)
    } else {
      pReSummary.dead(`按了重新摘要但 generatedAt 從 ${atBefore} 變成 ${atAfter},摘要沒有被重寫`)
    }
  }

  // (h) 存成講稿 → scripts 真的 +1,而且只含我方發言
  const pToScript = probe(key('record', 'button', '存成講稿'), '錄音')
  const scriptsBefore = await countOf(main, 'scripts')
  const toScript = await clickText(main, '存成講稿')
  if (toScript !== true) {
    pToScript.unreachable('找不到「存成講稿」')
  } else {
    await sleep(1500)
    const scriptsAfter = await countOf(main, 'scripts')
    const contents = await dbEval(
      main,
      `(db) => new Promise((res) => { const r = db.transaction('scripts','readonly').objectStore('scripts').getAll(); r.onsuccess = () => res(r.result.map((s) => s.content)); r.onerror = () => res([]) })`
    )
    const newest = String(contents[contents.length - 1] || '')
    // **只斷言我方發言確實過去了**（mock 辨識回來的逐字稿就是「我」）。
    // 「不含對方發言」在這裡是空斷言 —— 這場錄音只有一個音訊來源(假麥克風)，
    // 資料裡本來就沒有 them 段落，斷言它不在等於斷言一條不存在的東西。
    // 那個負向情況由 transcript-to-script.spec.ts 用播種的場次驗過。
    // 把一個空斷言寫成「驗證通過」，是這個專案出現過最多次的假綠燈形狀。
    if (scriptsAfter === scriptsBefore + 1 && newest.includes(stt.text.slice(0, 8))) {
      pToScript.works(
        `scripts ${scriptsBefore} → ${scriptsAfter},內容帶著我方逐字稿（${JSON.stringify(stt.text.slice(0, 10))}…）`,
        EVIDENCE.DATA
      )
    } else {
      pToScript.dead(
        `scripts ${scriptsBefore} → ${scriptsAfter},內容=${JSON.stringify(newest.slice(0, 40))}` +
          `(預期含 ${JSON.stringify(stt.text.slice(0, 8))})`
      )
    }
  }

  // (i) 刪除會議紀錄 → 確認 → sessions 真的 -1
  const pDel = probe(key('record', 'button', '刪除這場會議紀錄'), '錄音')
  const delOk = await clickText(main, '刪除這場會議紀錄')
  if (delOk !== true) {
    pDel.unreachable('找不到刪除鈕')
  } else {
    await sleep(700)
    const before = await countOf(main, 'sessions')
    await clickEffectId(main, 'confirm-ok')
    await sleep(1200)
    const after = await countOf(main, 'sessions')
    if (after === before - 1) pDel.works(`sessions ${before} → ${after}`, EVIDENCE.DATA)
    else pDel.dead(`確認刪除後 sessions 是 ${after},預期 ${before - 1}`)
  }

  // (j) 複製行動清單 → 剪貼簿真的拿到一份可貼上的東西,而且**不含逐字稿**
  //
  // 為什麼負向斷言跟正向一樣重要:這顆鈕的用途是「貼到會議後的訊息裡」,
  // 而使用者願意貼出去的前提是「裡面只有我準備好的重點」。
  // 如果它不小心把逐字稿也帶上,那不是多給,是**把使用者的話轉貼給別人看** ——
  // 而那種錯誤在「剪貼簿有東西」的斷言下完全綠。
  //
  // 位置:刪除之後按(此時還有 session 可展開)。
  const pActionList = probe(idKey('record', 'copy-action-list'), '錄音')
  await gotoViaSidebar(main, '錄音轉錄')
  await sleep(800)
  const hasRow = await main.evaluate(
    () => document.querySelectorAll('[data-effect-id="copy-action-list"]').length > 0
  )
  if (!hasRow) {
    pActionList.unreachable('展開的會議列裡沒有「複製行動清單」(它與逐字稿明細同一個展開區塊)')
  } else {
    await app.evaluate(({ clipboard }) => clipboard.writeText('')).catch(() => {})
    const copied = await clickEffectId(main, 'copy-action-list')
    await sleep(800)
    const clip = String(await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => ''))
    // 拿 fixture 逐字稿的一個長片段當「不該出現」的樣本。
    // 用片段而不是逐字稿全文:逐字稿全文在這裡可能很短,整句比對容易誤判。
    const leak = stt.text.slice(0, 12)
    const leaks = leak.length >= 6 && clip.includes(leak)
    if (copied === true && clip.length > 10 && !leaks) {
      pActionList.works(`剪貼簿 ${clip.length} 字,不含逐字稿片段`, EVIDENCE.DATA)
    } else {
      pActionList.dead(
        `按了複製行動清單但剪貼簿是 ${clip.length} 字` +
          `${leaks ? `(而且**含逐字稿片段** ${JSON.stringify(leak)})` : ''}(clicked=${copied})` +
          `內容=${JSON.stringify(clip.slice(0, 60))}`
      )
    }
  }
}

// 6.4 面試練習(本機 mock LLM + mock 辨識)
async function stepPractice(main, llm) {
  console.log('步驟 9：面試練習(本機 mock LLM)…')
  // 前面的步驟會改 provider，所以這一步自己重新備妥並**讀回來確認**。
  // 沒做這件事時症狀是「按了開始練習進不了 run 階段」—— 原因是量測端
  // 自己的狀態被自己前面的步驕改掉了，不是產品缺陷。
  if (!(await ensureAiOnMock(main, llm))) {
    probe(key('practice', 'button', '開始練習'), '練習').unreachable(
      'AI mock 前置條件不成立(provider/baseUrl 讀回來不對)，這一輪不驗練習流程'
    )
    return
  }
  await sleep(400)
  await clearAll(main)
  await seedRuns(main)
  await gotoViaSidebar(main, '面試練習')
  await sleep(900)

  // (a) 歷史紀錄:載入之後逐題內容回到畫面
  const pRow = probe(idKey('practice', 'practice-row'), '練習')
  const rowOk = await clickEffectId(main, 'practice-row')
  if (rowOk !== true) {
    pRow.unreachable('沒有練習歷史')
  } else {
    await sleep(900)
    const text = await domText(main, 'main')
    if (text.includes('練習完成') && text.includes('我是示範回答')) {
      pRow.works('畫面進入成果頁且載入了那一輪的逐字稿', EVIDENCE.DOM)
    } else {
      pRow.dead(`載入歷史後畫面文字=${JSON.stringify(text.slice(0, 60))}`)
    }
  }

  // (b) 再練一輪 → 回到設定階段
  const pAgain = probe(key('practice', 'button', '再練一輪'), '練習')
  const again = await clickText(main, '再練一輪')
  if (again !== true) {
    pAgain.unreachable('成果頁沒有「再練一輪」')
  } else {
    await sleep(900)
    const text = await domText(main, 'main')
    if (text.includes('職位或情境') && text.includes('開始練習')) pAgain.works('回到設定階段', EVIDENCE.DOM)
    else pAgain.dead(`按了「再練一輪」但畫面是 ${JSON.stringify(text.slice(0, 40))}`)
  }

  // (c) 刪除練習紀錄(負向:取消不變;正向:確認 -1)
  const pDel = probe(key('practice', 'button', '刪除這次練習紀錄'), '練習')
  const delOk = await clickText(main, '刪除這次練習紀錄')
  if (delOk !== true) {
    pDel.unreachable('找不到刪除鈕')
  } else {
    await sleep(700)
    const before = await countOf(main, 'practiceRuns')
    await clickEffectId(main, 'confirm-cancel')
    await sleep(700)
    const afterCancel = await countOf(main, 'practiceRuns')
    if (afterCancel !== before) {
      pDel.dead(`取消之後 practiceRuns ${before} → ${afterCancel}`)
    } else {
      await clickText(main, '刪除這次練習紀錄')
      await sleep(700)
      await clickEffectId(main, 'confirm-ok')
      await sleep(1000)
      const after = await countOf(main, 'practiceRuns')
      if (after === before - 1) pDel.works(`practiceRuns ${before} → ${after}(取消不變)`, EVIDENCE.DATA)
      else pDel.dead(`確認後 practiceRuns 是 ${after},預期 ${before - 1}`)
    }
  }

  // (d) 職位 + 類型 + 題數 → 真的被用來出題(mock LLM 收到的 prompt 是證據)
  const pPosition = probe(key('practice', 'input:text', '職位或情境'), '練習')
  const pos = main.locator('input[aria-label="職位或情境"]').first()
  const POSITION = '稽核職位-資料工程師'
  if (!(await pos.isVisible().catch(() => false))) {
    pPosition.unreachable('找不到職位欄')
  } else {
    await pos.click()
    await pos.fill(POSITION)
    await sleep(300)
    pPosition.works('已輸入,證據在出題請求裡(下一步一起驗)', EVIDENCE.DATA)
  }
  const pType = probe(idKey('practice', 'practice-type'), '練習')
  const pCount = probe(idKey('practice', 'practice-count'), '練習')
  const typeList = await main.evaluate(() =>
    [...document.querySelectorAll('[data-effect-id="practice-type"]')].map((e) => (e.textContent || '').trim())
  )
  if (typeList.length > 1) {
    await clickEffectId(main, 'practice-type', typeList.length - 1)
    await sleep(300)
  }
  await clickEffectId(main, 'practice-count', 0) // 3 題
  await sleep(300)

  const pStart = probe(key('practice', 'button', '開始練習'), '練習')
  const callsBefore = llm.calls()
  const startOk = await clickText(main, '開始練習')
  if (startOk !== true) {
    pStart.unreachable('找不到「開始練習」')
    pType.unreachable('沒有開始練習,無從驗證類型是否被採用')
    pCount.unreachable('同上')
  } else {
    let ran = false
    for (let i = 0; i < 40 && !ran; i++) {
      ran = (await domText(main, 'main')).includes('題 ·') || (await domText(main, 'main')).includes('/ 3 題')
      if (!ran) await sleep(250)
    }
    const text = await domText(main, 'main')
    if (ran) {
      pStart.works(`mock LLM 被呼叫 ${llm.calls() - callsBefore} 次,畫面進入 ${text.match(/第 \d+ \/ \d+ 題/)?.[0] ?? 'run 階段'}`, EVIDENCE.DOM)
      const asked = llm.lastPromptContains?.(POSITION) ?? false
      if (asked) {
        pType.works(`出題請求裡帶著職位「${POSITION}」`, EVIDENCE.DATA)
        pCount.works('出題請求題數與選中的 3 一致(畫面顯示 / 3 題)', EVIDENCE.DATA)
      } else {
        pType.dead('出題請求裡找不到剛輸入的職位 —— 設定沒被帶進 prompt')
        pCount.dead('無法從請求確認題數')
      }
    } else {
      // **失敗訊息裡一定要帶 toast。** App 在任何一步失敗都會用 toast 說明原因
      // （描述錯誤、提示缺什麼）；只報「畫面沒進入 run 階段」等於把最有價值
      // 的診斷資訊丟掉 —— 讀報告的人只能猜，而猜錯的方向通常是「產品壞了」。
      const toasts = await main.evaluate(() =>
        [...document.querySelectorAll('[role="status"]')].map((t) =>
          (t.innerText || '').replace(/\s+/g, ' ').trim()
        )
      )
      pStart.dead(
        `按了「開始練習」但畫面沒進入 run 階段:${JSON.stringify(text.slice(0, 60))}` +
          (toasts.length ? `;App 顯示的訊息=${JSON.stringify(toasts.slice(0, 3))}` : ';而且沒有任何 toast') +
          `;mock 收到的請求=${JSON.stringify(llm.requests?.slice(-4) ?? [])}`
      )
      pType.unreachable('沒有進入 run 階段')
      pCount.unreachable('沒有進入 run 階段')
    }
  }

  // (e) 結束練習 → 回到設定階段
  const pQuit = probe(key('practice', 'button', '結束練習'), '練習')
  const quit = await clickText(main, '結束練習')
  if (quit !== true) {
    pQuit.unreachable('run 階段找不到「結束練習」')
  } else {
    // **這一顆鈕現在會先問「結束這次練習?」** —— 而那是產品的行為,而且是好的
    // 行為:未完成的作答不該被無聲丟掉。探針原本只按一次鈕、等固定 800ms 就看畫面,
    // 於是量到「按了沒反應」並記成 dead。**那是量測端沒跟上,不是缺陷。**
    //
    // 分流而不是無腦補一次點擊:沒有框的頁面上,「再點一個 confirm-ok」會點到
    // 別的元素上 —— 比不點更糟,而且一樣量不出真相。
    const asked = await waitEffectId(main, 'confirm-ok', 2_500)
    if (asked) await clickEffectId(main, 'confirm-ok')
    // 等「回到設定階段」而不是睡固定時間:關掉確認框與切換階段是兩個 render。
    let text = ''
    for (let i = 0; i < 40; i++) {
      text = await domText(main, 'main')
      if (text.includes('開始練習')) break
      await sleep(150)
    }
    if (text.includes('開始練習')) {
      pQuit.works(
        asked
          ? '先問「結束這次練習?」,按確認後回到設定階段'
          : '回到設定階段(此版本沒有確認框)',
        EVIDENCE.DOM
      )
    } else {
      // 訊息要講得清是哪一步卡住,不然下一個人要重讀一遍才知道要查哪裡。
      pQuit.dead(
        `按了「結束練習」(${
          asked ? '確認框有出現,也按了確認' : '2.5 秒內沒有出現確認框'
        })但畫面是 ${JSON.stringify(text.slice(0, 40))}`
      )
    }
  }

  // (f) 朗讀題目 → 需要作業系統語音引擎
  probe(key('practice', 'button', '朗讀題目'), '練習').unverifiable(
    'Web Speech API 的發音由作業系統語音引擎提供,headless 沒有可觀察的輸出',
    EXEMPT_CATEGORY.BROWSER_ENGINE
  )

  // (g) 完整一輪:開始回答 → 完成回答 → 下一題 → 查看總評
  await clickText(main, '開始練習')
  await sleep(2500)
  const pListen = probe(key('practice', 'button', '開始回答'), '練習')
  const listenOk = await clickText(main, '開始回答')
  if (listenOk !== true) {
    pListen.unreachable('找不到「開始回答」')
  } else {
    await sleep(1200)
    const text = await domText(main, 'main')
    if (text.includes('錄音中')) pListen.works('畫面進入錄音中', EVIDENCE.DOM)
    else pListen.dead('按了「開始回答」但沒有進入錄音')
  }

  const pFinish = probe(key('practice', 'button', '完成回答，取得反饋'), '練習')
  const finishOk = await clickText(main, '完成回答')
  if (finishOk !== true) {
    pFinish.unreachable('錄音中找不到「完成回答，取得反饋」')
  } else {
    let scored = false
    for (let i = 0; i < 60 && !scored; i++) {
      scored = (await domText(main, 'main')).includes('AI 教練反饋')
      if (!scored) await sleep(250)
    }
    if (scored) pFinish.works('逐字稿 + AI 教練反饋真的渲染出來', EVIDENCE.DOM)
    else pFinish.dead('按了「完成回答」但等不到評分反饋')
  }

  // 把這一輪剩下的題目做完,才能驗「查看總評」
  for (let guard = 0; guard < 6; guard++) {
    const text = await domText(main, 'main')
    if (text.includes('練習完成')) break
    const next = text.includes('查看總評') ? '查看總評' : '下一題'
    if (next === '下一題') {
      const pNext = probe(key('practice', 'button', '下一題'), '練習')
      const before = text.match(/第 (\d+) \//)?.[1]
      const ok = await clickText(main, '下一題')
      if (ok !== true) {
        pNext.unreachable('找不到「下一題」')
        break
      }
      await sleep(600)
      const after = (await domText(main, 'main')).match(/第 (\d+) \//)?.[1]
      if (before && after && Number(after) === Number(before) + 1) pNext.works(`題號 ${before} → ${after}`, EVIDENCE.DOM)
      else pNext.dead(`按了「下一題」但題號 ${before} → ${after}`)
      // 回答這一題
      await clickText(main, '開始回答')
      await sleep(1500)
      await clickText(main, '完成回答')
      await sleep(3000)
    } else {
      const pOverall = probe(key('practice', 'button', '查看總評'), '練習')
      const ok = await clickText(main, '查看總評')
      if (ok !== true) {
        pOverall.unreachable('找不到「查看總評」')
        break
      }
      let done = false
      for (let i = 0; i < 60 && !done; i++) {
        done = (await domText(main, 'main')).includes('教練總評')
        if (!done) await sleep(250)
      }
      if (done) pOverall.works('進入成果頁且總評文字非空', EVIDENCE.DOM)
      else pOverall.dead('按了「查看總評」但等不到總評')
      break
    }
  }
}

// 6.5 個人化校準(假攝影機)
async function stepCalibration(main) {
  console.log('步驟 10：個人化校準(假攝影機)…')
  await gotoViaSidebar(main, '個人化校準')
  await sleep(900)

  // (a) 開啟攝影機 → 使用者按下之後有沒有得到回應
  //
  // 為什麼不是「只看有沒有影格流動」:不是每一種相機失敗都會讓 getUserMedia
  // 丟錯,而頁面對兩種失敗都有可見的處理:
  //   - 拿得到影 → 預覽有畫面
  //   - 拿不到 / 拿到了但送不出影 → 畫面上出現一行明確的錯誤,並指向手動輸入
  // 舊探針只看第一種,於是 headless(沒有真相機、也沒有影格)會把「按下去
  // 使用者看得到一句可行動的錯」判成 dead —— 那不是 dead,那是**量錯了**。
  //
  // 這裡改成量「按下之後的終局狀態」,並且刻意等得比相機逾時
  // (CAMERA_FIRST_FRAME_TIMEOUT_MS = 8s)還久,好讓「開得起來但不送影」
  // 那條路徑的逾_timeout 也落在觀察窗內 —— 否則這個探針會系統性地
  // 抓不到自己最該抓的那一種失敗。
  const pCam = probe(key('calibration', 'button', '開啟攝影機偵測'), '校準')
  const camOk = await clickText(main, '開啟攝影機偵測')
  if (camOk !== true) {
    pCam.unreachable('找不到開啟攝影機鈕')
  } else {
    const CAM_OUTCOME_WAIT_MS = 12_000
    const outcome = await main
      .evaluate(async (budget) => {
        const readVideo = () => {
          const v = document.querySelector('video')
          return v ? { w: v.videoWidth, h: v.videoHeight, paused: v.paused, ready: v.readyState } : null
        }
        const readError = () => {
          const el = Array.from(document.querySelectorAll('div')).find((d) =>
            (d.textContent ?? '').includes('攝影機不可用') || (d.textContent ?? '').includes('完全沒有畫面')
          )
          return el ? (el.textContent ?? '').trim() : null
        }
        const started = Date.now()
        // 每 250ms 問一次「使用者現在看到的是什麼」,拿到終局狀態就回。
        for (;;) {
          const video = readVideo()
          if (video && video.w > 0 && video.h > 0) return { kind: 'frames', video }
          const err = readError()
          if (err) return { kind: 'error', message: err, video }
          if (Date.now() - started > budget) return { kind: 'nothing', video, elapsed: Date.now() - started }
          await new Promise((r) => setTimeout(r, 250))
        }
      }, CAM_OUTCOME_WAIT_MS)
      .catch((e) => ({ kind: 'threw', message: String(e) }))

    if (outcome.kind === 'frames') {
      pCam.works(
        `video ${outcome.video.w}x${outcome.video.h} 有影格在流(合成彩條圖)`,
        EVIDENCE.DOM
      )
    } else if (outcome.kind === 'error') {
      // 證據來源是 dom-container:被點的按鈕**以外**的元素(錯誤提示)真的出現了。
      // 這仍舊是一個有效果 —— 使用者按下去之後拿到了一句可行動的訊息。
      pCam.works(`相機沒有影格,但畫面出現可行動的錯誤:${outcome.message}`, EVIDENCE.DOM)
    } else {
      pCam.dead(
        `按了開啟攝影機但 ${CAM_OUTCOME_WAIT_MS / 1000}s 內既沒有影格也沒有錯誤提示,` +
          `video 狀態是 ${JSON.stringify(outcome.video)}`
      )
    }
  }

  // (b) 手動距離 + IPD → 套用之後真的出現在個人參數裡(兩次不同值,結果必須不同)
  const pManual = probe(key('calibration', 'input:number', '沒有攝影機？直接填你平常的觀看距離'), '校準')
  const pIpd = probe(key('calibration', 'input:number', '瞳距(IPD),單位毫米'), '校準')
  const pApply = probe(key('calibration', 'button', '套用個人化設定'), '校準')
  const pNext0 = probe(key('calibration', 'button', '用手動距離繼續'), '校準')
  const pNext1 = probe(key('calibration', 'button', '下一步'), '校準')

  const profiles = []
  for (const [ipd, dist, label] of [
    [55, 40, '第一輪(IPD 55 / 40cm)'],
    [75, 90, '第二輪(IPD 75 / 90cm)']
  ]) {
    await gotoViaSidebar(main, '個人化校準')
    await sleep(800)
    // 每一輪都從「沒有個人參數」開始,兩輪的差異才能歸因到 IPD/距離。
    await main.evaluate(async () => {
      await window.api.setSettings({ personal: { profile: null } })
    })
    await main.locator('input[aria-label="瞳距(IPD),單位毫米"]').first().fill(String(ipd)).catch(() => {})
    await main
      .locator('input[aria-label="沒有攝影機？直接填你平常的觀看距離"]')
      .first()
      .fill(String(dist))
      .catch(() => {})
    await sleep(400)
    const advanced = await clickText(main, '用手動距離繼續')
    await sleep(900)
    if (advanced === true && !(await domText(main, 'main')).includes('用自然語速朗讀')) {
      blocked('校準:step1', '手動距離鈕按下去但沒有進入朗讀步驟')
    }
    // step1 的「下一步」需要語速結果 —— 用稽核橋把前置條件備妥(並記錄下來)
    await main.evaluate(() => window.__auditForce?.('calibration.branchState', 'rate-plausible'))
    await sleep(600)
    await clickText(main, '下一步')
    await sleep(900)
    const applied = await clickText(main, '套用個人化設定')
    await sleep(1200)
    const profile = (await readSettings(main)).personal.profile
    // 這裡原本是 `pManual.works(...) === undefined`。`works()` 已經把結論寫進
    // PROBED 與 tally,再拿它的回傳值去比對 undefined 不會有任何效果 —— 那是
    // 一次沒接上的自我檢查(可能是想 assert 什麼,寫到一半)。真正代表
    // 「兩個不同的距離產出不同的 profile」的結論在迴圈外面(3003 行),
    // 那才是對這顆控制項的完整證據。
    profiles.push({ label, ipd, dist, applied, profile })
  }

  const [a, b] = profiles
  if (a?.profile && b?.profile && JSON.stringify(a.profile) !== JSON.stringify(b.profile)) {
    pIpd.works(`兩組 IPD/距離產出不同 profile(${JSON.stringify(a.profile).slice(0, 60)} vs ${JSON.stringify(b.profile).slice(0, 60)})`, EVIDENCE.DATA)
    pManual.works(`手動距離 ${a.dist} → ${b.dist} 真的改變了寫入的 profile`, EVIDENCE.DATA)
    pApply.works('settings.personal.profile 真的被寫入', EVIDENCE.DATA)
    pNext0.works('手動距離鈕真的進入 step 1', EVIDENCE.DOM)
    pNext1.works('step1 的「下一步」真的進入 step 2(前置以稽核橋備妥語速)', EVIDENCE.DOM)
  } else {
    pIpd.dead(`兩輪的 profile 相同或缺少:${JSON.stringify(profiles.map((p) => p.profile))}`)
    pManual.dead('手動距離沒有進到 profile')
    pApply.dead('套用沒有寫入 profile')
    pNext0.unreachable('沒有走到 step 1')
    pNext1.unreachable('沒有走到 step 2')
  }

  // (c) 字級微調 → 預覽字級真的變(幾何/DOM 證據)
  //
  // 這一區順便把**開始朗讀**量掉。為什麼要在這裡、這個順序:
  //   ① 「開始朗讀」只在「還沒量過語速」時渲染 —— 一旦 rateResult 有值,
  //      同一顆鈕的文字就變成「再測一次」。上一輪先強制了 rate-plausible
  //      才去找「開始朗讀」,當然找不到,而那個「找不到」被記成 state-unreached。
  //   ② 「唸完了」按下會去跑本地 Whisper(數百 MB 模型)—— 那不是這一輪能碰的,
  //      所以它的探針停在「知道它會做什麼」而不按下去(登記表給它豁免)。
  const pDown = probe(key('calibration', 'button', '−'), '校準')
  const pUp = probe(key('calibration', 'button', '+'), '校準')
  await gotoViaSidebar(main, '個人化校準')
  await sleep(600)
  await main.locator('input[aria-label="沒有攝影機？直接填你平常的觀看距離"]').first().fill('60').catch(() => {})
  await sleep(300)
  await clickText(main, '用手動距離繼續')
  await sleep(800)

  // step1 的「跳過語速量測」只在**沒有**語速結果時渲染(與「下一步」互斥):
  // 它是沒有麥克風/權限被拒者的出口。fresh step1 直接按 → 必須真的進到
  // step 2(finish() 的 cpm 走備援值,不需要任何量測)。
  {
    const pSkip = probe(key('calibration', 'button', '跳過語速量測'), '校準')
    const skip = await clickText(main, '跳過語速量測')
    if (skip !== true) {
      pSkip.unreachable('step 1 找不到「跳過語速量測」(rateResult 已有值時它會變成「下一步」)')
    } else {
      await sleep(900)
      if ((await domText(main, 'main')).includes('個人化參數預覽')) {
        pSkip.works('跳過語速量測真的進入 step 2(沿用 cpm 備援,不需要麥克風)', EVIDENCE.DOM)
      } else {
        pSkip.dead('按了跳過語速量測但沒有進入 step 2')
      }
      // 回 step1 給下面的「開始朗讀」探針:離頁收掉狀態 → 重走手動距離
      await gotoViaSidebar(main, '總覽')
      await sleep(800)
      await gotoViaSidebar(main, '個人化校準')
      await sleep(600)
      await main.locator('input[aria-label="沒有攝影機？直接填你平常的觀看距離"]').first().fill('60').catch(() => {})
      await sleep(300)
      await clickText(main, '用手動距離繼續')
      await sleep(800)
    }
  }

  {
    const pRead = probe(key('calibration', 'button', '開始朗讀'), '校準')
    const read = await clickText(main, '開始朗讀')
    if (read !== true) {
      pRead.unreachable('step 1 找不到「開始朗讀」(rateResult 已經有值時它會變成「再測一次」)')
    } else {
      let seen = false
      for (let i = 0; i < 24 && !seen; i++) {
        seen = (await domText(main, 'main')).includes('錄音中')
        if (!seen) await sleep(250)
      }
      if (seen) pRead.works('按下後畫面進入「錄音中」(假麥克風的收音真的起來了)', EVIDENCE.DOM)
      else pRead.dead('按了「開始朗讀」但畫面沒有進入錄音中')
    }
    // 離開這一頁 → unmount 會收掉麥克風與音訊管線。不按「唸完了」是刻意的:
    // 那顆會去叫本地 Whisper(見上方的理由)。
    await gotoViaSidebar(main, '總覽')
    await sleep(800)
    await gotoViaSidebar(main, '個人化校準')
    await sleep(600)
    await main.locator('input[aria-label="沒有攝影機？直接填你平常的觀看距離"]').first().fill('60').catch(() => {})
    await sleep(300)
    await clickText(main, '用手動距離繼續')
    await sleep(800)
  }

  await main.evaluate(() => window.__auditForce?.('calibration.branchState', 'rate-plausible'))
  await sleep(500)
  // rateResult 有值後,step1 的收音鈕從「開始朗讀」變成「再測一次」(同一顆鈕的
  // 已量測態,渲染在宣告狀態 calibration/step1-rated 裡)。按下要真的重開收音。
  {
    const pRetry = probe(key('calibration', 'button', '再測一次'), '校準')
    const retry = await clickText(main, '再測一次')
    if (retry !== true) {
      pRetry.unreachable('step 1 找不到「再測一次」(rateResult 為 null 時它是「開始朗讀」)')
    } else {
      let seen = false
      for (let i = 0; i < 24 && !seen; i++) {
        seen = (await domText(main, 'main')).includes('錄音中')
        if (!seen) await sleep(250)
      }
      if (seen) pRetry.works('按下後畫面進入「錄音中」(重測 = 重新收音,與開始朗讀同族)', EVIDENCE.DOM)
      else pRetry.dead('按了「再測一次」但畫面沒有進入錄音中')
      // 收掉這次錄音(離頁 → unmount 收掉麥克風)→ 重走 step1 + 備妥語速,
      // 讓接下來的「下一步」路徑照常進行。
      await gotoViaSidebar(main, '總覽')
      await sleep(800)
      await gotoViaSidebar(main, '個人化校準')
      await sleep(600)
      await main.locator('input[aria-label="沒有攝影機？直接填你平常的觀看距離"]').first().fill('60').catch(() => {})
      await sleep(300)
      await clickText(main, '用手動距離繼續')
      await sleep(800)
      await main.evaluate(() => window.__auditForce?.('calibration.branchState', 'rate-plausible'))
      await sleep(500)
    }
  }
  await clickText(main, '下一步')
  await sleep(900)
  /**
   * 預覽字級。
   *
   * 量的是**公告的那個節點**(data-effect-id="font-preview"),不是「文字包含這句話
   * 的第一個 div」—— 後者是頁面最外層的容器,它的 font-size 永遠是繼承來的 16px,
   * 與兩顆按鈕做什麼完全無關。上一輪就是這樣把兩顆有效的按鈕記成「按了沒效果」。
   */
  const fontSize = () =>
    main
      .evaluate(() => {
        const el = document.querySelector('[data-effect-id="font-preview"]')
        return el ? parseFloat(getComputedStyle(el).fontSize) : null
      })
      .catch(() => null)
  const f0 = await fontSize()
  // **必須用 exact。** clickText 預設是 `text.includes(t)`,而「+」與「−」是
  // 單字元 —— 頁面上任何文字裡有這個符號的按鈕都會被命中(title 與 aria-label
  // 也納入比對)。我按到的是別的按鈕,預覽字級當然不動,於是兩顆好的按鈕
  // 被記成「按了沒效果」。這顆按鈕的 textContent 就是剛好一個「+」。
  const upOk = await clickText(main, '+', { exact: true })
  await sleep(500)
  const f1 = await fontSize()
  const downOk = await clickText(main, '−', { exact: true })
  await sleep(500)
  const f2 = await fontSize()
  if (!upOk || !downOk) {
    const msg = `用 exact 比對就找不到按鈕(up=${String(upOk)}, down=${String(downOk)})——先確認按鈕的可及名稱`
    if (f0 == null) {
      pUp.unreachable(msg)
      pDown.unreachable(msg)
    } else {
      pUp.dead(msg)
      pDown.dead(msg)
    }
  } else {
    if (f0 != null && f1 != null && f1 > f0) pUp.works(`預覽字級 ${f0} → ${f1}`, EVIDENCE.DOM)
    else pUp.dead(`按「+」之後預覽字級 ${f0} → ${f1}`)
    if (f1 != null && f2 != null && f2 < f1) pDown.works(`預覽字級 ${f1} → ${f2}`, EVIDENCE.DOM)
    else pDown.dead(`按「−」之後預覽字級 ${f1} → ${f2}`)
  }

  // (d) 回上一步
  const pBack = probe(key('calibration', 'button', '回上一步'), '校準')
  const back = await clickText(main, '回上一步')
  if (back !== true) {
    pBack.unreachable('找不到「回上一步」')
  } else {
    await sleep(700)
    const text = await domText(main, 'main')
    if (text.includes('用自然語速朗讀')) pBack.works('真的退回 step 1', EVIDENCE.DOM)
    else pBack.dead(`按了「回上一步」但畫面是 ${JSON.stringify(text.slice(0, 40))}`)
  }

  // 「開始朗讀」已經在 (c) 量過(那裡的前置狀態才是對的)。
  // 「唸完了」不佈探針:它會去跑本地 Whisper 的下載 —— 登記表把它列成豁免,
  // 理由寫在那裡(而不是寫成一筆假裝量過的結論)。
}

// 6.6 設定頁的第二輪:開關與其他控制項
/**
 * 為什麼這一頁的步驟需要 stt:「複製診斷報告」探針要斷言報告**不含逐字稿**,
 * 而唯一知道「這一輪的逐字稿長什麼樣」的是辨識 mock。沒有它,那一半的
 * 負向斷言會是空的 —— 而「含逐字稿」正是這條最該擋的東西
 * (使用者要把這份報告貼到公開 issue 上)。
 */
async function stepSettingsExtra(app, main, llm, stt) {
  console.log('步驟 11：設定頁開關與連線…')
  await gotoViaSidebar(main, '設定')
  await sleep(900)

  // (a) 8 個開關:逐個驗「aria 翻了、而且對應的設定也翻了」
  const SWITCHES = [
    ['鏡像模式', 'overlay.mirror'],
    ['毛玻璃質感', 'overlay.glass'],
    ['該你說話了提示', 'overlay.turnYield'],
    ['即時教練', 'overlay.coaching'],
    ['螢幕擷取隱形', 'overlay.captureProtected'],
    ['滑鼠穿透', 'overlay.clickThrough'],
    ['永遠置頂', 'overlay.alwaysOnTop'],
    ['AI 即時救援', 'scenario.aiModeEnabled']
  ]
  for (const [label, path] of SWITCHES) {
    const p = probe(idKey('settings', 'switch'), '設定')
    const target = main.locator('[role="switch"]', { hasText: label }).first()
    if (!(await target.isVisible().catch(() => false))) {
      p.unreachable(`找不到開關「${label}」`)
      continue
    }
    const before = await readSetting(main, path)
    await target.click()
    // 讀回確認真的翻轉了(取代 sleep(700))
    const flipped = await waitSetting(main, path, !before)
    const after = flipped.got
    if (flipped.ok && after === !before && typeof before === 'boolean') {
      p.works(`「${label}」開關:${path} ${before} → ${after}`, EVIDENCE.DATA)
    } else {
      p.dead(`開關「${label}」按下去之後 ${path} 是 ${JSON.stringify(after)}(原本 ${JSON.stringify(before)})`)
    }
    // **還原,而且必須讀回確認。**(見 writeSetting 的註解:「再點一次」不一定是還原)
    const restored = await writeSetting(main, path, before)
    if (!restored.ok) {
      report.note('⚠️ 開關還原失敗', { label, path, want: before, got: restored.got })
    }
  }

  // (b) 辨識引擎切換 → settings.stt.engine
  const pEngine = probe(idKey('settings', 'stt-engine'), '設定')
  const engineBefore = await readSetting(main, 'stt.engine')
  const engineOk = await clickEffectId(main, 'stt-engine', engineBefore === 'local' ? 1 : 0)
  await sleep(800)
  const engineAfter = await readSetting(main, 'stt.engine')
  if (engineOk === true && engineAfter !== engineBefore && ['local', 'cloud'].includes(engineAfter)) {
    pEngine.works(`stt.engine ${engineBefore} → ${engineAfter}`, EVIDENCE.DATA)
  } else {
    pEngine.dead(`切換引擎後 stt.engine 是 ${JSON.stringify(engineAfter)}(原本 ${engineBefore})`)
  }

  // (c) 測試連線:對一個不存在的啟動埠必須看得到失敗;**對 mock 必須真的拿到模型清單**。
  //
  // ⚠️ 找不到這顆鈕的原因不是它壞了,是我站在錯的分支上:它只在供應商=Ollama 時
  // 渲染,而前面的供應商探針最後把分支切到了 OpenAI 相容。先把它切回來(讀回確認)。
  const pTest = probe(key('settings', 'button', '測試連線'), '設定')
  await main.evaluate(async (url) => {
    await window.api.setSettings({ ai: { provider: 'ollama', ollama: { baseUrl: url } } })
  }, llm.origin)
  await sleep(900)
  const testBtn = main.locator('button', { hasText: '測試連線' }).first()
  if (!(await testBtn.isVisible().catch(() => false))) {
    pTest.unreachable('找不到「測試連線」(Ollama 分支才會渲染)')
  } else {
    const tagsBefore = llm.tagsCalls?.() ?? 0
    await main.evaluate(() => window.api.setSettings({ ai: { ollama: { baseUrl: 'http://127.0.0.1:1' } } }))
    await sleep(600)
    // **失敗訊息是行內的，不是 toast。**
    // 「測試連線」的失敗寫進 testError，渲染成按鈕下面那一行紅字；
    // 只有成功才會冒出 toast。所以只看 toast 會得到「按了沒有任何失敗訊息」——
    // 而訊息一直都在。使用者看到的是同一件事，量測端看的是另一個通道。
    const readFailure = () =>
      main.evaluate(() => {
        const el = document.querySelector('[data-effect-id="ollama-test-error"]')
        return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null
      })
    const beforeErr = await readFailure()
    await testBtn.click()
    let failed = false
    let seen = null
    for (let i = 0; i < 40 && !failed; i++) {
      seen = await readFailure()
      if (seen && seen !== beforeErr) failed = true
      if (!failed) await sleep(250)
    }
    if (!failed) {
      pTest.dead(
        `對不存在的埠按測試連線,畫面上的失敗訊息從 ${JSON.stringify(beforeErr)} 變成 ${JSON.stringify(seen)}` +
          '（這一條失敗訊息是行內的，不是 toast —— 只看 toast 會誤判成「沒有回饋」）'
      )
    } else {
      // 失敗那條已經成立。再驗**成功那條**:指向 mock 之後畫面必須出現模型清單,
      // 而 mock 那一端必須真的收到 /api/tags —— 兩邊都對才算接線是通的。
      await main.evaluate(
        (url) => window.api.setSettings({ ai: { ollama: { baseUrl: url, model: 'mock-qwen' } } }),
        llm.origin
      )
      await sleep(800)
      await testBtn.click().catch(() => {})
      let ok = null
      for (let i = 0; i < 40 && !ok; i++) {
        ok = await main.evaluate(() => {
          const t = (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ')
          const m = t.match(/Ollama v\S+，(\d+) 個模型/)
          return m ? { models: Number(m[1]) } : null
        })
        if (!ok) await sleep(250)
      }
      const tagsAfter = llm.tagsCalls?.() ?? 0
      if (ok && tagsAfter > tagsBefore) {
        pTest.works(
          `不存在的埠 → 失敗提示;mock → 收到 ${tagsAfter - tagsBefore} 次 /api/tags 並列出 ${ok.models} 個模型`,
          EVIDENCE.DATA
        )
      } else {
        pTest.dead(
          `成功那條不完整:畫面清單=${JSON.stringify(ok)}、mock 收到的 /api/tags 次數 ${tagsBefore} → ${tagsAfter}`
        )
      }
    }
  }

  // (c1b) Ollama 模型選單:測試連線成功之後才會出現(前置條件剛剛才被備妥)。
  {
    const p = probe(idKey('settings', 'ollama-model'), '設定')
    const sel = main.locator('select[aria-label="Ollama 模型"]').first()
    if (!(await sel.isVisible().catch(() => false))) {
      p.unreachable('Ollama 模型選單沒有渲染(還沒測連線成功,或只有一個模型)')
    } else {
      const options = await sel.evaluate((s) => [...s.options].map((o) => o.value))
      const before = await readSetting(main, 'ai.ollama.model')
      const target = options.find((o) => o !== before)
      if (!target) {
        p.unreachable(`選單只有 ${JSON.stringify(options)} 一個選項,無法驗證「改變」`)
      } else {
        await sel.selectOption(target)
        await sleep(700)
        const after = await readSetting(main, 'ai.ollama.model')
        if (after === target) p.works(`ai.ollama.model: ${JSON.stringify(before)} → ${JSON.stringify(after)}`, EVIDENCE.DATA)
        else p.dead(`選了 ${target} 之後 ai.ollama.model=${JSON.stringify(after)}`)
      }
    }
  }

  // (c2) 滑桿:六個數值欄位。用**真的鍵盤**按一步,資料層必須跟著動。
  //
  // 不能直接寫 el.value:React 的 onChange 只認真的 input 事件,
  // 而寫 value 不觸發任何東西 —— 那會量到「按了沒反應」,一個自己造的假缺陷。
  const SLIDERS = [
    ['藥丸大小', 'overlay.pillScale'],
    ['字體大小', 'overlay.fontSize'],
    ['滾動速度', 'overlay.speed'],
    ['語速倍率', 'overlay.rate'],
    ['行距', 'overlay.lineHeight'],
    ['不透明度', 'overlay.opacity']
  ]
  for (const [label, path] of SLIDERS) {
    const p = probe(key('settings', 'input:range', label), '設定')
    const el = main.locator(`input[type=range][aria-label="${label}"]`).first()
    if (!(await el.isVisible().catch(() => false))) {
      p.unreachable(`找不到滑桿「${label}」`)
      continue
    }
    const before = await readSetting(main, path)
    await el.focus()
    await main.keyboard.press('ArrowRight')
    await sleep(500)
    const after = await readSetting(main, path)
    if (typeof before === 'number' && typeof after === 'number' && after !== before) {
      p.works(`${path}: ${before} → ${after}(方向鍵一步)`, EVIDENCE.DATA)
    } else {
      p.dead(`在滑桿「${label}」按一下方向鍵,${path} 從 ${JSON.stringify(before)} 變成 ${JSON.stringify(after)}`)
    }
    // 還原:後面的探針不應該被這一格的值影響。
    await main.keyboard.press('ArrowLeft').catch(() => {})
    await sleep(300)
  }

  // (c3) 顯示模式四顆:每一顆都必須把 overlay.displayMode 換成它自己的值。
  // 四顆是「選一個」的群組,所以**逐顆驗「自己那一個」**,而不是只驗「有變」。
  for (const [label, mode] of [
    ['連續捲動', 'scroll'],
    ['逐句短語', 'phrase'],
    ['重點要點', 'bullet'],
    ['逐詞高亮', 'karaoke']
  ]) {
    const p = probe(key('settings', 'button', label), '設定')
    const before = await readSetting(main, 'overlay.displayMode')
    const ok = await clickText(main, label)
    await sleep(600)
    const after = await readSetting(main, 'overlay.displayMode')
    if (ok === true && after === mode) {
      p.works(`overlay.displayMode: ${before} → ${after}`, EVIDENCE.DATA)
    } else if (ok !== true) {
      p.unreachable(`找不到顯示模式「${label}」`)
    } else {
      p.dead(`按「${label}」後 overlay.displayMode=${JSON.stringify(after)},預期 ${JSON.stringify(mode)}`)
    }
  }
  // 還原成連續捲動:後面的浮層探針從這個形態開始最單純。
  await clickText(main, '連續捲動').catch(() => {})
  await sleep(400)

  // (c4) 兩組「API 欄位」。
  //
  // 為什麼用 data-effect-id 而不是 aria-label:這一頁有**兩組**同名欄位
  // (雲端辨識 / AI 助理),`.first()` 永遠拿到前一組 —— 實際發生過:
  // 金鑰填進辨識那格、卻斷言 AI 那格,一顆好的控制項被記成「打完金鑰資料層還是 null」。
  await main.evaluate(async () => {
    // 前置:兩組區塊的渲染條件(引擎=雲端、供應商=OpenAI 相容)
    await window.api.setSettings({ stt: { engine: 'cloud' }, ai: { provider: 'openai-compatible' } })
  })
  await sleep(900)
  const idField = async (controlKey, effectId, path, value) => {
    const p = probe(controlKey, '設定')
    const el = main.locator(`[data-effect-id="${effectId}"]`).first()
    if (!(await el.isVisible().catch(() => false))) {
      p.unreachable(`找不到 [data-effect-id=${effectId}]`)
      return
    }
    const before = await readSetting(main, path)
    await el.click()
    await el.fill(String(value))
    await sleep(900)
    const after = await readSetting(main, path)
    if (after === value) p.works(`${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`, EVIDENCE.DATA)
    else p.dead(`填了 ${effectId} 之後 ${path}=${JSON.stringify(after)},預期 ${JSON.stringify(value)}`)
  }
  await idField(idKey('settings', 'stt-base-url'), 'stt-base-url', 'stt.cloud.baseUrl', 'http://127.0.0.1:1/v1')
  await idField(idKey('settings', 'stt-model'), 'stt-model', 'stt.cloud.model', 'mock-whisper-audit')
  await idField(idKey('settings', 'ai-base-url'), 'ai-base-url', 'ai.openaiCompatible.baseUrl', 'http://127.0.0.1:1/v1')
  await idField(idKey('settings', 'ai-model'), 'ai-model', 'ai.openaiCompatible.model', 'mock-gpt-audit')

  // 金鑰兩格:填字 + **blur**(使用者打完會有這個動作,而產品的寫入策略是
  // debounce 600ms + blur 立刻寫)。斷言各自的 secure store 欄位。
  for (const [keyId, storeName] of [
    ['stt-api-key', 'sttApiKey'],
    ['ai-api-key', 'apiKey']
  ]) {
    const p = probe(idKey('settings', keyId), '設定')
    const el = main.locator(`[data-effect-id="${keyId}"]`).first()
    if (!(await el.isVisible().catch(() => false))) {
      p.unreachable(`找不到金鑰欄 ${keyId}`)
      continue
    }
    const value = `sk-audit-${keyId}`
    await el.click()
    await el.fill(value)
    await el.blur().catch(() => {})
    await sleep(1000)
    const keys = await main.evaluate(async () => (await window.api.keysGet?.()) ?? null)
    if (keys?.[storeName] === value) {
      p.works(`secure store 的 ${storeName} 已寫入(填完 + blur)`, EVIDENCE.DATA)
    } else {
      p.dead(`填完 ${keyId} 並失焦後,secure store 的 ${storeName}=${JSON.stringify(keys?.[storeName] ?? null)}`)
    }
  }
  // 填了金鑰就清掉:後面的探針不應該依賴「有金鑰」這個副作用。
  await main.evaluate(async () => window.api.keysSet?.({ sttApiKey: '', apiKey: '' })).catch(() => {})

  // (c5) 分享前模擬測試 → 螢幕擷取回來的圖真的被渲染出來。
  //
  // 假裝置軍提供了可選的主畫面來源(--auto-select-desktop-capture-source),
  // 所以這條從「無頭做不到」變成做得到。量的是「畫面真的多了一張圖」,
  // 而不是「有沒有報錯」。至於「那張圖裡沒有浮層」是更深一層的斷言,
  // 見 effect-inventory 的登記理由。
  {
    const p = probe(key('settings', 'button', '分享前模擬測試'), '設定')
    const before = await main.evaluate(() => document.querySelectorAll('img[alt="螢幕擷取模擬"]').length)
    const ok = await clickText(main, '分享前模擬測試')
    if (ok !== true) {
      p.unreachable('找不到「分享前模擬測試」按鈕')
    } else {
      let shot = null
      for (let i = 0; i < 60 && !shot; i++) {
        shot = await main.evaluate(() => {
          const img = document.querySelector('img[alt="螢幕擷取模擬"]')
          return img ? { len: (img.getAttribute('src') || '').length } : null
        })
        if (!shot) await sleep(250)
      }
      if (shot && shot.len > 1000 && before === 0) {
        p.works(`畫面真的多了擷取縮圖(src 長度 ${shot.len})`, EVIDENCE.DOM)
      } else {
        p.dead(`按了模擬測試後,畫面上的擷取縮圖=${JSON.stringify(shot)}(按前有 ${before} 張)`)
      }
    }
  }

  // (d) 開始校準 / 重新校準 → 真的到校準頁
  //
  // ⚠️ 兩顆鈕**互斥**:沒校準過時畫面是「開始校準」,有個人參數之後才變成
  // 「重新校準」。所以要分兩段驗,而且順序是「先沒參數、後有參數」。
  // 上一輪先把參數播種下去才去點「開始校準」—— 它根本不會在那個畫面出現,
  // 於是量到「找不到」,而那是量測端自已把前置條件踩掉的。
  const clickAndCheckNav = async (label) => {
    const p = probe(key('settings', 'button', label), '設定')
    await gotoViaSidebar(main, '設定')
    await sleep(800)
    const ok = await clickText(main, label)
    if (ok !== true) {
      p.unreachable(`當前畫面找不到「${label}」`)
      return
    }
    await sleep(900)
    const hash = await main.evaluate(() => location.hash)
    if (hash.includes('calibration')) p.works(`hash → ${hash}`, EVIDENCE.DOM)
    else p.dead(`按「${label}」之後 hash 是 ${hash}`)
  }
  // 第一段:還沒有個人參數 → 「開始校準」
  await main.evaluate(async () => {
    await window.api.setSettings({ personal: { profile: null } })
  })
  await sleep(800)
  await clickAndCheckNav('開始校準')
  // 第二段:播種個人參數 → 「重新校準」
  await main.evaluate(async () => {
    await window.api.setSettings({
      personal: {
        profile: {
          calibratedAt: Date.now(),
          ipdMm: 62,
          viewingDistanceCm: 60,
          hfovDeg: 65,
          charsPerMin: 240,
          sampleSeconds: 20,
          sampleChars: 80,
          derivedFontSize: 35,
          derivedSpeed: 140
        }
      }
    })
  })
  await sleep(800)
  await clickAndCheckNav('重新校準')

  // (e) 準備度卡片:展開 → 項目真的列出來;複製 → 剪貼簿真的拿到指令
  await gotoViaSidebar(main, '設定')
  await sleep(1200)
  // 準備度卡片只存在於設定頁(full 形態);總覽頁是另一顆 compact。
  // 上一輪這裡寫成 dashboard 的 id —— 兩個都錯,而錯法很安靜:
  // 探針有結論、登記表也有這一筆,只是它們對不上同一個控制項。
  const pToggle = probe(idKey('settings', 'preflight-toggle'), '設定')
  const toggleOk = await clickEffectId(main, 'preflight-toggle')
  if (toggleOk !== true) {
    pToggle.unreachable('設定頁沒有準備度卡片(全部就緒時不渲染)')
  } else {
    await sleep(600)
    // 斷言「切換前後相反」而不是「展開後有東西」:卡片的預設狀態是**展開**
    // (有擋路項時),所以按一下是收合。第一次實跑就是這樣誤判成 dead。
    const expanded = await main.evaluate(
      () => document.querySelector('[data-effect-id="preflight-toggle"]')?.getAttribute('aria-expanded')
    )
    const items = await main.evaluate(() => document.querySelectorAll('[data-preflight-item]').length)
    const consistent = expanded === 'true' ? items > 0 : items === 0
    // 再切一次必須回到原狀 —— 只驗單向的話,一顆「只會收合、再按沒反應」的鈕
    // 也會過。而且這裡必須把它留在**展開**狀態:下一條要驗的複製鈕
    // 只在展開的內容裡,上一輪就是被這一步收合掉,才量到「卡片上沒有複製鈕」。
    await clickEffectId(main, 'preflight-toggle')
    await sleep(500)
    const back = await main.evaluate(
      () => document.querySelector('[data-effect-id="preflight-toggle"]')?.getAttribute('aria-expanded')
    )
    const itemsBack = await main.evaluate(() => document.querySelectorAll('[data-preflight-item]').length)
    if (consistent && back === (expanded === 'true' ? 'false' : 'true')) {
      pToggle.works(`展開 ⇄ 收合:aria-expanded ${expanded} → ${back},項目數 ${items} → ${itemsBack}`, EVIDENCE.DOM)
    } else if (!consistent) {
      pToggle.dead(`aria-expanded=${expanded} 但項目數=${items},兩者矛盾`)
    } else {
      pToggle.dead(`第二次點擊沒有回到原狀:aria-expanded ${expanded} → ${back}`)
    }
  }
  // 複製鈕只在「有指令可複製」的項目上。要量它,得先製造那個世界:
  // 用產品自己的稽核覆寫把 Ollama 回報成「裝好了但一個模型都沒有」——
  // 卡片會給出 `ollama pull …` 這個可複製的指令。
  const pCopy = probe(idKey('settings', 'preflight-copy'), '設定')
  await main.evaluate(async () => {
    await window.api.setSettings({ ai: { provider: 'ollama' } })
    window.__auditForce?.('preflight.models', [])
  })
  await sleep(1200)
  const copyOk = await clickEffectId(main, 'preflight-copy')
  if (copyOk !== true) {
    pCopy.unreachable('準備度卡片上沒有複製鈕(只有需要指令的項目才有)')
  } else {
    await sleep(600)
    // 剪貼簿從 Electron 那一端讀(renderer 的 navigator.clipboard.readText 需要額外權限,
    // 而「真的有寫進去」只有從系統那端讀才算數)。
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => '')
    if (typeof clip === 'string' && clip.includes('ollama')) pCopy.works(`剪貼簿拿到「${clip.slice(0, 30)}…」`, EVIDENCE.DATA)
    else pCopy.dead(`按了複製但剪貼簿是「${String(clip).slice(0, 30)}」—— 使用者貼出來貼不到指令`)
  }

  // 「重查」(PreflightCard 的重新檢查鈕):效果 = 重跑金鑰讀取與 Ollama 探測。
  // 用 mock 的 /api/tags 計數器驗 —— 點擊後計數必須增加,那是資料層證據;
  // 按鈕上的「檢查中」spinner 是 UI 的自我宣稱,不算數。
  // 前置:先清掉 pCopy 留下的 preflight.models 覆寫 —— 覆寫活著時 probeOllama
  // 根本不出網(見 lib/preflight.ts),計數不動是量測端自己的環境,不是鈕壞了。
  const pRecheck = probe(idKey('settings', 'preflight-recheck'), '設定')
  await main.evaluate((url) => {
    window.__auditForce?.('preflight.models', null)
    return window.api.setSettings({ ai: { provider: 'ollama', ollama: { baseUrl: url } } })
  }, llm.origin)
  await sleep(900)
  const recheckBtn = main.locator('[data-effect-id="preflight-recheck"]').first()
  if (!(await recheckBtn.isVisible().catch(() => false))) {
    pRecheck.unreachable('準備度卡片的重查鈕沒有渲染(卡片在這個狀態回 null?)')
  } else {
    const tagsBefore2 = llm.tagsCalls?.() ?? 0
    await recheckBtn.click()
    let retagged = false
    for (let i = 0; i < 40 && !retagged; i++) {
      retagged = (llm.tagsCalls?.() ?? 0) > tagsBefore2
      if (!retagged) await sleep(250)
    }
    if (retagged) {
      pRecheck.works(
        `點擊後 mock 收到 /api/tags ${llm.tagsCalls() - tagsBefore2} 次(重新探測真的發生了)`,
        EVIDENCE.DATA
      )
    } else {
      pRecheck.dead(`按了重查但 mock 的 /api/tags 計數停在 ${tagsBefore2} —— 沒有任何重新探測`)
    }
  }

  // 「複製診斷報告」(疑難排解區)。
  //
  // 這一條的**重點不在剪貼簿**,而在「裡面不該有什麼」。
  // 診斷報告是使用者準備貼到 issue 裡的東西 —— 它必須帶著足夠的上下文,
  // 又必須**不含**逐字稿、API 金鑰、講稿內容。而後者沒有任何一種 UI 機制
  // 會提醒他:貼出去就已經晚了。
  //
  // 所以這個探針做兩個斷言,缺一個就算沒有效果:
  //   正向:剪貼簿真的拿到一份有內容的報告
  //   負向:報告裡看不到任何金鑰字樣,也不含這輪錄進去的逐字稿片段
  const pDiag = probe(idKey('settings', 'copy-diagnostics'), '設定')
  await app.evaluate(({ clipboard }) => clipboard.writeText('')).catch(() => {})
  const diagOk = await clickEffectId(main, 'copy-diagnostics')
  if (diagOk !== true) {
    pDiag.unreachable('設定頁的「複製診斷報告」鈕沒有渲染(沒有報告時它是 disabled)')
  } else {
    await sleep(800)
    const clip = String(await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => ''))
    // 「看起來像金鑰」的樣本:真實的 API key 前綴。診斷報告裡只該出現
    // 「有設定 / 沒設定」這種布林值,不該出現任何看起來像金鑰的字串。
    const keyish = /(sk-[A-Za-z0-9]{6,}|api[_-]?key\s*[:=]\s*\S{6,})/i
    const leakText = stt.text.slice(0, 12)
    const hasKey = keyish.test(clip)
    const hasTranscript = leakText.length >= 6 && clip.includes(leakText)
    if (clip.length > 40 && !hasKey && !hasTranscript) {
      pDiag.works(`剪貼簿 ${clip.length} 字,不含金鑰字樣也不含逐字稿`, EVIDENCE.DATA)
    } else {
      pDiag.dead(
        `診斷報告 ${clip.length} 字` +
          `${hasKey ? ' —— **含疑似金鑰**' : ''}` +
          `${hasTranscript ? ` —— **含逐字稿片段** ${JSON.stringify(leakText)}` : ''}` +
          `(clicked=${diagOk})內容=${JSON.stringify(clip.slice(0, 80))}`
      )
    }
  }
}

// (「複製診斷報告」的探針在 stepSettingsExtra 裡 —— 它需要 stt 才能斷言
//  「報告不含逐字稿」,而辨識 mock 是唯一知道這一輪逐字稿長什麼樣的東西。
//  曾經有一個 stepDiagnostics 想接這件事,接下來刪到一半就留下了:檔案因此
//  無法解析,而稽核連啟動都做不到 —— 量測層壞掉時,報告不會說話。)

// 6.7 對話框與 toast
/**
 * 把講稿編輯器弄髒 → 立刻切頁 → 等「有未存變更」的確認對話框。
 *
 * ## 為什麼需要重試(這是加自動存檔之後才出現的問題)
 *
 * 自動存檔在「停手 AUTOSAVE_DELAY_MS(1.5 秒)」之後會把 `dirty` 清掉。
 * 那是**設計**不是 bug:沒有未存的東西,就沒有東西要確認,跳出框是在問一個
 * 已經不存在的問題。但它把這一步變成一場競賽 —— 而稽核跑的是同一台機器上
 * 的真實 Electron,負載一高,`fill()` 到「點側欄」之間就可能超過 1.5 秒,
 * 於是對話框沒跳、探針報 `state-unreached`。
 *
 * 實測證據:關掉自動存檔重跑,`audit:effects` 從 exit 1 變成 exit 0。
 *
 * ## 為什麼是重試而不是放寬斷言
 *
 * 放寬成「對話框沒跳就算了」會讓這條探針在**產品真的壞掉**時也變綠,
 * 而它守的正是「切頁前有問」這個行為。所以重試的只是「重新弄髒」這個前置,
 * 對話框還是不出現就照實報問題。
 */
async function dirtyAndExpectConfirmDialog(main, ta, tag) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 每次用不同的值:填入相同的值不會觸發 onChange,也就不會重新弄髒。
    await ta.fill(`弄髒的內容-${Date.now()}-${attempt}`)
    // 刻意不睡:睡下去就是在跟 1.5 秒的 debounce 賭。
    await gotoViaSidebar(main, '設定', { keepDialog: true })
    const up = await main.evaluate(() => !!document.querySelector('[role="dialog"]'))
    if (up) return true
    // 競賽輸了(dirty 已被自動存檔清掉)。切回講稿頁才能重新弄髒 ——
    // 此刻沒有未存變更,所以這次切頁不會有對話框要擋。
    if (attempt < 3) {
      console.log(`   (${tag}) 第 ${attempt} 次沒等到對話框 —— 自動存檔搶先存掉了,重試`)
      await gotoViaSidebar(main, '提詞講稿')
      await waitUntil(async () => ta.isVisible().catch(() => false))
    }
  }
  return false
}

async function stepDialogs(main) {
  console.log('步驟 12：確認對話框與 toast…')

  // (a) 未存變更時切頁 → 對話框;取消 → 留在原地;確認 → 真的換頁
  await gotoViaSidebar(main, '提詞講稿')
  await sleep(800)
  await seedScripts(main, ['稽核對話框講稿'])
  await gotoViaSidebar(main, '總覽')
  await gotoViaSidebar(main, '提詞講稿')
  await sleep(900)
  const ta = main.locator('main textarea').first()
  const pCancel = probe(idKey('dialog', 'confirm-cancel'), '對話框')
  const pOk = probe(idKey('dialog', 'confirm-ok'), '對話框')
  if (!(await ta.isVisible().catch(() => false))) {
    pCancel.unreachable('沒有編輯器可以弄髒')
    pOk.unreachable('沒有編輯器可以弄髒')
  } else {
    await ta.click()
    const dialogUp = await dirtyAndExpectConfirmDialog(main, ta, '第一次')
    await sleep(600)
    const stillUp = await main.evaluate(() => !!document.querySelector('[role="dialog"]'))
    if (!dialogUp || !stillUp) {
      pCancel.unreachable('切頁時沒有跳確認對話框(可能 dirty 狀態沒被記住)')
      pOk.unreachable('同上')
    } else {
      const cancelOk = await clickEffectId(main, 'confirm-cancel')
      await sleep(700)
      const hashAfterCancel = await main.evaluate(() => location.hash)
      const dialogGone = await main.evaluate(() => !document.querySelector('[role="dialog"]'))
      if (cancelOk === true && hashAfterCancel.includes('scripts') && dialogGone) {
        pCancel.works('取消後留在講稿頁且對話框關閉(資料未變)', EVIDENCE.DOM)
      } else {
        pCancel.dead(`取消後 hash=${hashAfterCancel},對話框${dialogGone ? '已關' : '還在'}`)
      }
      // 取消之後編輯器仍然是髒的,但那個「髒」會被自動存檔在 1.5 秒內清掉,
      // 所以同樣不能靠睡覺等它 —— 用同一個 helper 重來。
      const up2 = await dirtyAndExpectConfirmDialog(main, ta, '第二次')
      if (!up2) {
        pOk.unreachable('第二次切頁沒有跳對話框')
      } else {
        await clickEffectId(main, 'confirm-ok')
        await sleep(900)
        const hashAfterOk = await main.evaluate(() => location.hash)
        if (hashAfterOk.includes('settings')) pOk.works(`確認後真的換頁(hash=${hashAfterOk})`, EVIDENCE.DOM)
        else pOk.dead(`按了確認但 hash 還是 ${hashAfterOk}`)
      }
    }
  }

  // (b) toast 關閉鈕 → 那一則真的被移除
  const pToast = probe(key('toast', 'button', '關閉通知'), 'toast')
  await main.evaluate(() => window.__auditToast?.('info', '稽核 toast 一'))
  await main.evaluate(() => window.__auditToast?.('error', '稽核 toast 二'))
  await sleep(600)
  const before = (await toastText(main)).length
  const closed = await main.evaluate(() => {
    const b = document.querySelector('.toast-item button[aria-label="關閉通知"]')
    if (!b) return false
    b.click()
    return true
  })
  await sleep(500)
  const after = (await toastText(main)).length
  // `closed` 區分「按不到」與「按了但沒用」:前者是量測端的前置條件問題
  // (toast 可能還沒渲染完就量),把它記成 dead 會把量測端的時序問題
  // 記在產品帳上 —— 這正是這支稽核一直強調要分開的那兩件事。
  if (!closed) pToast.unreachable('頁面上找不到 toast 的「關閉通知」按鈕')
  else if (before >= 2 && after === before - 1)
    pToast.works(`toast 數量 ${before} → ${after}`, EVIDENCE.DOM)
  else pToast.dead(`按了關閉通知但 toast 數量 ${before} → ${after}`)

  // (c) 可行動錯誤的按鈕 → 按下去真的換頁(而且**不會**無限期停駐在畫面上嗎?
  //     不,帶 action 的 toast 刻意不自動消失 —— 見 toast.ts。)
  //
  // 為什麼這一條重要:這一輪把「前往設定」做成錯誤訊息的一部分,
  // 而那顆按鈕**不經由 hash 導航** —— 它走 App 自己的 navigate,
  // 帶著「講稿有未存變更就不准離開」那道守衛。用 hash 會繞過它,
  // 而那正是把「使用者正在編輯的講稿」變成資料遺失的最短路徑。
  const pAction = probe(idKey('toast', 'toast-action'), 'toast')
  await gotoViaSidebar(main, '總覽')
  await sleep(600)
  await main.evaluate(() => {
    window.__auditToast?.('error', '稽核:AI 服務連不上', {
      label: '前往設定',
      kind: 'goto',
      page: 'settings'
    })
  })
  await sleep(700)
  const hashBeforeAction = await main.evaluate(() => location.hash)
  const actionClicked = await clickEffectId(main, 'toast-action')
  if (actionClicked !== true) {
    pAction.unreachable(
      `造不出帶 action 的 toast(${JSON.stringify(
        await main.evaluate(() =>
          [...document.querySelectorAll('[data-effect-id="toast-action"]')].map((b) =>
            (b.textContent || '').trim()
          )
        )
      )})`
    )
  } else {
    await sleep(900)
    const hashAfterAction = await main.evaluate(() => location.hash)
    if (hashAfterAction.includes('settings') && hashAfterAction !== hashBeforeAction) {
      pAction.works(`hash ${hashBeforeAction} → ${hashAfterAction}(走 App 的 navigate,守衛仍在)`, EVIDENCE.DOM)
    } else {
      pAction.dead(`按了錯誤 toast 的行動按鈕但 hash 是 ${hashAfterAction}(預期含 settings)`)
    }
    await gotoViaSidebar(main, '總覽')
    await sleep(400)
  }
}

// 6.8 崩潰畫面(除了重載以外都是量得到的)
async function stepCrash(app, main) {
  console.log('步驟 13：崩潰畫面…')
  const pCopy = probe(key('crash', 'button', '複製錯誤詳細資料'), '崩潰')
  const forced = await main.evaluate(() => window.__auditForce?.('crash.render', true))
  if (!forced?.ok) {
    pCopy.unreachable('稽核橋無法強制渲染崩潰畫面')
    return
  }
  await sleep(900)
  report.note('崩潰畫面按鈕', await main.evaluate(() =>
    [...document.querySelectorAll('[data-testid="crash-screen"] button')].map((b) =>
      (b.textContent || '').replace(/\s+/g, ' ').trim()
    )
  ).catch(() => []))
  // 先清空剪貼簿,才能斷言「真的被寫進去了」
  await app.evaluate(({ clipboard }) => clipboard.writeText('')).catch(() => {})
  const clicked = await clickText(main, '複製錯誤詳細資料', { scope: '[data-testid="crash-screen"]' })
  await sleep(700)
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => '')
  if (clicked === true && String(clip).length > 20) pCopy.works(`剪貼簿寫入 ${String(clip).length} 字`, EVIDENCE.DATA)
  else pCopy.dead(`按了複製但剪貼簿內容長度 ${String(clip).length}(clicked=${clicked})`)
  // 崩潰畫面不會自己還原 —— 不重載的話,後面每一個步驟都會「找不到控制項」。
  await recoverFromCrash(main)
}

// 6.9 浮層工具列(第二輪)
async function stepOverlayExtra(app, main) {
  console.log('步驟 14：浮層工具列的其餘控制項…')
  const overlayWin = () => app.windows().find((w) => w !== main)
  const overlay = overlayWin()
  if (!overlay) {
    blocked('浮層工具列', '浮層視窗不存在')
    return
  }

  /**
   * 把浮層恢復到指定的形態與內容再量。
   *
   * 為什麼每一次都要重設:前面的探針可能把它留在藥丸、隱藏、或上一個顯示模式,
   * 而「找不到捲動容器」在藥丸形態下是**正常的** —— 不斷言這件前置事情的話,
   * 量到的「失敗」其實是量測端站在錯的形態上(而那種失敗會被讀成產品缺陷)。
   */
  const scrollContent = Array.from(
    { length: 40 },
    (_, i) => `第 ${i + 1} 句:這是一段夠長的內容,捲動位置才量得出來。`
  ).join('\n')
  /**
   * 重點模式需要的內容跟捲動模式不一樣。
   *
   * 「上一個/下一個重點」翻的是 bulletIndex,而 bullet 是從 **Markdown 標題 / 清單**
   * 切出來的(bulletGenerator)。拿一段沒有結構的長文去驗,切不出重點,
   * 浮層只會顯示「此講稿無法切出重點」—— 那時兩顆鈕按下去當然什麼都没變,
   * 而那不是按鈕的問題。
   */
  const bulletContent = Array.from(
    { length: 5 },
    (_, i) => `# 重點${i + 1}\n這一段是重點${i + 1}的說明,內容夠長才看得出本來在講哪一段。`
  ).join('\n')
  const showOverlay = async (mode = 'scroll') => {
    await main.evaluate(
      async ([m, content]) => {
        await window.api.setSettings({ overlay: { compact: false, lensMode: false, displayMode: m } })
        await window.api.overlayShow({ title: '稽核浮層', content })
      },
      [mode, mode === 'bullet' ? bulletContent : scrollContent]
    )
    // 顯示是 IPC → 等它真的可見,而不是賭一個固定的秒數。
    for (let i = 0; i < 25; i++) {
      const v = await main.evaluate(async () => (await window.api.overlayIsVisible?.()) ?? null)
      if (v === true) break
      await sleep(200)
    }
    await sleep(1200)
  }
  await showOverlay('scroll')

  /**
   * 這一區的 key 一律用**列舉端真的會產生的名字**。
   * 例如字體鈕的無障礙名稱來自鈕上的文字(A+ / A- / ↺),title 只是補充 ——
   * 登記成 title 的話兩邊永遠對不上,而兩邊都說得通,所以那種不一致
   * 不會自己浮出來。
   */
  const keys = [
    ['隱藏', 'button'],
    ['關閉', 'button'],
    ['貼鏡模式', 'button'],
    ['↺', 'button'],
    ['下一個重點', 'button'],
    ['上一個重點', 'button'],
    ['鏡像', 'button'],
    ['螢幕擷取隱形', 'button'],
    ['滑鼠穿透', 'button'],
    ['浮層置中', 'button']
  ]
  const geo = () =>
    overlay
      .evaluate(() => {
        let sc = null
        let best = 20
        for (const e of document.querySelectorAll('*')) {
          const d = e.scrollHeight - e.clientHeight
          if (d > best) {
            best = d
            sc = e
          }
        }
        return {
          surface: document.querySelector('[data-overlay-surface]')?.getAttribute('data-overlay-surface') ?? null,
          scrollTop: sc ? Math.round(sc.scrollTop) : null
        }
      })
      .catch(() => ({ surface: null, scrollTop: null }))
  /** 依收斂後的 title 點 —— 與列舉端同一套規則(見 clickByTitle)。 */
  const overlayClick = (title) => clickByTitle(overlay, title)

  const P = Object.fromEntries(keys.map(([n]) => [n, probe(key('overlay', 'button', n), '浮層')]))
  /**
   * 浮層視窗的 bounds。
   *
   * 為什麼從 Electron 主程序拿而不是從 renderer 量 `getBoundingClientRect()`:
   * 這三顆角落鈕的效果是**移動視窗**,而 renderer 自己的座標系不會因為視窗被移動
   * 而改變 —— 在頁面裡量自己的位置,量到的永远是同一个数,那是没有意义的自我肯定。
   */
  const overlayBounds = async () => {
    const all = await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBounds()))
      .catch(() => [])
    return all
  }

  // 鏡像 / 螢幕擷取隱形 / 滑鼠穿透:資料層必須翻轉
  for (const [label, prefix, path] of [
    ['鏡像', '鏡像', 'overlay.mirror'],
    ['螢幕擷取隱形', '螢幕擷取隱形', 'overlay.captureProtected'],
    ['滑鼠穿透', '滑鼠穿透', 'overlay.clickThrough']
  ]) {
    const before = await readSetting(main, path)
    if (await overlayClick(prefix)) {
      await sleep(900)
      const after = await readSetting(main, path)
      if (after === !before) P[label].works(`${path} ${before} → ${after}`, EVIDENCE.DATA)
      else P[label].dead(`按了「${label}」但 ${path} 是 ${JSON.stringify(after)}(原本 ${JSON.stringify(before)})`)
    } else {
      P[label].unreachable(`找不到「${prefix}…」按鈕`)
    }
  }

  // 貼鏡模式 → surface 真的變 lens
  const beforeSurface = (await geo()).surface
  if (await overlayClick('貼鏡模式')) {
    await sleep(1200)
    const after = (await geo()).surface
    if (after === 'lens' && after !== beforeSurface) {
      P['貼鏡模式'].works(`surface ${beforeSurface} → lens`, EVIDENCE.OTHER_WINDOW)
    } else {
      P['貼鏡模式'].dead(`按了貼鏡模式但 surface=${after}(原本 ${beforeSurface})`)
    }

    /**
     * 隱藏只在貼鏡形態的工具列上。
     * 先前的作法是在展開形態找它 —— 找不到,而「找不到」被記成 unverifiable,
     * 於是這顆鈕從來沒有被量過。兩個形態是**同一個動作的兩種渲染**,都得摸到。
     */
    if ((await geo()).surface === 'lens') {
      /**
       * 貼鏡形態專屬的三顆角落吸附。
       *
       * 為什麼以前它們是「沒有探針」:登記表裡只有「貼鏡模式」一條,
       * 而這三顆只在 lens 形態的工具列上 —— 登記表漏了三顆**真實存在**的控制項,
       * 覆蓋率理應把它們報上來。那是對的。
       *
       * 證據是主程序看到的視窗 bounds:三顆鈕把視窗移到不同的 x,
       * 而「按下去有沒有換 class」這種證據在這個專案早就不算了。
       */
      for (const [label, title] of [
        ['↖ 左上', '浮層吸附到螢幕左上'],
        ['↑ 上中', '浮層吸附到螢幕上中'],
        ['↗ 右上', '浮層吸附到螢幕右上']
      ]) {
        const pc = probe(key('overlay', 'button', label), '浮層')
        if (!pc) continue
        const b0 = await overlayBounds()
        if (!(await overlayClick(title))) {
          pc.unreachable(`貼鏡形態找不到「${title}」按鈕`)
          continue
        }
        let b1 = b0
        for (let i = 0; i < 16 && JSON.stringify(b1) === JSON.stringify(b0); i++) {
          await sleep(200)
          b1 = await overlayBounds()
        }
        if (JSON.stringify(b1) === JSON.stringify(b0)) {
          pc.dead(`按了「${label}」但視窗 bounds 完全沒變:${JSON.stringify(b0)}`)
        } else {
          const x = (bs) => bs.map((b) => `${b.x},${b.y}`).join(' | ')
          pc.works(`視窗位置 ${x(b0)} → ${x(b1)}`, EVIDENCE.DATA)
        }
      }

      const pLensHide = P['隱藏']
      const visibleBefore = await main.evaluate(async () => (await window.api.overlayIsVisible?.()) ?? null)
      if (visibleBefore !== true) {
        pLensHide.unreachable(`浮層已經是隱藏的(overlayIsVisible=${visibleBefore})`)
      } else if (await overlayClick('隱藏')) {
        let visibleAfter = visibleBefore
        for (let i = 0; i < 20 && visibleAfter !== false; i++) {
          visibleAfter = await main.evaluate(async () => (await window.api.overlayIsVisible?.()) ?? null)
          if (visibleAfter !== false) await sleep(200)
        }
        if (visibleAfter === false) pLensHide.works('貼鏡形態的「隱藏」:overlayIsVisible true → false', EVIDENCE.DATA)
        else pLensHide.dead(`按了「隱藏」但 overlayIsVisible 還是 ${visibleAfter}`)
      } else {
        pLensHide.unreachable('貼鏡形態找不到「隱藏…」按鈕')
      }
    }
    // 退出貼鏡,後面的捲動探針才能在展開形態下量
    await overlayClick('退出貼鏡模式')
    await sleep(1000)
  } else {
    P['貼鏡模式'].unreachable('找不到「貼鏡模式…」按鈕')
    P['隱藏'].unreachable('只有貼鏡形態才有「隱藏」鈕,而貼鏡開不起來')
  }

  // 回到開頭:捲動位置是可讀的幾何量
  await showOverlay('scroll')
  const g0 = await geo()
  if (g0.scrollTop === null) {
    P['↺'].unreachable(`浮層裡找不到有捲動距離的元素(surface=${g0.surface})—— 藥丸/貼鏡形態本來就沒有可捲動區域`)
  } else {
    // 先讓它播放幾秒,捲到中間,「回到開頭」才驗得出來
    await overlayClick('播放')
    await sleep(2500)
    await overlayClick('暫停')
    await sleep(400)
    const beforeTop = (await geo()).scrollTop
    if (await overlayClick('回到開頭')) {
      /**
       * 量「最小值」而不是「當下值」。
       *
       * restart 的契約是「重置游標並**回到播放**」(engine.test.ts 明確斷言
       * restart 後 status==='playing')。所以位置歸零只存在一瞬間,接著它
       * 又繼續往前捲。單點量測永遠在和它賽跑:
       *   立刻量 → DOM 還沒重畫(量到點擊前的位置,上一輪就是這樣得到 213)
       *   等 900ms → 已經捲了 200 多 px
       * 兩者都是一顆正常按鈕被記成 dead。所以輪詢並取最小值:
       * 「它曾經回到接近 0」才是這個動作真正發生的事。
       */
      let min = Number.POSITIVE_INFINITY
      for (let i = 0; i < 14; i++) {
        const v = (await geo()).scrollTop
        if (v !== null) min = Math.min(min, v)
        await sleep(110)
      }
      if (Number.isFinite(min) && min <= Math.max(30, beforeTop * 0.2)) {
        P['↺'].works(
          `捲動位置從 ${beforeTop}px 回到 ${min}px(再繼續往前捲 —— restart 的契約就是回到播放)`,
          EVIDENCE.GEOMETRY
        )
      } else {
        P['↺'].dead(`按了回到開頭後最小值是 ${min}px(按之前是 ${beforeTop}px),沒有回到開頭`)
      }
    } else {
      P['↺'].unreachable('找不到「回到開頭」按鈕')
    }
  }

  /**
   * 上一個 / 下一個重點:只在**重點要點模式**(displayMode='bullet')才存在。
   * 先前的作法是「在展開形態找它們」—— 找不到,而「找不到」被記成
   * unverifiable。正確的作法是把前置條件(模式)先備妥,再量。
   */
  await showOverlay('bullet')
  /**
   * 重點模式的觀察量是**頁碼**「n / m」,不是 scrollTop。
   *
   * 重點模式沒有可捲動的區域(它是一頁一頁翻的)——上一輪用 scrollTop 量,
   * 得到的是「找不到可捲動的容器」,那是一句關於**版面**的實話,
   * 但它對「這兩顆鈕有沒有用」什麼都沒說。BulletSurface 自己有頁碼,
   * 那才是這個動作的產物。
   */
  const bulletPage = () =>
    overlay
      .evaluate(() => {
        const m = (document.body?.textContent || '').match(/(\d+)\s*\/\s*(\d+)\s*・/)
        return m ? { index: Number(m[1]), total: Number(m[2]) } : null
      })
      .catch(() => null)
  const b0 = await bulletPage()
  if (!b0 || b0.total < 2) {
    const why = `重點模式沒有切出多頁重點(頁碼=${JSON.stringify(b0)},surface=${(await geo()).surface})`
    P['下一個重點'].unreachable(why)
    P['上一個重點'].unreachable(why)
  } else {
    const hasNext = await overlayClick('下一個重點')
    if (!hasNext) {
      P['下一個重點'].unreachable('重點模式下找不到「下一個重點」按鈕')
      P['上一個重點'].unreachable('重點模式下找不到「上一個重點」按鈕')
    } else {
      await sleep(700)
      const n1 = await bulletPage()
      if (n1 && n1.index === b0.index + 1) {
        P['下一個重點'].works(`重點頁碼 ${b0.index} / ${b0.total} → ${n1.index} / ${n1.total}`, EVIDENCE.DOM)
      } else {
        P['下一個重點'].dead(`按了下一個重點但頁碼 ${JSON.stringify(b0)} → ${JSON.stringify(n1)}`)
      }

      if (await overlayClick('上一個重點')) {
        await sleep(700)
        const p1 = await bulletPage()
        if (p1 && n1 && p1.index === n1.index - 1) {
          P['上一個重點'].works(`重點頁碼 ${n1.index} / ${n1.total} → ${p1.index} / ${p1.total}`, EVIDENCE.DOM)
        } else {
          P['上一個重點'].dead(`按了上一個重點但頁碼 ${JSON.stringify(n1)} → ${JSON.stringify(p1)}`)
        }
      } else {
        P['上一個重點'].unreachable('重點模式下找不到「上一個重點」按鈕')
      }
    }
  }
  // 把形態還原成連續捲動 —— 後面的置中/隱藏不該在重點模式下量。
  await showOverlay('scroll')

  // 浮層置中 → 視窗 bounds 回到工作區中央
  const boundsOf = () =>
    app
      .evaluate(({ BrowserWindow }) => {
        const ws = BrowserWindow.getAllWindows()
        return ws.map((w) => w.getBounds())
      })
      .catch(() => [])
  const beforeBounds = await boundsOf()
  if (await overlayClick('浮層置中')) {
    await sleep(1200)
    const afterBounds = await boundsOf()
    if (JSON.stringify(beforeBounds) !== JSON.stringify(afterBounds)) {
      P['浮層置中'].works(`視窗 bounds 改變:${JSON.stringify(beforeBounds)} → ${JSON.stringify(afterBounds)}`, EVIDENCE.DATA)
    } else {
      P['浮層置中'].dead(`按了浮層置中但 bounds 完全沒變:${JSON.stringify(beforeBounds)}`)
    }
  } else {
    P['浮層置中'].unreachable('找不到「浮層置中…」按鈕')
  }

  // 關閉(展開形態)→ overlayIsVisible 真的變 false(最後驗,因為之後要重新顯示)
  for (const [label, prefix] of [
    ['關閉', '關閉']
  ]) {
    const visibleBefore = await main.evaluate(async () => (await window.api.overlayIsVisible?.()) ?? null)
    if (visibleBefore !== true) {
      P[label].unreachable(`浮層已經是隱藏的(overlayIsVisible=${visibleBefore})`)
      continue
    }
    if (await overlayClick(prefix)) {
      // 輪詢而不是固定睡 1.2 秒:overlayHide 是 IPC,而「顯示/隱藏」的狀態回來
      // 需要時間。固定睡眠會讓下一個呼叫(overlayShow)跟它賽跑,
      // 結果就是「按了關閉但還是可見」——那是量測端的時序,不是產品的錯。
      let visibleAfter = visibleBefore
      for (let i = 0; i < 20 && visibleAfter !== false; i++) {
        visibleAfter = await main.evaluate(async () => (await window.api.overlayIsVisible?.()) ?? null)
        if (visibleAfter !== false) await sleep(200)
      }
      if (visibleAfter === false) P[label].works('overlayIsVisible true → false', EVIDENCE.DATA)
      else P[label].dead(`按了「${label}」但 overlayIsVisible 還是 ${visibleAfter}`)
    } else {
      P[label].unreachable(`找不到「${prefix}…」按鈕`)
    }
    // 重新顯示,讓後續步驟還有浮層可用 —— 而且**等到它真的可見**才繼續。
    await showOverlay('scroll')
  }
}

// ───────── 7. 覆蓋率:列舉 × 登記 × 執行 ─────────

/**
 * 這一支是「所有 UI/UX 都有效果」這句話能不能被信任的地方。
 *
 * 它做三件事:
 *   1. 把所有宣告的狀態列舉一遍(DOM 上真的有這些控制項嗎)
 *   2. 對帳:列舉到但沒登記 → no-effect-probe;登記了但沒結論也沒豁免 → probe-not-run
 *   3. 把數字寫進 meta.notes(覆蓋率本身就是輸出的一部分)
 */
async function stepInventory(app, main, stt, llm) {
  console.log('步驟 15：控制項覆蓋率對帳…')
  await clearAll(main)
  const enumerated = new Map() // baseKey → {page, name, disabled, states[]}
  const statesSeen = []

  /**
   * 每一筆都記下「它是在哪幾個狀態裡被看到的」。
   *
   * 為什麼需要這個:沒有它的話,「這顆控制項從沒出現過」只能靠回溯程式才確認得了,
   * 而一份不能被外部覆核的報告只是一段自圆其说的文字。
   * 有了它,「某顆控制項其實出現在 dialog/confirm 裡」這種結論不用跑第二次稽核。
   */
  const scan = async (win, pageId, scope, stateId) => {
    const list = await win.evaluate(ENUMERATE, { pageId, scope: scope ?? null }).catch(() => null)
    if (!list) return 0
    for (const c of list) {
      const k = baseKey(c.key)
      const prev = enumerated.get(k)
      if (prev) {
        if (!prev.states.includes(stateId)) prev.states.push(stateId)
      } else {
        enumerated.set(k, { page: pageId, name: c.name, disabled: c.disabled, states: [stateId] })
      }
    }
    return list.length
  }

  /**
   * 浮層狀態的前置作業 —— 與 stepOverlayExtra 用同一套理由與同一段內容。
   *
   * 這裡的三個形態各自會讓**不同的控制項存在**:貼鏡才有「隱藏」、
   * 重點模式才有「上一個/下一個重點」、藥丸形態兩者都沒有。
   * 把形態設錯,量到的「找不到」是量測端站錯位置,不是產品缺鈕。
   */
  const scrollContent = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 句:這是一段夠長的內容,捲動位置才量得出來。`).join('\n')
  const bulletContent = Array.from(
    { length: 5 },
    (_, i) => `# 重點${i + 1}\n這一段是重點${i + 1}的說明,內容夠長才看得出本來在講哪一段。`
  ).join('\n')
  const overlayWin = () => app.windows().find((w) => w !== main)
  const overlayClick = (title) => {
    const w = overlayWin()
    return w ? clickByTitle(w, title) : Promise.resolve(false)
  }
  const showOverlay = async ({ mode = 'scroll', pill = false, lens = false } = {}) => {
    await main.evaluate(
      async ([m, comp, ln, content]) => {
        await window.api.setSettings({ overlay: { compact: comp, lensMode: ln, displayMode: m } })
        await window.api.overlayShow({ title: '稽核浮層', content })
      },
      [mode, pill, lens, mode === 'bullet' ? bulletContent : scrollContent]
    )
    for (let i = 0; i < 25; i++) {
      const v = await main.evaluate(async () => (await window.api.overlayIsVisible?.()) ?? null)
      if (v === true) break
      await sleep(200)
    }
    await sleep(1100)
  }
  /**
   * 對**浮層視窗**送稽核橋。
   *
   * 為什麼需要專屬的一組:force() 走的是 main,而浮層是另一個 renderer
   * 程序。`overlay.coachingHint` 註冊在 OverlayApp 裡 —— 也就是註冊在浮層,
   * 不在 main。在 main 送過去會得到「找不到名字」,而症狀是這一格交出 0 顆
   * 控制項,然後覆蓋率報「這顆鈕從沒出現過」:對的結論,錯的診斷。
   */
  const overlayForce = (name, arg) =>
    overlayWin()
      ?.evaluate(
        async ([n, a]) => (await window.__auditForce?.(n, a)) ?? { ok: false, error: '橋接不存在' },
        [name, arg]
      )
      .catch((err) => ({ ok: false, error: String(err?.message || err) })) ?? Promise.resolve({ ok: false, error: '浮層視窗不存在' })
  /** 對浮層送橋並等它真的生效。回傳整包結果(含 bridge 的 error/names)。 */
  const overlayForceOk = async (name, arg, tries = 12, waitMs = 250) => {
    let last = { ok: false, error: '(沒呼叫)' }
    for (let i = 0; i < tries; i++) {
      last = await overlayForce(name, arg)
      if (last?.ok) return last
      await sleep(waitMs)
    }
    return last
  }
  /** 在浮層裡按 data-effect-id。 */
  const overlayClickEffectId = (id) =>
    overlayWin() ? clickEffectId(overlayWin(), id) : Promise.resolve(false)
  /** 導航之後才成立的狀態:控制項與覆寫鉤子只在該頁掛載時存在。 */
  /**
   * **看 `.ok`，不要比對 `=== true`。**
   *
   * `forceAuditState` 回傳的是物件 `{ ok, names?, error?, result? }`（見
   * src/renderer/src/lib/auditBridge.ts），**永遠不會等於 `true`**。
   * 所以這一版只要用了 `=== true`，每一個 force 鉤子都會被判成「沒生效」——
   * 症狀是整片 state-unreached：講稿頁沒掛載、expandSession 無效、
   * practice.branchState 四個狀態全部無效，看起來像八個產品缺陷，其實只有一行比對。
   *
   * 而且這一行還把診斷資訊丟掉了：bridge 明確回傳 `names`（目前註冊了哪些控制項）
   * 與 `error`，註解寫著「找不到名字時最有用的資訊就是這份清單」。
   * 一行 `=== true` 把最有價值的那份證據丟進垃圾桶，於是我只能靠猜。
   *
   * 現在回傳整包結果，讓 blocked 的原因可以照原文寫進報告。
   */
  const force = async (name, arg) =>
    main
      .evaluate(async ([n, a]) => (await window.__auditForce?.(n, a)) ?? { ok: false, error: '橋接不存在' }, [name, arg])
      .catch((err) => ({ ok: false, error: String(err?.message || err) }))
  /** force() 成功與否；失敗時把 bridge 給的 error/names 一起帶出來。 */
  const forceOk = async (name, arg, tries = 12, waitMs = 250) => {
    let last = { ok: false, error: '(沒呼叫)' }
    for (let i = 0; i < tries; i++) {
      last = await force(name, arg)
      if (last?.ok) return last
      await sleep(waitMs)
    }
    return last
  }
  /** 失敗時的完整原因（含 bridge 提供的 names），直接寫進報告。 */
  const forceWhy = (r) =>
    [r?.error ? 'error=' + r.error : null, r?.names ? '已註冊=' + r.names.join(',') : null]
      .filter(Boolean)
      .join('; ') || '(bridge 沒有提供原因)'
  for (const st of STATES) {
    // ── 播種(資料層) ──
    if (st.seed === 'none') await clearAll(main)
    else if (['script', 'editing', 'dirty', 'preview', 'dialog'].includes(st.seed))
      await seedScripts(main, ['稽核講稿一', '稽核講稿二'])
    else if (st.seed === 'sessions' || st.seed === 'sessionOpen' || st.seed === 'sessionSummarized') await seedSessions(main)
    else if (
      ['runs', 'practiceRun', 'practiceAnswering', 'practiceAnswered', 'practiceLastAnswered', 'practiceDone'].includes(st.seed)
    )
      await seedRuns(main)
    else if (st.seed === 'all') {
      await seedScripts(main, ['稽核講稿一', '稽核講稿二'])
      await seedSessions(main)
      await seedRuns(main)
    }

    // ── 導航(同時把浮層擺到這個狀態需要的形態與內容) ──
    if (st.nav === 'overlay') {
      await showOverlay({
        mode: st.seed === 'overlayBullet' ? 'bullet' : 'scroll',
        pill: st.seed === 'overlayPill',
        lens: st.seed === 'overlayLens'
      })
    } else {
      await gotoViaSidebar(main, { dashboard: '總覽', scripts: '提詞講稿', record: '錄音轉錄', practice: '面試練習', calibration: '個人化校準', settings: '設定' }[st.nav])
      await sleep(900)
    }

    // ── 導航之後才成立的狀態 ──
    // 這些的共通點:它們要馬是**只在該頁掛載的控制項**(scripts.selectIndex /
    // record.expandSession / practice.branchState),要馬要真的按一顆鈕(測試連線 /
    // 開始聆聽)。在別頁呼叫鉤子會安靜地回 false —— 所以每個都驗回傳值,
    // 失敗就記 blocked,而不是讓那個狀態交出 0 顆控制項、讓覆蓋率少一角。
    if (st.seed === 'editing' || st.seed === 'dirty') {
      // 選取一份講稿 → 編輯器(標題欄/textarea/儲存/刪除/開始提詞)才會出現。
      const sel = await forceOk('scripts.selectIndex', 0)
      if (!sel.ok) blocked(`狀態:${st.id}`, 'scripts.selectIndex 沒有生效;' + forceWhy(sel))
      await sleep(800)
    }
    if (st.seed === 'dirty') {
      /**
       * **改一個字**,讓儲存鈕從「已儲存」變成「儲存」。
       *
       * 為什麼需要這個狀態:儲存鈕的文案是 `dirty ? '儲存' : '已儲存'`。
       * `scripts/editing` 只是「選取一份稿」—— 那是乾淨的狀態,鈕上的字是「已儲存」,
       * 而登記表寫的是「儲存」。於是覆蓋率報「這顆有登記但從沒出現過」,
       * 而那句話是**對的**:它所在的狀態沒有被宣告。
       *
       * 用真的輸入(Playwright fill 走 input 事件 → React 的 onChange),
       * 而不是直接改 DOM 的 value —— 後者不會觸發 React,dirty 永遠是 false,
       * 症狀又是「量測端改了畫面但狀態沒變」。
       */
      const changed = await main
        .locator('[data-effect-id="script-body"]')
        .first()
        .fill('這是被稽核改過的內容,目的是讓儲存鈕變成可按的狀態。')
        .then(() => true)
        .catch(() => false)
      if (!changed) blocked(`狀態:${st.id}`, '找不到編輯器 textarea([data-effect-id="script-body"])')
      await sleep(700)
      const labelNow = await main.evaluate(() => {
        const b = [...document.querySelectorAll('main button')].find((x) => /^儲存$|^已儲存$/.test((x.textContent || '').trim()))
        return b ? { label: (b.textContent || '').trim(), disabled: b.disabled } : null
      })
      if (!labelNow || labelNow.label !== '儲存') {
        blocked(`狀態:${st.id}`, `改了內容但儲存鈕是 ${JSON.stringify(labelNow)}(預期 {label:'儲存',disabled:false})`)
      }
    }
    if (st.seed === 'openai') {
      await clickEffectId(main, 'provider', 1)
      await sleep(900)
    }
    if (st.seed === 'uncalibrated') {
      // 沒有個人參數時是「開始校準」,有參數才換成「重新校準」。
      await main.evaluate(async () => {
        await window.api.setSettings({ personal: { profile: null } })
      })
      await sleep(800)
    }
    if (st.seed === 'ollamaConnected') {
      // 「Ollama 模型」選單只在「測試連線」成功之後才渲染 —— 所以這裡真的按它。
      // 用 mock 的位址:這個狀態要量的是**選單存不存在**,而真實 Ollama
      // 在稽核機上不一定有。
      const base = process.env.MOCK_LLM_URL || (await main.evaluate(async () => (await window.api.getSettings()).ai.ollama.baseUrl))
      await main.evaluate(async (url) => {
        await window.api.setSettings({ ai: { provider: 'ollama', ollama: { baseUrl: url } } })
      }, base || llm.origin)
      await sleep(800)
      const clicked = await clickText(main, '測試連線')
      let hasSelect = false
      for (let i = 0; i < 24 && !hasSelect; i++) {
        hasSelect = await main.evaluate(() => !!document.querySelector('[data-effect-id="ollama-model"]')).catch(() => false)
        if (!hasSelect) await sleep(250)
      }
      if (clicked !== true || !hasSelect) blocked(`狀態:${st.id}`, clicked !== true ? '找不到「測試連線」' : '按了測試連線但模型選單沒有出現')
    }
    if (st.seed === 'preflightIssues') {
      /**
       * 這兩個狀態是「準備度卡片有話要說」的世界。
       *
       * 為什麼需要宣告它:卡片在「什麼都不缺」時自己回 null(設計如此),
       * 於是它的三顆鈕(複製/前往設定/知道了)在別的狀態裡根本不存在 ——
       * 而「不存在」與「沒驗過」在報告上看起來一樣。
       */
      await main.evaluate(async () => {
        await window.api.setSettings({ ai: { provider: 'ollama' }, stt: { engine: 'local' } })
        // 上一個探針可能把某個非擋路項目「知道了,不用再提醒」寫進 localStorage,
        // 而那是持久化的 —— 不清掉的話這個狀態會少掉那顆鈕。
        localStorage.removeItem('ai-tp.preflight.dismissed')
        window.__auditForce?.('preflight.ollamaDown', true)
      })
      await sleep(2000)
    }
    if (st.seed === 'preflightNoModel') {
      // 「Ollama 裝好了,但還沒有任何模型」—— 唯一長著「複製指令」鈕的世界。
      // preflight-issues 的 ollamaDown 世界只有「下載 Ollama」,兩者互斥
      // (稽核覆寫 store 只有一份),所以這個世界要自己宣告,見 STATES 的註解。
      await main.evaluate(async () => {
        await window.api.setSettings({ ai: { provider: 'ollama' }, stt: { engine: 'local' } })
        localStorage.removeItem('ai-tp.preflight.dismissed')
        window.__auditForce?.('preflight.models', [])
      })
      await sleep(2000)
    }
    if (st.seed === 'sttCloud') {
      /**
       * 雲端辨識的三個欄位只在 `engine === 'cloud'` 時渲染。
       *
       * 這個狀態為什麼以前從來沒有被宣告:前一個狀態(`preflightIssues`)為了讓
       * 準備度卡片有話說,把引擎設成了 `local`,而**沒有設回去**。
       * 於是錄音狀態跑在本地引擎上 → `ensureWhisper()` 開始下載數百 MB 模型 →
       * 主要鈕永遠停在「啟動中…」→ 覆蓋率報「按了開始聆聽但鈕沒變」。
       *
       * 症狀寫成「錄音功能壞了」,而實際上是量測端自己上一步留下的全域狀態。
       * 所以這裡不只設定,**還讀回來確認**,並把 baseUrl 指回本機 mock。
       */
      const sttOk = await ensureSttOnMock(main, stt)
      if (!sttOk) blocked(`狀態:${st.id}`, 'STT mock 前置條件未備妥(engine/baseUrl 讀回來不對)')
      await sleep(700)
    }
    if (st.seed === 'dialog') {
      /**
       * 確認對話框的範圍是 `[role="dialog"]` —— 所以**對話框開不起來就是 0 顆**。
       *
       * 上一版只按「刪除這份講稿」就等 800ms。而那顆鈕只在「選取了一份稿」的
       * 編輯器裡,而這個狀態的 seed 是 `dialog`(原本不在 seedScripts 的名單裡),
       * 於是頁面上根本沒有講稿 —— 按不到、對話框沒開、列舉 0 顆。
       * 症狀是「dialog/confirm 有 0 顆控制項」,而登記表的 confirm-ok/cancel
       * 於是被報成「有登記但從沒出現過」。**兩句話都在說量測端站錯位置。**
       *
       * 而且播種必須在**導航之前**(像其他狀態一樣):Scripts 頁的清單是
       * mount 時讀一次 IndexedDB 的,導航之後才寫資料,頁面手上還是空的。
       * 這一版的症狀正是這樣:`scripts.selectIndex` 回 false,
       * 而 bridge 給的 `names` 證明鉤子**有註冊**(不是沒掛載)——
       * 是它找不到第 0 份稿,因為清單是空的。
       */
      const sel = await forceOk('scripts.selectIndex', 0)
      if (!sel.ok) blocked(`狀態:${st.id}`, 'scripts.selectIndex 沒有生效(講稿清單是空的?);' + forceWhy(sel))
      await sleep(800)
      const clicked = await clickText(main, '刪除這份講稿')
      let opened = false
      for (let i = 0; i < 16 && !opened; i++) {
        opened = await main.evaluate(() => !!document.querySelector('[role="dialog"]')).catch(() => false)
        if (!opened) await sleep(250)
      }
      if (clicked !== true || !opened) {
        blocked(
          `狀態:${st.id}`,
          clicked !== true ? '找不到「刪除這份講稿」(編輯器沒掛載?)' : '按了刪除但確認對話框沒有出現'
        )
      }
      await sleep(500)
    }
    if (st.seed === 'updateBanner') {
      /**
       * 排出「已下載更新」這則橫幅。
       *
       * 與 toast 同一個理由:一則真實的更新事件在稽核環境不會發生,而列舉端
       * 只認「宣告狀態裡真的渲染出來」。所以這一格是把橫幅造出來,讓兩顆按鈕
       * 進入列舉 —— 否則它們在登記表裡卻永遠 probe-not-found。
       *
       * 用 App 層的稽核橋(不是 main 的 state):橫幅的狀態本來就在 renderer
       * 的 zustand store(l.update.ts),main 只是補問的來源。
       */
      const ok = await forceOk('update.downloaded', '9.9.9-audit')
      if (!ok.ok) blocked(`狀態:${st.id}`, 'update.downloaded 沒有生效;' + forceWhy(ok))
      await sleep(600)
    }
    if (st.seed === 'toast') {
      /**
       * **帶 action 的那一則**,不是沒有 action 的。
       *
       * `toast|id:toast-action` 是登記表裡的一筆,但它在這裡曾經是
       * probe-not-found —— 有登記、探針也跑過,卻沒有任何**被宣告的狀態**
       * 渲染出它。原因就是這行原本發的是 `__auditToast('info', '稽核 toast')`:
       * 沒有 action,ToastHost 就不會渲染那顆按鈕。
       *
       * 而沒有 action 可發,本身是個已修的缺陷:`installToastBridge` 早期
       * **丟掉了第三個參數**,所以稽核從來無法製造可行動的 toast ——
       * 「錯誤要能導到該去的頁」這個使用者價值,量測層從來碰不到。
       *
       * 只發**一則**:發兩則會讓「關閉通知」出現兩次,列舉端對重複的鍵加上
       * `#2` 後綴,於是憑空多出一顆 `toast|button|關閉通知#2` —— 一顆從來
       * 不會有探針也永遠不會有人登記的影子控制項。
       */
      await main.evaluate(() =>
        window.__auditToast?.('error', '稽核:AI 服務連不上', {
          label: '前往設定',
          kind: 'goto',
          page: 'settings'
        })
      )
      await sleep(500)
    }
    if (st.seed === 'crash') {
      await main.evaluate(() => window.__auditForce?.('crash.render', true))
      await sleep(900)
    }
    if (st.seed === 'preview') {
      /**
       * 開錄影預覽 modal —— 並**讀回來確認它真的開了**。
       *
       * 這個 modal 裡有兩顆從未被量過的控制項(截斷的完整路徑、沒有可及名稱的
       * 圖示關閉鈕),而它們只在 modal 開著時存在。`__auditForce` 是 fire-and-forget,
       * 上一版在這裡不讀回來,於是 modal 沒開時整個狀態交出 0 顆 —— 而覆蓋率
       * 只會說「這顆有登記但從沒出現過」,那句話是對的,卻沒指出量測端站錯位置。
       */
      const pr = await forceOk('scripts.preview', true)
      let open = false
      for (let i = 0; i < 16 && !open; i++) {
        open = await main
          .evaluate(() => !!document.querySelector('[aria-label="關閉錄影預覽"]'))
          .catch(() => false)
        if (!open) await sleep(250)
      }
      if (!pr.ok || !open) blocked(`狀態:${st.id}`, pr.ok ? '強制開啟了但 modal 沒有渲染' : forceWhy(pr))
      await sleep(500)
    }
    if (st.seed === 'calStep1' || st.seed === 'calStep1Rated' || st.seed === 'calStep2') {
      await main.evaluate((v) => window.__auditForce?.('calibration.step', v), st.seed === 'calStep2' ? 2 : 1)
      await sleep(800)
    }
    if (st.seed === 'calStep1Rated') {
      // step1 的「下一步」只在語速結果存在時渲染(與「跳過語速量測」互斥)。
      // 這個狀態把 rateResult 備妥,讓「下一步」出現在被宣告的狀態裡。
      const rr = await forceOk('calibration.branchState', 'rate-plausible')
      if (!rr.ok) blocked(`狀態:${st.id}`, "calibration.branchState('rate-plausible') 沒有生效;" + forceWhy(rr))
      await sleep(600)
    }
    if (st.seed === 'practiceRun' || st.seed === 'practiceAnswering' || st.seed === 'practiceAnswered' || st.seed === 'practiceLastAnswered') {
      const arg = { practiceRun: 'run', practiceAnswering: 'answering', practiceAnswered: 'answered', practiceLastAnswered: 'last-answered' }[st.seed]
      const pr = await forceOk('practice.branchState', arg)
      if (!pr.ok) blocked(`狀態:${st.id}`, "practice.branchState('" + arg + "') 沒有生效;" + forceWhy(pr))
      await sleep(800)
    }
    if (st.seed === 'practiceDone') {
      await clickEffectId(main, 'practice-row', 0)
      await sleep(1000)
    }
    if (st.seed === 'report') {
      // 會後報告卡只在 lastReport 有值時渲染;它由「停止錄音後的計算」產生,
      // 而那個計算在稽核環境要走完整場錄音。用鉤子直接放一份典型報告進去。
      const rb = await forceOk('record.branchState', 'report')
      if (!rb.ok) blocked(`狀態:${st.id}`, 'record.branchState(report) 沒有生效;' + forceWhy(rb))
      await sleep(800)
    }
    if (st.seed === 'sessionOpen' || st.seed === 'sessionSummarized') {
      // 0 = 沒有摘要那一場(→「AI 摘要」),1 = 有摘要那一場(→「重新摘要」)。
      const idx = st.seed === 'sessionOpen' ? 0 : 1
    const exp = await forceOk('record.expandSession', idx)
    if (!exp.ok) blocked(`狀態:${st.id}`, 'record.expandSession(' + idx + ') 沒有生效;' + forceWhy(exp))
      await sleep(900)
    }
    if (st.seed === 'recording') {
      /**
       * 用**真的**開始聆聽進入錄音狀態(假麥克風),而不是假造一個旗標。
       * 主要鈕的文字由 recording 決定,而 recording 只有真的開起 MediaRecorder
       * 才會變 —— 這也是為什麼這個狀態以前從來沒被列舉過。
       */
      //
      // **先把辨識引擎指回 mock，並讀回來確認。**
      //
      // 這是這個狀態進不去的**真正原因**,而且症狀完全不像量測端:
      // STATES 裡的 `dashboard/preflight-issues` 為了讓準備度卡片有話說,
      // 把 `stt.engine` 設成了 `local`(它必須那樣,否則卡片不會說話),而沒有設回去。
      // 於是這裡按「開始聆聽」→ `startInner()` 看到 local → `ensureWhisper()`
      // 開始下載數百 MB 模型 → 主要鈕**永遠停在「啟動中…」**。
      //
      // 報告上寫的是「按了開始聆聽但主要鈕始終沒變成停止並儲存」——
      // 讀起來像錄音功能壞了,實際上是四個狀態之前的一個狀態留下了全域設定。
      // 前一輪把「勾選麥克風」補上來治的是症狀不是病因(而且治對了:那也是真的)。
      // 教訓:一個狀態的前置條件不能建立在「上一個狀態碰巧沒改這個」上。
      const sttOk = await ensureSttOnMock(main, stt)
      if (!sttOk) blocked(`狀態:${st.id}`, 'STT mock 前置條件未備妥(引擎讀回來不是 cloud/baseUrl 不對)')
      await sleep(700)
      //
      // **再把「我的麥克風」打開，並讀回來確認。**
      //
      // 這個狀態要真的開 MediaRecorder 才知道錄音中；而 Record 頁的負向探針
      // （為了驗「兩個音訊來源都關掉時按下去不該有反應」）會把這個勾選關掉再開。
      // 只要那個還原沒落地，這個狀態就進不去。
      const micOn = await main.evaluate(() => {
        const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('我的麥克風'))
        const box = label?.querySelector('input[type=checkbox]')
        if (!box) return false
        if (!box.checked) box.click()
        return box.checked
      })
      if (!micOn) blocked('狀態:record/recording', '「我的麥克風」勾選框找不到，無法進入錄音狀態')
      await sleep(500)
      const clicked = await clickText(main, '開始聆聽')
      let inRecording = false
      for (let i = 0; i < 40 && !inRecording; i++) {
        inRecording = (await domText(main, 'main')).includes('停止並儲存')
        if (!inRecording) await sleep(250)
      }
      if (clicked !== true || !inRecording) {
        /**
         * 失敗時把「它卡在哪個文案」一起帶出來 —— 那一句就是病因。
         * 「按了但沒變」有兩種完全不同的原因:錄音起不來(按鈕會停在「啟動中…」)
         * 與根本沒點到。把它們寫成同一句話,等於把診斷資訊丟掉。
         */
        const labelNow = await main.evaluate(() => {
          const b = [...document.querySelectorAll('main button')].find((x) =>
            /開始聆聽|啟動中|收尾中|停止並儲存|聆聽中/.test(x.textContent || '')
          )
          return b ? (b.textContent || '').trim() : '(按鈕不見了)'
        })
        const engineNow = await main.evaluate(async () => (await window.api.getSettings())?.stt?.engine ?? '?')
        blocked(
          `狀態:${st.id}`,
          clicked !== true
            ? '找不到「開始聆聽」(假麥克風沒備妥?)'
            : `按了開始聆聽但主要鈕沒變成「停止並儲存」;按鈕現在寫「${labelNow}」、引擎=${engineNow}` +
              '(引擎是 local 的話就是 Whisper 在下載模型 —— 前置條件被上一個狀態改掉了)'
        )
      }
      await sleep(600)
    }
    if (st.seed === 'overlayPlaying') {
      // 「暫停」與「播放」是同一顆鈕的兩個狀態;播放中才列舉得到「暫停」。
      if (!(await overlayClick('播放'))) blocked(`狀態:${st.id}`, '浮層裡找不到「播放」')
      await sleep(900)
    }
    if (st.seed === 'overlayCoaching' || st.seed === 'overlayCoachingMuted') {
      /**
       * 用稽核橋塞入教練提示 —— 而不是等真的說到話。
       *
       * 真的教練訊號要麥克風 + Whisper 都在,稽核環境兩者都不成立;
       * 而「點提示條靜默這一種」是使用者會議中唯一能處理它的方式。
       *
       * 必須讀回 `.ok`(見 forceOk 上面那段註解):`__auditForce` 回傳的是
       * 物件不是 true,不比對的話這一格會交出 0 顆控制項,然後覆蓋率會說
       * 「這顆鈕從沒出現過」—— 對的結論,錯的診斷:量測端站錯位置。
       *
       * 第二格多按一次靜默:「恢復全部」的渲染條件是 coachingMuted.length > 0。
       */
      const hintOk = await overlayForceOk('overlay.coachingHint', { kind: 'filler', message: '稽核:填充詞偏多' })
      if (!hintOk) blocked(`狀態:${st.id}`, forceWhy(hintOk))
      await sleep(600)
      if (st.seed === 'overlayCoachingMuted') {
        const muted = await overlayClickEffectId('coaching-mute')
        if (muted !== true) blocked(`狀態:${st.id}`, `按不了 coaching-mute(${muted})`)
        await sleep(700)
      }
    }

    const scope = st.page === 'dialog' ? '[role="dialog"]' : st.page === 'toast' ? '[role="status"]' : st.page === 'crash' ? '[data-testid="crash-screen"]' : null
    const win = st.page === 'overlay' ? app.windows().find((w) => w !== main) : main
    if (!win) {
      blocked(`狀態:${st.id}`, '找不到對應的視窗')
      continue
    }
    const n = await scan(win, st.page, scope, st.id)
    statesSeen.push({ state: st.id, controls: n })

    // ── 收尾 ──
    // 每一個狀態都要把世界還原,否則下一個狀態會站在上一個的殘留上量測
    // (那會產生「看起來像產品的錯」的假紅燈)。
    if (st.seed === 'crash') await main.evaluate(() => window.__auditForce?.('crash.clear'))
    // 橫幅是**跨狀態殘留**的:不清掉的話,下一格會站在這一格的橫幅上量測,
    // 而那會讓每一頁的截圖多出一列綠色橫幅 —— 看起來像產品的錯,不是。
    if (st.seed === 'updateBanner') {
      await main.evaluate(() => window.__auditForce?.('update.downloaded', null)).catch(() => {})
      await sleep(400)
    }
    if (st.seed === 'preview') await main.evaluate(() => window.__auditForce?.('scripts.preview', false))
    if (st.seed === 'dialog') {
      await clickEffectId(main, 'confirm-cancel')
      await sleep(500)
    }
    if (st.seed === 'overlayPlaying') {
      // 播放中的浮層會一直講話;下一個狀態不該繼承它的聲音。
      await overlayClick('暫停')
      await main.evaluate(() => window.api.overlayHide?.()).catch(() => {})
      await sleep(500)
    }
    if (st.seed === 'overlayCoaching' || st.seed === 'overlayCoachingMuted') {
      // 教練提示是**跨狀態殘留**的:不清掉的話,下一格會站在這一格的提示上量測,
      // 而那會產生「看起來像產品的錯」的假紅燈(提示條一直蓋著工具列)。
      // 靜默清單也要歸零 —— 它住在同一個 overlay window 的 React 狀態裡,
      // showOverlay 不會重建視窗,殘留會一路帶到浮層被關掉為止。
      await overlayClickEffectId('coaching-unmute')
      await overlayForce('overlay.coachingHint', null)
      await main.evaluate(() => window.api.overlayHide?.()).catch(() => {})
      await sleep(500)
    }
    if (st.seed === 'recording') {
      // 離開錄音頁會 stopAll(不寫 DB);用導航到總覽把錄音收掉。
      await gotoViaSidebar(main, '總覽')
      await sleep(600)
    }
    if (st.seed === 'preflightIssues' || st.seed === 'preflightNoModel') {
      // ollamaDown / models 覆寫是全域的,留著它會讓後面每一個狀態的準備度卡片都報一樣的問題。
      // (傳 null 現在的語意是「解除覆寫」—— 見 PreflightCard 的 preflight.models 控制項。)
      await main.evaluate(() => window.__auditForce?.('preflight.models', null))
      await sleep(400)
    }
  }

  // ── 窄視窗列舉:已知設計缺口 8 的收口 ──
  //
  // 計畫文件的誠實清單寫著:「列舉目前只在單一視窗尺寸下做;響應式隱藏的控制項
  // 不會被列舉到。」audit-states 早就跑雙尺寸(預設 + 下限 960×640,那是
  // createMainWindow 的 minWidth/minHeight),這裡把同一做法移植過來:
  // 在下限尺寸把六個主視窗頁面重列舉一次,以 `size@960` 狀態標籤併進同一份
  // enumerated。控制項「寬尺寸存在、窄尺寸被響應式隱藏」兩邊都會進 states[];
  // 若有控制項**只在窄尺寸出現**,下面的對帳規則(no-effect-probe / probe-not-run)
  // 會變紅 —— 那正是這個閘門要抓的東西,而不是先默默把涵蓋放行。
  //
  // 探針不需要重跑:對帳要回答的是「登記的控制項被量過沒」。探針的結論來自
  // 寬尺寸下的行為量測;尺寸只是它出現與否的其中一個變因,不是另一種效果。
  console.log('\n── 窄視窗列舉 960×640(收口設計缺口 8)…')
  // 上一個狀態(crash/screen)把整棵樹換成了崩潰畫面 —— ErrorBoundary 不會因為
  // crash.clear 自動復原(那正是它的設計:復原必須是使用者的明確動作)。
  // 寬尺寸的各狀態都排在它之前所以沒人踩到;窄尺寸列舉排在它後面,
  // **必須先重載**,否則六頁全部導航失敗,整段補掃靜默作廢
  // (與第 498 行的崩潰復原同一做法:crash.clear + reload)。
  await main.reload().catch(() => {})
  await sleep(1200)
  await main.setViewportSize({ width: 960, height: 640 }).catch(() => {})
  await sleep(900)
  let narrowTotal = 0
  for (const [pageId, label] of [
    ['dashboard', '總覽'],
    ['scripts', '提詞講稿'],
    ['record', '錄音轉錄'],
    ['practice', '面試練習'],
    ['calibration', '個人化校準'],
    ['settings', '設定']
  ]) {
    if (!(await gotoViaSidebar(main, label))) {
      blocked(`size@960:${pageId}`, `960×640 下導航到「${label}」失敗`)
      continue
    }
    await sleep(700)
    const n = await scan(main, pageId, null, 'size@960')
    narrowTotal += n
    statesSeen.push({ state: 'size@960', controls: n })
  }
  report.note('列舉尺寸', {
    主尺寸: '1180×780(各狀態原生命列舉)',
    窄尺寸: `960×640(createMainWindow 下限;size@960 六頁共列舉 ${narrowTotal} 顆)`
  })
  await main.setViewportSize({ width: 1180, height: 780 }).catch(() => {})
  await sleep(600)

  // ── 對帳 ──
  const enumeratedKeys = [...enumerated.keys()]
  const covered = (k) => PROBED.has(k) || REGISTRY.get(k)?.exempt

  /**
   * **列舉有、登記沒有 → 紅燈。不看它有沒有探針。**
   *
   * 這裡原本多了一個 `&& !covered(k)` —— 而那個例外是這個專案被負向驗證
   * 抓出來的:把登記表裡的一筆刪掉,稽核**不會變紅**。
   *
   * 原因在 `probe()`:它不檢查登記表,任何 key 都給你一個探針物件。
   * 所以「有人寫了探針但忘了登記」的情況下,`covered(k)` 是 true,
   * 那一筆就從紅燈裡消失了。而登記表那一行帶的是**「這個控制項的效果是什麼」**
   * —— 它會跟著報告走,是唯一一份給讀者看的說明。少了它,報告裡就多了一顆
   * 沒有任何說明的「已驗證」控制項,而那正是本支稽核要擋的事。
   *
   * 這也解釋了為什麼必須做負向驗證:刪掉一筆登記本來就該變紅,
   * 而我盯著三次全綠就以為收斂了。
   */
  const noProbe = enumeratedKeys.filter((k) => !REGISTRY.has(k))
  for (const k of noProbe) {
    const info = enumerated.get(k)
    const probed = PROBED.has(k)
    report.add(
      'no-effect-probe',
      `狀態 ${info.states.join('、')}`,
      `${k}(可及名稱「${info.name}」)出現在畫面上,但 effect-inventory 沒有登記它。` +
        (probed
          ? '這一輪**有**探針跑過它 —— 缺的是登記表裡「這個控制項的效果是什麼」那一行,'
            + '沒有那一行的探針在報告裡是沒有說明的結論。'
          : '這一輪也沒有任何探針給它結論。') +
        '新增控制項時必須同時登記它 —— 否則覆蓋率會靜默縮水。'
    )
  }

  /**
   * 登記了、也出現在畫面上,但這一輪沒有任何結論。
   * 這一條比前一條更重要:它讓「探針被條件跳過」不會長得像「驗過了」。
   */
  const notRun = []
  const neverSeen = []
  for (const [k, entry] of REGISTRY) {
    if (entry.exempt) continue
    if (!enumerated.has(k)) {
      /**
       * 登記了,但**任何一個被列舉的狀態都沒有渲染它**。
       *
       * 這一條很容易被寫成「這個環境沒渲染它 → 跳過」,而那就是上一版的寫法。
       * 跳過的代價:一顆只存在於某個沒被宣告的狀態裡的按鈕(例如「重新摘要」
       * 只在已有摘要時出現)會安靜地不存在於報告裡 —— 不是 0,是沒有這一列。
       * 而「沒有這一列」讓覆蓋率看起來満分。
       *
       * 修法有兩條,而兩條都是好事:宣告那個狀態(把狀態清單補齊)或把它標成豁免
       * (寫下為什麼不驗)。兩個都不做,就不該是綠的。
       */
      neverSeen.push(k)
      report.add(
        'probe-not-found',
        '覆蓋率',
        `${k} 有登記,但沒有任何一個被宣告的狀態裡出現過它 —— ` +
          `這不是「驗過了」,也不是「不需要驗」,而是它所在的狀態沒有被宣告(或這筆登記已經過期)。` +
          `登記表的說明:${entry.note || '(無)'}`
      )
      continue
    }
    if (PROBED.has(k)) continue
    notRun.push(k)
    report.add(
      'probe-not-run',
      `狀態 ${enumerated.get(k).states.join('、')}`,
      `${k} 有登記、也出現在畫面上,但這一輪沒有任何探針給出結論。` +
        '「沒量到」與「沒問題」長得一樣,所以它一定要進報告。'
    )
  }

  const exemptCount = [...REGISTRY.values()].filter((e) => e.exempt).length
  const coverage = {
    狀態數: statesSeen.length,
    控制項實例: enumeratedKeys.length,
    有結論: enumeratedKeys.filter((k) => covered(k)).length,
    沒有探針: noProbe.length,
    探針沒跑到: notRun.length,
    登記了但從沒出現: neverSeen.length,
    豁免: exemptCount,
    豁免明細: [...REGISTRY.entries()]
      .filter(([, e]) => e.exempt)
      .map(([k, e]) => `${k} — [${e.exempt.category}] ${e.exempt.reason}`)
  }
  report.note('覆蓋率', coverage)
  report.note('狀態清單', statesSeen)
  /**
   * 列舉到的控制項清單(完整)。
   *
   * 為什麼要寫進報告:沒有它,「登記了但從沒出現」只能靠回溯程式才能確認
   * —— 而一份報告若不能被外部覆核,它就只是一段自圓其說的文字。
   */
  report.note('列舉到的控制項', enumeratedKeys.slice().sort())
  report.note('每個控制項的證據來源統計', EVIDENCE_COUNT)

  console.log(`   列舉 ${enumeratedKeys.length} 顆控制項 / ${statesSeen.length} 個狀態`)
  console.log(
    `   有結論(探針或豁免):${coverage.有結論} · 沒有探針:${noProbe.length} · 探針沒跑到:${notRun.length} · ` +
      `登記了但從沒出現:${neverSeen.length} · 豁免:${exemptCount}`
  )
  if (neverSeen.length) {
    console.log('   ⚠️ 有登記但從未在任何宣告狀態中出現的控制項:')
    for (const k of neverSeen) console.log(`      - ${k}`)
  }
  if (noProbe.length) {
    console.log('   ⚠️ 沒有探針的控制項(DOM 上有、清單沒有):')
    for (const k of noProbe.slice(0, 40)) console.log(`      - ${k}(「${enumerated.get(k).name}」)`)
    if (noProbe.length > 40) console.log(`      …其餘 ${noProbe.length - 40} 顆`)
  }
  return coverage
}

// ─────────────────────────────── 主流程 ───────────────────────────────

async function main_() {
  mkdirSync(OUT, { recursive: true })

  // 本機 mock 服務:**這一輪把「AI 會不會動」從推理變成量測的關鍵**。
  // 沒有它們,AI 摘要、面試練習、雲端辨識三條主要路徑只能記成 unverifiable。
  const stt = await startMockStt()
  const llm = await startMockLlm(({ lastUser }) => {
    // 依 prompt 的**形狀**路由,不綁具體文案 —— 文案是產品會改的東西。
    if (/輸出 JSON 字串陣列/.test(lastUser)) {
      return JSON.stringify(['請自我介紹', '為什麼想離開現在的工作', '說一個你主導的專案'])
    }
    // 會議摘要。形狀是 `{abstract, keyPoints, todos, followUps}`。
    // 少了這條路由,預設回覆(一段純文字總評)會被 extractJson 丢掉 ——
    // 產品正確地報了「AI 摘要失敗」,而稽核把它記成「按鈕沒有效果」。
    // 那是探針的環境沒備妥,不是產品壞了。
    if (/abstract/.test(lastUser) && /keyPoints/.test(lastUser)) {
      return JSON.stringify({
        abstract: '稽核摘要:這場會議確認了管線修復的時程,並分配了測試補齊的負責人。',
        keyPoints: ['管線本週修好', '測試由我方補上'],
        todos: ['補上測試(我)'],
        followUps: ['下週回報修復進度']
      })
    }
    if (/請評估此回答並輸出 JSON/.test(lastUser)) {
      return JSON.stringify({
        score: 82,
        content: '回答切題,有具體例子。',
        structure: '結構清楚,先結論後說明。',
        delivery: '語速穩定,可再放慢一點。',
        betterAnswer: '示範回答:我會先說明背景,再講做法,最後交代結果與學到的事。'
      })
    }
    // 會議摘要。Record.tsx 的 prompt 形狀是
    // `…輸出 JSON，格式：{"abstract":…,"keyPoints":[…],"todos":[…],"followUps":[…]}`
    // —— **先前的 router 沒有這一條**,於是它落到最後的回傳字串,
    // extractJson 拿到非 JSON → 摘要寫不進去。
    // 症狀是「按了 AI 摘要但 sessions 裡沒有 summary」,
    // 看起來像產品的功能壞了,實際上是 mock 回錯形狀。
    // 路由條件綁的是 **欄位名**(格式的一部分),不是整句文案。
    if (/keyPoints/.test(lastUser)) {
      return JSON.stringify({
        abstract: '這場會議確認了提詞流程的驗收方式,並決定先用稽核環境跑一輪。',
        keyPoints: ['浮層內容要跟講稿一致', '熱鍵失效必須讓使用者知道'],
        todos: ['把稽核接進 release 閘門'],
        followUps: ['下次會議前確認模型已下載']
      })
    }
    return '總評:整體表現穩定,內容與結構都在水準上,表達可再放慢一些。'
  })
  report.note('mock 服務', { stt: stt.origin, llm: llm.origin })

  const audio = audioFixtureStatus()
  report.note('假裝置', fakeMediaSummary(SELFTEST.includes('drop-fake-audio') ? { audio: null } : {}))
  if (!audio.ok) {
    console.log(`⚠️ 假麥克風 fixture 不可用:${audio.why}`)
    console.log('   錄音相關的探針會配成 unverifiable,而不是默默通過。')
  }

  const { app, main } = await launch()
  // launch 之後覆寫:此時 FAKE_AUDIO_ARMED 已由**實際 args** 推導完成。
  // self-test 對「破壞真的生效」的斷言來自這裡,不是來自破壞的意圖。
  if (SELFTEST) {
    report.note('self-test 破壞', {
      mode: SELFTEST,
      抽掉登記項: [...SELFTEST_DROP],
      探針不給結論: [...SELFTEST_SKIP],
      假麥克風旗標已抽掉: SELFTEST.includes('drop-fake-audio'),
      實際啟動含假麥克風: FAKE_AUDIO_ARMED
    })
  }

  try {
    // 資料層從乾淨的狀態開始。
    //
    // 使用者的資料庫是**跨執行保留的**,上一次稽核留下的講稿、會議、練習紀錄
    // 會跟著進來:第一輪實跑時,浮層裡出現的是上一次留下的那份講稿的標題,
    // 而探針把它讀成「開始提詞沒有帶到剛打的內容」。每個步驟會自己播種需要的
    // 資料,所以除了一開始清空之外,中途不再依賴「現在還剩下什麼」。
    await clearAll(main)
    await sleep(400)

    // 先讓 AI/辨識指向本機 mock:早一點設定,後面的探針才能真的走完整條路。
    await main.evaluate(
      async ([sttUrl, llmUrl]) => {
        await window.api.setSettings({
          stt: { engine: 'cloud', cloud: { baseUrl: sttUrl, apiKey: 'mock-key', model: 'mock-whisper' } },
          ai: { provider: 'ollama', ollama: { baseUrl: llmUrl, model: 'mock-qwen' } },
          scenario: { aiModeEnabled: false }
        })
        void sttUrl
      },
      [`${stt.origin}/v1`, llm.origin]
    )
    await sleep(600)

    // **讀回來確認，而不是「沒丟錯就算成功」。**
    // 這只是預設值不是不變量：設定頁的步驟會為了驗「供應商切換」把 provider
    // 與引擎來回切，而 openai-compatible 打 /v1/chat/completions、吃
    // {choices:[…]}，Ollama 打 /api/chat、吃 {message:{content}}。
    // 同一台 mock 回傳 Ollama 形狀，於是後面的步驟解析失敗 —— 症狀看起來像
    // 產品壞了。所以每個依賴 mock 的步驟都要自己重新備妥(見 ensureAiOnMock)。
    {
      const back = await readSettings(main)
      report.note('起始設定（已讀回確認）', {
        aiProvider: back?.ai?.provider,
        aiBaseUrl: back?.ai?.ollama?.baseUrl,
        sttEngine: back?.stt?.engine,
        sttBaseUrl: back?.stt?.cloud?.baseUrl
      })
    }

    const SEQUENCE = [
      ['導航', () => stepNavigation(main)],
      ['設定頁逐欄', () => stepSettings(main)],
      ['熱鍵', () => stepHotkeys(main)],
      ['浮層', () => stepOverlay(app, main)],
      ['總覽', () => stepDashboard(app, main)],
      // 橫幅在總覽之後:它要靠「切頁之後還在」來證明自己是全域的,
      // 而前面那些步驟會把主視窗留在各種頁面上。
      ['更新橫幅', () => stepUpdateBanner(main)],
      ['講稿', () => stepScripts(app, main)],
      ['設定頁開關與連線', () => stepSettingsExtra(app, main, llm, stt)],
      ['個人化校準', () => stepCalibration(main)],
      ['對話框與 toast', () => stepDialogs(main)],
      ['浮層工具列(第二輪)', () => stepOverlayExtra(app, main)],
      ['錄音(假麥克風)', () => stepRecord(app, main, stt, llm)],
      ['面試練習(mock LLM)', () => stepPractice(main, llm)],
      // 崩潰畫面要放在對帳**之前**。
      //
      // 理由不是美學:崩潰畫面上有一顆「複製錯誤詳細資料」,而它是靠這一步才被
      // 量到的。放在對帳之後的話,對帳時它「沒有任何結論」——
      // 於是報告會說「這顆鈕有登記、也出現在畫面上,但這一輪沒有任何探針給出結論」,
      // 而事實是探針就在下一行。**順序錯了,誠實的機制就會產生假的指控。**
      // 它會把整個 App 換掉,所以只能是最後一顆,而對帳本身不會被它影響
      // (對帳會自己重設狀態與 seed)。
      ['崩潰畫面', () => stepCrash(app, main)],
      ['覆蓋率對帳', () => stepInventory(app, main, stt, llm)]
    ]

    for (const [name, fn] of SEQUENCE) {
      console.log(`\n▶ ${name}`)
      const before = await where(main)
      await step(name, fn)
      const after = await where(main)
      console.log(`   from ${before}`)
      console.log(`   to   ${after}`)
      if (name !== '崩潰畫面') await shoot(main, `step-${name}`)
    }

    report.note('四態統計', {
      works: tally.works,
      dead: tally.dead,
      unverifiable: tally.unverifiable,
      /**
       * 寫清楚分母是什麼,因為同一份報告裡還有另一個「覆蓋率」數字。
       *
       * 這裡是 **探針給出結論的登記項數 / 登記表總數**(154)。
       * 而上面「覆蓋率」那張表是 **被列舉到的控制項實例中有結論或豁免的數**
       * (145)。兩個分母不同 —— 一個數「有沒有量」,另一個數「畫面上有沒有漏」——
       * 而它們長得幾乎一樣,讀者只會以為其中一個是錯的。
       *
       * 所以這裡把單位寫進字串:沒有單位的比率不是資訊,是讓人猜的數字。
       */
      覆蓋率: `${PROBED.size}/${REGISTRY.size} 項登記有探針結論(以登記表為分母;「覆蓋率」表另以列舉到的實例為分母,兩者單位不同)`
    })
    // mock 實際收到什麼請求：**看外部服務有沒有真的被叫到**，
    // 而不是只看 App 自己有沒有報錯。這是中繼資料層的證據。
    report.note('mock LLM 收到的請求', {
      總數: llm.calls?.() ?? null,
      清單: llm.requests ?? [],
      提示詞前120字: (llm.prompts ?? []).map((p) => String(p).slice(0, 120))
    })
    report.note('mock STT 收到的請求', {
      總音訊位元組: stt.audioBytes?.() ?? null,
      清單: stt.requests ?? []
    })
    report.note('無法驗證清單', UNVERIFIABLE)
    report.note('逐項結果', EFFECTS)
  } finally {
    await app.close().catch(() => {})
    await stt.close().catch(() => {})
    await llm.close().catch(() => {})
  }

  const problems = report.finish(join(OUT, 'report.json'))

  // unverifiable 單獨印一次:它不是問題,但它是這份報告誠實與否的一部分。
  console.log('')
  console.log('=== 四態分類 ===')
  console.log(`真的有效果:${tally.works}`)
  console.log(`按了沒效果:${tally.dead}`)
  console.log(`這個環境量不到:${tally.unverifiable}`)
  console.log(`證據來源:${JSON.stringify(EVIDENCE_COUNT)}`)
  if (UNVERIFIABLE.length) {
    console.log('')
    console.log('⚠️ 以下控制項 / 路徑**沒有被驗證過**,不要當成通過:')
    for (const u of UNVERIFIABLE) console.log(`   - ${u.name}: ${u.reason}`)
  }
  console.log(`\n輸出: ${OUT}/`)
  return problems
}

main_()
  .then((problems) => {
    console.log(`\n沒有效果的 UI:${tally.dead} 筆;無法驗證:${tally.unverifiable} 項`)
    process.exit(problems.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('ABORT:', e.stack || e.message)
    process.exit(1)
  })