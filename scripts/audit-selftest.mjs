/**
 * audit-selftest.mjs — 證明這支稽核**抓得住自己被弄壞**。
 *
 * ── 為什麼需要這支檔案 ──
 *
 * 這個專案裡每一個綠燈,到目前為止都是靠**手動把它弄壞、看它變紅**才敢相信的。
 * 這一則就做了三次:刪掉登記表的一筆(稽核沒紅 → 抓到 no-effect-probe 的洞)、
 * 把一條 e2e 斷言還原成原本的樣子(兩種版本都綠 → 刪掉它)、
 * 拿掉 sendTurnYield 的 isVisible(新測試紅在正確的那一步)。
 *
 * 三次都有效 —— 但**沒有一個在自動化裡**。所以:
 *   - CI 保護不了量測邏輯被改壞的那一次;
 *   - 下一個人看到一份綠燈報告,無從知道它的證明力是怎麼來的;
 *   - 「綠燈」與「綠燈但那支程式碼從來沒執行過」長得一模一樣 —— 這正是
 *     audit-effects.mjs 那個孤兒大括號讓連續三次報 0 筆的方式。
 *
 * ── 這支做什麼 ──
 *
 * 以子程序跑一次 audit:effects,帶著三種破壞,然後**斷言報告真的變紅**:
 *
 *   drop-registry:抽掉登記表的幾筆 → 必須出現 no-effect-probe
 *     對應到「刪掉一筆登記,稽核不會變紅」那個真的發生過的洞。
 *
 *   skip-probes:讓選定的探針不給任何結論 → 必須出現 probe-not-run
 *     與「某段量測程式碼從來沒執行過」的可觀察結果完全相同。
 *
 *   drop-fake-audio:抽掉假麥克風 WAV 旗標 → 錄音探針必須落進
 *     state-unreached(前置條件未備妥),而**不是**繼續綠或被記成 dead。
 *     對應計畫 6(d):靜音無法區分「收音壞了」與「沒人說話」—— 若量測端
 *     缺了前置還硬跑,燒完 24 秒輪詢後把一顆好按鈕記成 dead,等於把
 *     「環境缺前置」說謊成「產品壞了」;反過來,若探針對旗標缺席無感,
 *     它就是一顆對自己的前提不負責的綠燈。斷言兩頭:旗標真的沒掛上
 *     (meta 的「實際啟動含假麥克風」= false)且探針真的退場(state-unreached)。
 *
 * 三種破壞同時注入、一次執行(跑一次約 4-5 分鐘)。
 *
 * ⚠️ 破壞只動量測端,不碰產品、不需要重新建置 —— 所以它可以排在 CI 的
 * schedule 上(而不是每次 push),也可以在改完量測邏輯時手動跑一次。
 *
 * ── 這支自己也需要被懷疑 ──
 *
 * 一支「斷言稽核會變紅」的腳本,自己寫錯時會安靜地通過。所以:
 *   - 它斷言的是**報告裡出現了指定的問題種類**,不是「乾淨的執行是綠的」
 *     —— 前者與別人有沒有別的紅燈無關,所以不受工作樹現況影響;
 *   - 它必須把被破壞的執行產生的 report.json **還原**,否則磁碟上會留一份
 *     被投毒的報告,而那份報告看起來跟真的沒有兩樣。
 *
 * ── 還原這件事自己也會漏(實測踩過)──
 *   原本只有 `try/finally`。但 `finally` 只保得住**被它自己察覺的**離開:
 *   Ctrl-C、CI 的 job 逾時、執行環境的強制終止(SIGKILL)都不會跑到它。
 *   實際發生的樣子:self-test 跑到一半被逾時砍掉,磁碟上留下的是
 *   `report.selftest-backup.json`(還沒被還原的備份)而 **report.json 不見了** ——
 *   下一次 `npm run release` 的 audit:effects 步驟會讀到一份不存在的報告。
 *
 *   三道防線:
 *     1. signal handler:SIGINT / SIGTERM 走同一條還原路徑
 *     2. 子行程不留活口:self-test 被砍時要連 audit:effects 一起收掉,
 *        否則它還會在背景把被破壞的報告寫回來,蓋掉還原
 *     3. 開頭自我修復:偵測到上一次的殘留備份就先還原 ——
 *        處理 SIGKILL 這種**物理上無法攔截**的情況,以及手動 Ctrl-C 掉的行程
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import process from 'node:process'
import { recoverLeftoverBackup, restoreReport as restoreReportFile } from './lib/report-guard.mjs'

const REPORT = 'docs/audit/effects/report.json'
const BACKUP = 'docs/audit/effects/report.selftest-backup.json'
const isWin = process.platform === 'win32'
const node = isWin ? 'node.exe' : 'node'
const MODE = 'drop-registry,skip-probes,drop-fake-audio'

/** @type {import('node:child_process').ChildProcess | null} */
let runningChild = null

