/**
 * release-checks.mjs — 發布前的兩條「沒有任何東西在守」的不變量。
 *
 * ── 為什麼是這兩條 ──
 *   1. **production 依賴的漏洞**。`npm audit` 現在回 7 個 high,但全部在
 *      devDependencies(electron-builder 與它的傳遞依賴:get / app-builder-lib /
 *      dmg-builder / cacheable-request / http-cache-semantics)。這些是**打包工具鏈**,
 *      不會被塞進使用者拿到的 App 裡 —— 而 `npm audit --omit=dev` 是 0。
 *      既然 production 現在是乾淨的,「保持乾淨」就該是一條會紅的規則,而不是
 *      運氣。沒有這條的話,某天有人把有漏洞的 runtime 依賴加進來,唯一會發現的
 *      方式是「使用者回報」(而我們沒有崩潰回報系統)。
 *      刻意**不**把 devDependencies 的 7 個 high 設成紅燈:electron-builder 已是
 *      最新版(26.15.3),npm 也沒有對應的修復版本 —— 把它設成紅燈只會讓這條規則
 *      永遠紅著,等於沒有規則。
 *
 *   2. **版本一致性**。package.json 的版本與 CHANGELOG 最新「已發布」段落必須
 *      一致,而且那一段必須帶日期。原因是:這兩份檔案是各自維護的,沒有任何工具
 *      比對過它們。「改了版本卻沒寫更新日誌」在報告上與「改了兩份但寫錯版本號」
 *      長得一模一樣 —— 使用者拿到 0.2.1,CHANGELOG 卻寫 0.2.0。
 *
 * 兩個函式都是純函式,CLI 只是薄殼:規則本身必須能被單元測試釘住,而不是只能靠
 * 「真的發布一次看看會不會紅」。
 */

/**
 * 從 `npm audit --omit=dev --json` 的輸出挑出 production 依賴的漏洞。
 *
 * 回傳 names 是**安裝進使用者 App 的依賴名稱**;依賴名稱為空或含 workspace 標記
 * 時也照原樣回傳,因為那正是最需要人看一眼的情況。
 */
export function summarizeProdAudit(auditJson) {
  const vs = auditJson && typeof auditJson === 'object' ? auditJson.vulnerabilities : null
  if (!vs || typeof vs !== 'object') return { total: 0, names: [], severity: {} }
  const severity = {}
  const names = []
  for (const [name, info] of Object.entries(vs)) {
    const sev = typeof info?.severity === 'string' ? info.severity : 'unknown'
    severity[sev] = (severity[sev] ?? 0) + 1
    names.push(name)
  }
  return { total: names.length, names: names.sort(), severity }
}

/**
 * 比對 package.json 的版本與 CHANGELOG 最新「已發布」段落。
 *
 * 規則只有三條,每一條都對應一個真實會發生的事故:
 *   - CHANGELOG 至少要有一個已發布段落(只有 [Unreleased] = 還沒發過任何一版)
 *   - package.json 版本 == 最新已發布段落
 *   - 最新已發布段落要帶日期(缺日期 = 沒人真的寫過發布時間)
 *
 * 回傳問題清單(空陣列 = 通過);訊息是給人看的,直接印在閘門輸出上。
 */
export function checkVersionConsistency(pkgVersion, changelog) {
  const problems = []
  const text = typeof changelog === 'string' ? changelog : ''
  // 只抓標題行,避免正文裡的「## [0.1.0]」之類被當成版本
  const headings = [...text.matchAll(/^## \[([^\]]+)\](.*)$/gm)].map((m) => ({
    version: m[1],
    rest: m[2] ?? ''
  }))
  const released = headings.filter((h) => h.version !== 'Unreleased')
  if (released.length === 0) {
    problems.push('CHANGELOG.md 只有 [Unreleased],沒有任何已發布版本段落')
    return problems
  }
  const latest = released[0]
  if (pkgVersion !== latest.version) {
    problems.push(
      `版本不一致:package.json 是 ${pkgVersion},CHANGELOG 最新已發布段落是 [${latest.version}]`
    )
  }
  if (!/-\s*\d{4}-\d{2}-\d{2}/.test(latest.rest)) {
    problems.push(`CHANGELOG 的 [${latest.version}] 沒有日期(應為「## [${latest.version}] - YYYY-MM-DD」)`)
  }
  return problems
}