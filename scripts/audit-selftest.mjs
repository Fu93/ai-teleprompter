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
 * 以子程序跑一次 audit:effects,帶著兩種破壞,然後**斷言報告真的變紅**:
 *
 *   drop-registry:抽掉登記表的幾筆 → 必須出現 no-effect-probe
 *     對應到「刪掉一筆登記,稽核不會變紅」那個真的發生過的洞。
 *
 *   skip-probes:讓選定的探針不給任何結論 → 必須出現 probe-not-run
 *     與「某段量測程式碼從來沒執行過」的可觀察結果完全相同。
 *
 * 兩種破壞同時注入、一次執行(跑一次約 4-5 分鐘)。
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
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const REPORT = 'docs/audit/effects/report.json'
const BACKUP = 'docs/audit/effects/report.selftest-backup.json'
const isWin = process.platform === 'win32'
const node = isWin ? 'node.exe' : 'node'
const MODE = 'drop-registry,skip-probes'

function runAudit() {
  return new Promise((resolve) => {
    const child = spawn(node, ['--no-warnings', 'scripts/audit-effects.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, AI_TP_SELFTEST: MODE }
    })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

console.log('self-test:帶著破壞跑一次 audit:effects…')
console.log(`(破壞模式 ${MODE};報告會先備份再還原)\n`)

const hadReport = existsSync(REPORT)
if (hadReport) renameSync(REPORT, BACKUP)

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

  console.log(
    '\n' +
      (exitCode === 0
        ? '閘門抓得住自己被弄壞 —— 這份報告的綠燈才有證明力。'
        : '**閘門抓不住上面某一種破壞。** 這代表它對那種失敗是盲的,\n' +
            '而那份「0 筆問題」的綠燈正是靠這種盲區撐出來的。')
  )
  console.log('(問題總數不作為判斷依據 —— 工作樹裡別人的紅燈與這兩項無關)')
  console.log(`完整問題清單:${JSON.stringify(problems.map((p) => p.kind))}`)
} catch (err) {
  console.error('self-test 失敗:', err.message)
  exitCode = 1
} finally {
  // 一定要還原:磁碟上留一份被投毒的報告,比沒有報告更糟。
  if (hadReport && existsSync(BACKUP)) {
    renameSync(BACKUP, REPORT)
    console.log('\n已還原原本的 report.json')
  } else if (!hadReport && existsSync(REPORT)) {
    writeFileSync(REPORT, '{}\n', 'utf8')
  }
}

process.exit(exitCode)
