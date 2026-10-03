/**
 * release-checks.mjs — 發布前檢查的 CLI 薄殼。
 *
 * 規則在 scripts/lib/release-checks.mjs(純函式、可單元測試);這裡只負責
 * 「把真實世界的檔案與 npm 的輸出餵進去,然後把結果講成人話」。
 *
 * 退出碼:有任何問題 = 1,全部通過 = 0。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeProdAudit, checkVersionConsistency } from './lib/release-checks.mjs'

const ROOT = process.cwd()
const problems = []

// ── 1. production 依賴的漏洞 ──
// --omit=dev 是刻意的:devDependencies 的漏洞不會被塞進使用者拿到的 App。
// (目前 electron-builder 鏈上有 7 個 high,無可用修復版本 → 不設成紅燈,
//  理由見 scripts/lib/release-checks.mjs 的檔頭。)
const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  cwd: ROOT,
  encoding: 'utf-8',
  shell: process.platform === 'win32'
})
let prod = { total: 0, names: [] }
if (audit.status !== 0 && !audit.stdout) {
  problems.push(`npm audit 執行失敗(離線?):${(audit.stderr || '').split('\n')[0]}`)
} else {
  try {
    prod = summarizeProdAudit(JSON.parse(audit.stdout))
  } catch {
    problems.push('npm audit 的輸出不是 JSON,無法判斷 production 依賴是否安全')
  }
  if (prod.total > 0) {
    problems.push(`production 依賴有 ${prod.total} 個已知漏洞:${prod.names.join(', ')}`)
  }
}

// ── 2. 版本一致性 ──
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf-8')
problems.push(...checkVersionConsistency(pkg.version, changelog))

if (problems.length > 0) {
  console.error('\n發布前檢查未通過:')
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error('')
  process.exit(1)
}
console.log(
  `發布前檢查通過:production 依賴 0 個已知漏洞、版本一致(${pkg.version})\n` +
    '  (devDependencies 目前有已知漏洞的工具鏈依賴,不會進到使用者端 —— 見 scripts/lib/release-checks.mjs)'
)