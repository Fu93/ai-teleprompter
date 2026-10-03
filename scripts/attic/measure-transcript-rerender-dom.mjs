/**
 * 量測「每新增一段逐字稿,整份列表重繪」的**瀏覽器真實成本**。
 *
 * 為什麼要兩個量測(這個 + measure-transcript-rerender.mjs):
 *   measure-transcript-rerender.mjs 用 renderToString,量到的是 React 建立
 *   element 的成本 —— 它**完全不含**瀏覽器的 style recalc 與 layout。而 N 列 DOM
 *   的排版成本很可能才是主角。只看 SSR 數字就宣稱「不痛」是不負責任的。
 *   這支用 Electron 的 Chromium(使用者真正在跑的環境)量 append + 重排 + 排版。
 *
 * 執行:npx electron scripts/attic/transcript-bench-main.cjs
 *      (實際入口是 measure-transcript-rerender-dom.mjs,它負責把結果印成人話)
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mainJs = join(here, 'transcript-bench-main.cjs')

const electron = process.platform === 'win32'
  ? join(here, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  : null

const child = spawn(electron ?? 'electron', [mainJs], { stdio: ['ignore', 'pipe', 'pipe'] })

let buf = ''
const rows = await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => {
    buf += d.toString()
    const i = buf.indexOf('__RESULT__')
    if (i !== -1) {
      const line = buf.slice(i).split('\n')[0].slice('__RESULT__'.length)
      resolve(JSON.parse(line))
    }
  })
  child.stderr.on('data', (d) => process.stderr.write(d))
  child.on('error', reject)
  child.on('exit', (code) => { if (!buf.includes('__RESULT__')) reject(new Error('量測主程式沒有回報結果,exit=' + code)) })
})

console.log('在 Electron 的 Chromium 裡量:每新增一段的 DOM 成本(含 style recalc + layout)')
console.log('含重新排序 —— 現況的列表確實會被重排(ASR 回來順序 ≠ 語音順序)')
console.log('段落數 |  新增+重排耗時(中位數)')
console.log('------|------------------------')
for (const r of rows) {
  console.log(String(r.n).padStart(6), '|', r.ms.toFixed(2).padStart(18), 'ms')
}

const base = rows[0].ms
console.log('\n相對 50 段的倍數(純線性會是 4 / 10 / 20 / 40):')
for (const r of rows.slice(1)) {
  const expected = r.n / rows[0].n
  const actual = r.ms / base
  console.log(
    String(r.n).padStart(5),
    '→',
    actual.toFixed(1).padStart(6),
    '倍 (線性預期',
    expected.toFixed(0).padStart(3),
    ')',
    actual < expected * 1.3 ? '≈ 線性' : '★ 超線性'
  )
}

const worst = rows[rows.length - 1]
const realistic = rows.find((r) => r.n === 500)
console.log(`\n500 段(約 2.5 小時的會議):每回來一段 ${realistic.ms.toFixed(1)}ms`)
console.log(`2000 段(約 10 小時的會議):每回來一段 ${worst.ms.toFixed(1)}ms`)
console.log(
  worst.ms < 16.7
    ? `結論:最壞情況也在一影格(16.7ms)之內 —— 使用者不會感覺到卡頓。`
    : `結論:最壞情況超過一影格 ${(worst.ms / 16.7).toFixed(1)} 倍,值得處理。`
)
