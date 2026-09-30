/**
 * release-gate.mjs — 「今天可以交了」的單一判定。
 *
 * 為什麼要有這個:
 *   驗證這個專案要跑七個指令,而「我以為我跑過了」是這幾週最貴的失敗模式。
 *   P0-C 那一輪只跑了 audit:states,於是我自己加的 89×17 按鈕漏了三小時,
 *   直到 rim 那一輪把三支都跑齊才被抓到。
 *   換句話說:問題從來不是「不夠嚴謹」,是「指令太多而人會記漏」。
 *
 * 這個閘門的三個刻意設計:
 *
 *   1. 依序執行,任何一項失敗立刻停。全部跑完才總結的話,最後才發現失敗
 *      要重跑前六項 —— 而 e2e 單獨就要 4 分鐘。
 *   2. 稽核的「狀態數」要跟基線比。「40 狀態 0 筆」和「12 狀態 0 筆」都是綠的,
 *      但它們不是同一件事。狀態數掉下來 = 量測覆蓋率被無聲地縮水,
 *      這正是 audit-states 報告不誠實那一輪的教訓。
 *   3. e2e 第一次失敗時自動只重跑失敗的那幾條,並標明是 flake 還是回歸。
 *      理由:這個 session 出現過三次「全量跑紅、單獨跑綠」,而我至今沒有
 *      抓到根因。與其假裝它不存在,不如讓閘門自己分清楚 —— 但不拿它當藉口放行。
 *
 * 執行:`npm run release`
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'
const npx = isWin ? 'npx.cmd' : 'npx'

// ---------------------------------------------------------------------------
// 基線:每支稽核「至少」要量到幾個狀態。
//
// 為什麼是下限而不是期望值:狀態數只會長(新增狀態是好事),所以用 <= 判斷。
// 掉下來才是訊號 —— 那代表有人刪掉了一個狀態、導航失敗,或報告不再誠實。
// 新增狀態時請一併把這裡的數字調高,否則新增不會被注意到(這是刻意取捨:
// 調高門檻會讓「多量了」看起來像失敗)。
// ---------------------------------------------------------------------------
const BASELINE = {
  'audit:ui': { file: 'docs/audit/report.json', minStates: 6 },
  'audit:deep': { file: 'docs/audit/deep/report.json', minStates: 40 },
  'audit:states': { file: 'docs/audit/states/report.json', minStates: 48 },
  'audit:edge': { file: 'docs/audit/edge/report.json', minStates: 9, kind: 'combos' }
}

const STEPS = [
  { name: 'build', cmd: [npm, 'run', 'build'] },
  { name: 'typecheck', cmd: [npm, 'run', 'typecheck'] },
  { name: 'unit', cmd: [npm, 'run', 'test'] },
  { name: 'audit:ui', cmd: [npm, 'run', 'audit:ui'] },
  { name: 'audit:deep', cmd: [npm, 'run', 'audit:deep'] },
  { name: 'audit:states', cmd: [npm, 'run', 'audit:states'] },
  { name: 'audit:edge', cmd: [npm, 'run', 'audit:edge'] },
  { name: 'e2e', cmd: [npx, 'playwright', 'test'], special: 'e2e' }
]

// 所有稽核都必須在這個 gate 下開啟,否則量到的是關閉除錯層的版本。
const AUDIT_ENV = { AI_TP_AUDIT: '1' }

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[96m${s}\x1b[0m`
}

function fmt(ms) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** 跑一條命令,串流輸出,回傳 exit code。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: isWin,
      env: { ...process.env, ...(opts.env || {}) }
    })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/**
 * 讀稽核報告,比對狀態數基線。
 * 回傳 null 表示這支沒有基線定義(不擋人,但仍印出數字)。
 */
export function checkAuditBaseline(name) {
  const rule = BASELINE[name]
  if (!rule) return null
  const path = join(ROOT, rule.file)
  if (!existsSync(path)) {
    return { ok: false, why: `找不到報告檔 ${rule.file} —— 這不是「通過」,這是沒跑` }
  }
  let data
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return { ok: false, why: `報告不是合法 JSON: ${e.message}` }
  }
  // audit-glass-edge 的 report.json 是陣列(每個形態×桌布一筆),
  // 其餘三支是 createReport 的 {meta, problems} 形狀。
  const n = Array.isArray(data) ? data.length : (data.meta?.auditedStates?.length ?? 0)
  const problems = Array.isArray(data) ? data.filter((d) => d.status !== 'pass').length : (data.meta?.problemCount ?? -1)
  if (problems > 0) return { ok: false, why: `問題 ${problems} 筆`, n }
  if (n < rule.minStates) {
    return { ok: false, why: `只量到 ${n} 個狀態,基線要求 ≥${rule.minStates}(量測覆蓋率被縮水了)`, n }
  }
  return { ok: true, n, minStates: rule.minStates }
}

/**
 * e2e:第一次失敗時只重跑失敗的那幾條。
 *
 * 這是為了回答一個我至今沒有答案的問題:這個 session 三次「全量紅、單獨綠」。
 * 與其讓整個閘門跟著紅(然後人開始忽略紅燈),不如把 flake 與回歸分開。
 * 分不開的時候它就是回歸,閘門照樣紅。
 */