function runAudit() {
  return new Promise((resolve) => {
    const child = spawn(node, ['--no-warnings', 'scripts/audit-effects.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, AI_TP_SELFTEST: MODE }
    })
    runningChild = child
    child.on('close', (code) => {
      runningChild = null
      resolve(code ?? 1)
    })
    child.on('error', () => {
      runningChild = null
      resolve(1)
    })
  })
}

/**
 * 還原報告。可重入 —— signal handler 與 finally 都會呼叫它。
 * 實作在 scripts/lib/report-guard.mjs(那裡有測試直接驅動它)。
 */
function restoreReport(hadReport) {
  return restoreReportFile(REPORT, BACKUP, hadReport, (m) => console.log(`\n${m}`))
}

// 先修復,再開始破壞 —— 順序反過來的話,殘留的備份會被當成「原本的報告」而再備份一次。
if (recoverLeftoverBackup(REPORT, BACKUP, (m) => console.log(m))) console.log()

console.log('self-test:帶著破壞跑一次 audit:effects…')
console.log(`(破壞模式 ${MODE};報告會先備份再還原)\n`)

const hadReport = existsSync(REPORT)
if (hadReport) renameSync(REPORT, BACKUP)

/**
 * signal handler:被中斷時走**同一條**還原路徑,然後以非 0 結束。
 *
 * 為什麼要順便殺掉子行程:self-test 被砍掉時 audit:effects 還活著,
 * 它結束後會把被破壞的報告寫回 REPORT —— 那就覆蓋掉我們剛還原的東西了。
 * 這是「還原了但還是被蓋掉」那種看起來已經處理好的情況。
 */
let interrupted = false
const onSignal = (signal) => {
  if (interrupted) return
  interrupted = true
  console.error(`\nself-test 收到 ${signal},正在還原報告…`)
  try {
    if (runningChild && typeof runningChild.kill === 'function') runningChild.kill('SIGTERM')
  } catch {
    /* 子行程可能已經結束 */
  }
  try {
    restoreReport(hadReport)
  } catch (err) {
    console.error(`還原失敗:${err.message}(備份仍在 ${BACKUP},手動 rename 回去即可)`)
  }
  process.exit(1)
}
process.on('SIGINT', () => onSignal('SIGINT'))
process.on('SIGTERM', () => onSignal('SIGTERM'))

