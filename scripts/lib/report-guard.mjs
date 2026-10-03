/**
 * report-guard.mjs —「被破壞的稽核報告」的備份／還原邏輯。
 *
 * ── 這件事為什麼值得一個獨立模組 ──
 *   audit:selftest 的做法是:把真的 report.json 改名成備份,帶著破壞跑一次
 *   audit:effects,然後把備份改名回去。
 *
 *   這個設計的前提是「一定會還原」。而原本只有 `try/finally` 保它 ——
 *   但 finally 只保得住**它自己察覺的**離開。實測踩過:執行被逾時砍掉之後,
 *   磁碟上留下的是備份,而 report.json 不見了。下一次 `npm run release`
 *   的 audit:effects 步驟會讀一份不存在的報告,而 release-gate 的分母是
 *   「報告裡有幾個狀態」—— 讀不到報告時那條規則的行為不等於「通過」。
 *
 *   抽成模組的理由和 corner-scan.test.mjs 一樣:這是量測層自己的保養邏輯,
 *   而量測層壞掉時不會有任何東西報錯。所以它需要能被直接驅動的測試。
 *
 * ── 三種中斷 ──
 *   1. 正常結束          → restoreReport()
 *   2. SIGINT / SIGTERM  → 同樣是 restoreReport(),由呼叫端掛 signal handler
 *   3. SIGKILL / 強制結束 → 物理上無法攔截。唯一能救的是**下一次執行**:
 *                          recoverLeftoverBackup() 會在開始破壞之前修復。
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs'

/**
 * 還原報告。可重入 —— signal handler 與 finally 都會呼叫它。
 *
 * @param {string} report 真的報告路徑
 * @param {string} backup 備份路徑
 * @param {boolean} hadReport 本次執行**開始前**有沒有報告
 * @param {(msg: string) => void} [log]
 * @returns {'restored' | 'empty-stamped' | 'nothing-to-do'}
 */
export function restoreReport(report, backup, hadReport, log = () => {}) {
  if (hadReport && existsSync(backup)) {
    renameSync(backup, report)
    log('已還原原本的 report.json')
    return 'restored'
  }
  if (!hadReport && existsSync(report)) {
    // 本來就沒有報告,被破壞的執行卻產出了一份:寫成空物件而不是留著它。
    // 留著一份空的 {} 與留一份被投毒的報告,在 release-gate 眼裡是同一件事:
    // 「狀態數 0」兩者都成立。而 {} 至少明確表達「沒有量到任何東西」。
    writeFileSync(report, '{}\n', 'utf8')
    return 'empty-stamped'
  }
  return 'nothing-to-do'
}

/**
 * 開頭的自我修復:上一次執行若被硬生生砍掉,磁碟上會留下備份而沒有報告。
 *
 * 順序很重要 —— 這個函式**必須**在呼叫端開始備份之前跑。反過來的話,
 * 殘留的備份會被當成「原本的報告」而再備份一次,把上一次的殘留鎖死在磁碟上。
 *
 * 目標已存在時直接 rename 就會覆蓋它(實測過:Node 的 renameSync 在 Windows 上
 * 走 MoveFileEx + REPLACE_EXISTING,不會因為目標存在而拋錯)。
 * 本來想先 rmSync 再 rename —— 寫完才發現那是多餘的,而多餘的防禦比沒有防禦
 * 更難 review:它看起來像在處理一個真實的失敗模式,於是沒有人會去驗它。
 *
 * @returns {boolean} 有沒有找到並修復殘留
 */
export function recoverLeftoverBackup(report, backup, log = () => {}) {
  if (!existsSync(backup)) return false
  log('偵測到上一次 self-test 的殘留備份,先還原…')
  renameSync(backup, report)
  log('已還原。')
  return true
}
