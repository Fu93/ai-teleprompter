/**
 * audit-all.mjs — 跑完六支 UI/UX 稽核並彙總結果。
 *
 * 為什麼不能用 `a && b && c`:
 *
 *   "audit": "npm run audit:ui && npm run audit:deep && …"
 *
 * `&&` 會短路。`audit:ui` 紅燈 → **後面五支一個都不跑**,artifacts 只有一份報告。
 * 而「其他五支的狀況」正是紅燈時最需要知道的資訊 —— 一支紅燈把另外五支藏起來,
 * 等於把你唯一的診斷工具收走。
 *
 * 這個專案已經被同一個陷阱咬過兩次,方向相反:
 *   1. P0-C 那一輪只跑了 audit:states,於是我自己加的「知道了」鈕(89×17)
 *      漏了三小時才被 audit:ui 抓到 —— 「稽核全綠」的前提是六支都跑過。
 *   2. 更早之前 audit-effects.mjs 有個孤兒 `}`,讓 Panic 之後的程式碼
 *      **從來沒有執行過**,於是連續三次報 0 筆。綠燈不是收斂,是程式碼沒跑。
 *
 * 兩次的教訓是同一句:**沒跑的稽核不能算通過。** 所以這裡寧可全部跑完再回報,
 * 也不短路 —— 紅燈的成本是多幾分鐘,短路的好處是零。
 *
 * 形狀比照 release-gate.mjs 的 STEPS(同一個 repo 裡已經有一份跑完不短路的示範),
 * 差別是這支只管稽核、不做 build / typecheck / e2e。
 *
 * 退出碼:任一支非 0 就整體非 0(擋 merge 用)。
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'

/** 六支稽核,順序 = 由快到慢(前面壞掉時能早點看到第一個訊號)。 */
const AUDITS = [
  { name: 'ui', script: 'audit:ui' },
  { name: 'edge', script: 'audit:edge' },
  { name: 'deep', script: 'audit:deep' },
  { name: 'journey', script: 'audit:journey' },
  { name: 'states', script: 'audit:states' },
  { name: 'effects', script: 'audit:effects' }
]

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(npm, args, { stdio: 'inherit', shell: isWin })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

const results = []
for (const { name, script } of AUDITS) {
  console.log(`\n${'━'.repeat(64)}\n▶ ${script}\n${'━'.repeat(64)}`)
  const started = Date.now()
  const code = await run(['run', script])
  results.push({ name, script, code, secs: Math.round((Date.now() - started) / 1000) })
}

const failed = results.filter((r) => r.code !== 0)

console.log(`\n${'━'.repeat(64)}\n六支稽核彙總\n${'━'.repeat(64)}`)
for (const r of results) {
  console.log(`${r.code === 0 ? '✓' : '✗'} ${r.script.padEnd(16)} ${r.code === 0 ? '' : `exit ${r.code}  `}${r.secs}s`)
}
console.log(
  failed.length === 0
    ? `\n${results.length} 支全過。這**不表示**沒問題 —— 只表示這 ${results.length} 支量到的都沒問題。`
    : // 這裡的字數是算出來的,不是寫死的。第一版寫死「其餘五支」,結果兩支紅燈時
      // 印出「2 支紅燈…其餘五支」—— 數字自己跟自己矛盾。這種錯誤別人一眼就看到。
      `\n${failed.length} 支紅燈:${failed.map((r) => r.name).join('、')}。` +
      `其餘 ${results.length - failed.length} 支照樣跑完了,報告都在 docs/audit/。`
)

process.exit(failed.length ? 1 : 0)