let exitCode = 0
try {
  const auditExit = await runAudit()
  console.log(`\nself-test:稽核結束,exit=${auditExit}(被破壞的執行本來就該非 0)\n`)

  if (!existsSync(REPORT)) throw new Error('被破壞的執行沒有產出報告 —— self-test 無法判斷')
  const r = JSON.parse(readFileSync(REPORT, 'utf8'))
  const problems = r.problems ?? []
  const sabotage = r.meta?.notes?.['self-test 破壞']

  if (!sabotage) {
    throw new Error('報告裡沒有 self-test 破壞紀錄 —— 稽核端與 self-test 已經脫節')
  }

  const byKind = (kind) => problems.filter((p) => p.kind === kind)
  const mentions = (list, keys) =>
    list.filter((p) => keys.some((k) => String(p.text).includes(k)))

  // 檢查一:抽掉登記項必須被抓到
  const dropped = sabotage['抽掉登記項'] ?? []
  const noProbe = mentions(byKind('no-effect-probe'), dropped)
  const missed = (keys, list) => keys.filter((k) => !list.some((p) => String(p.text).includes(k)))
  // 報「抓到幾筆」不夠 —— 要報**哪些沒抓到**。只印 9/11 的話,
  // 讀的人無從判斷那 2 筆是「閘門有盲區」還是「那兩顆本來就量不到」。
  const check1 =
    dropped.length > 0 &&
    noProbe.length > 0
  console.log(`${check1 ? '✓' : '✗'} 檢查一(抽掉登記項 → 紅燈): 抽掉 ${dropped.length} 筆 → 抓到 ${noProbe.length} 筆 no-effect-probe`)
  const miss1 = missed(dropped, byKind('no-effect-probe'))
  if (miss1.length) console.log(`    沒被當成 no-effect-probe 的:${JSON.stringify(miss1)}`)
  if (!check1) exitCode = 1

  // 檢查二:探針不給結論必須被抓到
  const skipped = sabotage['探針不給結論'] ?? []
  const notRun = mentions(byKind('probe-not-run'), skipped)
  const check2 =
    skipped.length > 0 &&
    notRun.length > 0
  console.log(`${check2 ? '✓' : '✗'} 檢查二(探針不給結論 → 紅燈): 讓 ${skipped.length} 顆不給結論 → 抓到 ${notRun.length} 筆 probe-not-run`)
  const miss2 = missed(skipped, byKind('probe-not-run'))
  if (miss2.length) {
    console.log(`    沒被當成 probe-not-run 的:${JSON.stringify(miss2)}`)
    console.log('    (不一定是盲區:同一顆控制項若被 probe() 量兩次(例如展開/收合各一次),' +
     '停掉其中一次仍會留下另一個結論 —— 而那個結論本來就是真的。' +
     '判斷方式是看它們最後落在 kinds 裡的哪一種。)')
  }
  if (!check2) exitCode = 1

  // 檢查三:假麥克風旗標被抽掉時,錄音探針必須誠實退場(計畫 6(d))
  //
  // 斷言兩頭:
  //   a) 破壞真的生效 —— meta 的「實際啟動含假麥克風」必須是 false。
  //      這個值由 audit-effects 從**實際啟動 args** 推導;若某次重構讓
  //      破壞不再生效(旗標又被掛回來),這裡會紅,而不是讓整個檢查空轉。
  //   b) 探針真的退場 —— `record|button|開始聆聽` 必須以 state-unreached
  //      出現在問題清單,且理由是「假麥克風未掛上」。若它繼續 works,
  //      就不會有 unreached 紀錄,檢查會紅;若它被記成 dead(環境缺前置
  //      誤報成產品缺陷),同樣不會是 unreached,檢查也會紅。
  const audioDropIntent = sabotage['假麥克風旗標已抽掉'] === true
  const audioDropEffective = sabotage['實際啟動含假麥克風'] === false
  const recordRetreat = problems.filter(
    (p) =>
      p.kind === 'state-unreached' &&
      String(p.page).includes('開始聆聽') &&
      String(p.text).includes('假麥克風')
  )
  const check3 = audioDropIntent && audioDropEffective && recordRetreat.length > 0
  console.log(
    `${check3 ? '✓' : '✗'} 檢查三(抽掉假麥克風 → 錄音探針退場): ` +
      `意圖=${audioDropIntent} 實際生效=${audioDropEffective} → 抓到 ${recordRetreat.length} 筆 state-unreached`
  )
  if (!check3) {
    console.log(
      '    期望:meta.實際啟動含假麥克風=false,且 report|button|開始聆聽 以 state-unreached 出現' +
        '(理由含「假麥克風未掛上」)。works 或 dead 都算失敗 —— 前者是對前提不負責的綠燈,' +
        '後者是把量測端缺前置誤報成產品缺陷。'
    )
  }
  if (!check3) exitCode = 1

  console.log(
    '\n' +
      (exitCode === 0
        ? '閘門抓得住自己被弄壞 —— 這份報告的綠燈才有證明力。'
        : '**閘門抓不住上面某一種破壞。** 這代表它對那種失敗是盲的,\n' +
            '而那份「0 筆問題」的綠燈正是靠這種盲區撐出來的。')
  )
  console.log('(問題總數不作為判斷依據 —— 工作樹裡別人的紅燈與這三項無關)')
  console.log(`完整問題清單:${JSON.stringify(problems.map((p) => p.kind))}`)
} catch (err) {
  console.error('self-test 失敗:', err.message)
  exitCode = 1
} finally {
  // 一定要還原:磁碟上留一份被投毒的報告,比沒有報告更糟。
  // 走同一個 helper(而不是各寫一份)—— 兩份實作遲早會分歧,
  // 而分歧的那一份不會被任何測試發現。
  if (!interrupted) {
    try {
      restoreReport(hadReport)
    } catch (err) {
      console.error(`還原失敗:${err.message}(備份仍在 ${BACKUP},手動 rename 回去即可)`)
      exitCode = 1
    }
  }
}

process.exit(exitCode)
