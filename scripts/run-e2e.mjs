/**
 * run-e2e.mjs — 依 e2e/manifest.mjs 跑 e2e。
 *
 * 為什麼需要這支而不是讓 package.json 直接列出檔名:
 *   探索時發現「e2e 要跑哪些」有三份互相獨立的定義(package.json 的
 *   test:e2e、test:all、release-gate 的 STEPS),而本地閘門比 CI 多擋一支。
 *   把清單集中到 e2e/manifest.mjs 之後,**所有執行者都必須從那裡讀** ——
 *   否則只是把一份漂移換成另一份。
 *
 * 用法:
 *   node scripts/run-e2e.mjs            # blocking 套件(擋 merge)
 *   node scripts/run-e2e.mjs advisory   # 非阻塞套件(仍然產生報告)
 *   node scripts/run-e2e.mjs all        # 兩份都跑
 *
 * ── 為什麼 advisory 也要跑,而且一定留下報告 ──
 *   它們是時序敏感的,擋 merge 只會讓人開始忽略紅燈。但「跑了但紅」與
 *   「沒跑」必須在報告上可分辨 —— 所以這支不管跑哪一組都用 JSON reporter
 *   把報告寫進 test-results/,讓 CI 一定上傳得到。
 *   用 PLAYWRIGHT_JSON_OUTPUT_NAME 而非 --output:那是 Playwright 對
 *   JSON reporter 的正式介面(release-gate.mjs 已經在用同一招)。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { blockingArgs, advisoryArgs } from '../e2e/manifest.mjs'

const isWin = process.platform === 'win32'
const npx = isWin ? 'npx.cmd' : 'npx'
const ROOT = process.cwd()

const mode = process.argv[2] ?? 'blocking'
if (!['blocking', 'advisory', 'all'].includes(mode)) {
  console.error(`未知的模式:${mode}(可用:blocking / advisory / all)`)
  process.exit(2)
}
const groups = mode === 'all' ? ['blocking', 'advisory'] : [mode]

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(npx, args, { cwd: ROOT, stdio: 'inherit', shell: isWin, env: { ...process.env, ...env } })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

mkdirSync(join(ROOT, 'test-results'), { recursive: true })

let blockingFailed = false
for (const g of groups) {
  const files = g === 'blocking' ? blockingArgs() : advisoryArgs()
  const jsonOut = join(ROOT, 'test-results', `e2e-${g}.json`)
  console.log(`\n▶ e2e ${g}(${files.length} 支)\n`)
  const code = await run(['playwright', 'test', ...files, '--reporter=list,json'], {
    PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut
  })
  if (g === 'blocking' && code !== 0) blockingFailed = true
  if (g === 'advisory' && code !== 0) {
    // 明確說出「這是刻意的」:CI 畫面上看到 advisory 紅燈的人需要知道
    // 那是分類出來的結果,不是漏掉的綠燈。
    console.log(`\n⚠️  advisory 套件有失敗(不擋 merge,這是它的用途)。報告:${jsonOut}`)
  }
}

process.exit(blockingFailed ? 1 : 0)