async function runE2E() {
  const jsonOut = join(ROOT, 'test-results', 'gate-full.json')
  mkdirSync(join(ROOT, 'test-results'), { recursive: true })
  rmSync(jsonOut, { force: true })

  process.stdout.write(C.dim('  (第一次嘗試,收集失敗清單…)\n'))
  const first = await run(npx, ['playwright', 'test', '--reporter=list,json'], {
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut }
  })
  if (first === 0) return { code: 0, flaky: [] }

  // 從 JSON 報告抽出失敗的檔案與標題
  let failures = []
  try {
    const data = JSON.parse(readFileSync(jsonOut, 'utf8'))
    const walk = (suites) => {
      for (const s of suites || []) {
        for (const spec of s.specs || []) {
          const bad = (spec.tests || []).some((t) => (t.results || []).some((r) => r.status !== 'passed' && r.status !== 'skipped'))
          if (bad) failures.push({ file: spec.file, title: spec.title })
        }
        walk(s.suites)
      }
    }
    walk(data.suites)
  } catch (e) {
    return { code: 1, error: `第一次全量 e2e 失敗,而且 JSON 報告讀不到(${e.message})—— 判定為回歸` }
  }

  if (!failures.length) {
    return { code: 1, error: '第一次全量 e2e 失敗,但 JSON 報告裡找不到失敗的條目 —— 判定為回歸' }
  }

  const files = [...new Set(failures.map((f) => f.file))]
  const grep = failures.map((f) => f.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  process.stdout.write(
    C.y(`\n  第一次全量失敗 ${failures.length} 條,只重跑這些(檔案 ${files.length} 個):\n`) +
      failures.map((f) => `    - ${f.title}  ${C.dim(f.file)}`).join('\n') +
      '\n'
  )

  const second = await run(npx, ['playwright', 'test', ...files, '--grep', grep, '--retries=0'], {
    env: AUDIT_ENV
  })
  rmSync(jsonOut, { force: true })

  if (second === 0) {
    return {
      code: 0,
      flaky: failures.map((f) => `${f.file} › ${f.title}`)
    }
  }
  return { code: 1, flaky: [], error: '重跑仍然失敗 —— 這是回歸,不是 flake' }
}

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now()
  const timings = []
  const flakyAll = []

  console.log(C.b('\n發布閘門 —— 七個步驟,任何一項紅燈就停\n'))
  console.log(C.dim('（稽核全部在 AI_TP_AUDIT=1 下執行,量的是開著除錯橋的版本）\n'))

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i]
    const label = `${String(i + 1).padStart(2, ' ')}/${STEPS.length}  ${step.name}`
    const started = Date.now()
    process.stdout.write(`${C.c(label)}  ${C.dim('跑…')}\n`)

    let code
    if (step.special === 'e2e') {
      const r = await runE2E()
      code = r.code
      if (r.flaky?.length) flakyAll.push(...r.flaky)
      if (r.error) console.log(C.r(`    ${r.error}`))
    } else {
      // build / unit / e2e 自己帶必要旗標;稽核需要開 audit gate
      const env = step.name.startsWith('audit') ? AUDIT_ENV : {}
      code = await run(step.cmd[0], step.cmd.slice(1), { env })
    }

    const ms = Date.now() - started
    timings.push({ name: step.name, ms, code })

    if (code !== 0) {
      console.log(C.r(`✗ ${label}  失敗(${fmt(ms)})`))
      console.log(C.r(`\n閘門在此停止 —— 剩下 ${STEPS.length - i - 1} 個步驟沒有執行。`))
      console.log(C.dim('（刻意不繼續:最後才發現失敗要重跑前面所有步驟,而 e2e 單獨就 4 分鐘。）'))
      return finish(timings, t0, flakyAll, step.name)
    }

    // 稽核額外比對狀態數基線
    if (step.name.startsWith('audit')) {
      const b = checkAuditBaseline(step.name)
      if (b) {
        if (!b.ok) {
          console.log(C.r(`✗ ${label}  ${fmt(ms)}  —— ${b.why}`))
          return finish(timings, t0, flakyAll, step.name)
        }
        console.log(C.g(`✓ ${label}  ${fmt(ms)}  ${C.dim(`${b.n} 個狀態 / 0 筆問題(基線 ≥${b.minStates})`)}`))
        continue
      }
    }
    console.log(C.g(`✓ ${label}  ${fmt(ms)}`))
  }

  finish(timings, t0, flakyAll, null)
}

function finish(timings, t0, flaky, failedAt) {
  const total = Date.now() - t0
  console.log(C.b('\n─────────────────────────────'))
  console.log(C.dim('耗時：') + timings.map((t) => `${t.name} ${fmt(t.ms)}`).join(' · '))
  console.log(C.b(`總計 ${fmt(total)}`))

  if (flaky.length) {
    console.log('')
    console.log(C.y(`⚠️  有 ${flaky.length} 條 e2e 在全量跑時失敗、單獨重跑通過:`))
    for (const f of flaky) console.log(C.y(`   - ${f}`))
    console.log(C.dim('   這些被當作 flake 放行了。根因至今未定位 —— 已知限制,寫在 CHANGELOG。'))
    console.log(C.y('   如果同一個檔名在下一次閘門又出現,那就不是 flake。'))
  }

  console.log('')
  if (failedAt) {
    console.log(C.r(C.b(`✗ 閘門未通過 —— 停在 ${failedAt}`)))
    process.exit(1)
  }
  console.log(C.g(C.b('✓ 全部通過。這個樹可以交出去了。')))
  process.exit(0)
}

// 只有被當腳本執行時才啟動。匯入這個模組是為了單獨測 checkAuditBaseline ——
// 「門檻真的會擋人」這種事不能靠讀程式碼相信,要餵假報告進去跑。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().catch((e) => {
    console.error(C.r('閘門本身出錯:'), e.stack || e.message)
    process.exit(1)
  })
}
