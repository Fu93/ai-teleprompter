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
const node = process.execPath
// e2e 檔案清單的單一出處。原先這裡是 `playwright test`(全 20 支),
// 而 CI 跑的是 package.json 的 19 支 —— 兩者對「什麼算通過」有不同答案。
import { blockingArgs } from '../e2e/manifest.mjs'

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
  // 40 → 42(2026-10-02):貼鏡形態原本只量了 panic 一種暫態。turn-yield 與 coaching
  // 這兩條路徑都發生在 640×170 這個會被裁掉的視窗裡(turn-yield 會讓底部預讀行收起、
  // coaching 是這一版才補上的),沒有狀態就是沒量過。此輪決定:接受 42。
  // 42 → 43(2026-10-05):瞬時節奏讀數(P4)是**持續型** UI —— 每 2 秒心跳、
  // 使用者會照著它調整語速,而原本 45 個狀態裡沒有一個會說話,讀數在新 UI
  // 清單裡是隱形的。新增的 overlay/expanded@pace 走真 IPC 推逐字稿;
  // chip 必須整個在視窗內,而且與工具列的矩形不得重疊 —— 拖到展開態最小高度
  // (280x40)時,持續讀數會永久蓋住工具列(實測重疊 24px,已修:規則在
  // shared/overlayShapes.ts 的 paceReadoutFits)。
  'audit:deep': { file: 'docs/audit/deep/report.json', minStates: 43 },
  'audit:states': { file: 'docs/audit/states/report.json', minStates: 48 },
  'audit:edge': { file: 'docs/audit/edge/report.json', minStates: 9, kind: 'combos' },
  'audit:journey': { file: 'docs/audit/journey/report.json', minStates: 8 },
  /**
   * audit:effects 多一層「覆蓋率」門檻 —— 狀態數不夠形容它。
   *
   * 為什麼不能只看問題數:這支稽核的核心產物是「每一顆控制項都有結論」。
   * 一份「只跑了 12 顆控制項、0 筆問題」的報告會是綠的,但它比紅燈危險:
   * 它把「沒有量」寫成「沒有問題」。所以:
   *   minWorks    真的觀察到效果的控制項數量下限
   *   minControls 列舉到的控制項實例數下限
   *   maxExempt   豁免數上限(**只能持平或下降**)—— 豁免是債務,不是成就:
   *               新增豁免必須同時下調這個數字,否則它會變成第二個「永遠綠的檢查」
   */
  'audit:effects': {
    file: 'docs/audit/effects/report.json',
    // 145 → 148 → 149(2026-10-03 兩輪):第一輪新增宣告狀態 calibration/step1-rated
    // (step1 上「跳過語速量測」與「下一步」互斥渲染,不宣告的話其中一顆必定
    // 「登記了但從沒出現」);第二輪新增 update/banner(更新橫幅靠稽核橋
    // update.downloaded 排出來,否則這兩顆鈕永遠不被列舉),「稍後」補探針。
    // 每個數字都取自當輪實跑(149 狀態 / 150 控制項 / 147 works / 27 豁免),而非估算。
    minStates: 149,
    // 143 → 146 → 147:works 是「真的觀察到效果並附上證據來源」的控制項數。
    // 兩輪各 +1:calibration 的「跳過語速量測」(沒有量測也能進 step 2,是
    // 沒有麥克風/權限被拒者的出口;「再測一次」同批)與更新橫幅的「稍後」。
    minWorks: 147,
    // 145 → 148 → 150:與狀態數同步增長,差距拉大就是真的縮水了。
    minControls: 150,
    // 25 → 26 → 27(2026-10-03 兩輪,各 +1,理由都記在這裡):
    //   hotkeys|id:hotkey-conflict —— 只在真的有全域熱鍵被**其他程式**占用時
    //     才渲染,headless 無法在不「自己占用自己熱鍵」的前提下重現;
    //     其行為(導向設定頁)由 settings 頁的熱鍵下拉覆蓋。
    //   update|id:update-banner —— 按下去會 app.relaunch()+quit,等於終止稽核
    //     視窗本身(DESTRUCTIVE_WINDOW 家族);「橫幅會出現、而且在非設定頁」
    //     由 update-dismiss 那條一起量(橫幅沒渲染時那顆鈕按不到,同一個失效)。
    // 下一位要再 +1 時,必須在這裡寫下同樣等級的理由。
    maxExempt: 27
  }
}

/**
 * audit:effects 的額外門檻(覆蓋率對帳的結果)。
 * 回傳字串 = 不通過的理由;null = 通過。
 */
export function checkEffectsCoverage(data) {
  const cov = data?.meta?.notes?.['覆蓋率']
  if (!cov) return '報告裡沒有覆蓋率清單 —— 這不是「通過」,這是對帳沒有跑'
  const uncovered = cov['沒有探針'] ?? -1
  const notRun = cov['探針沒跑到'] ?? -1
  const neverSeen = cov['登記了但從沒出現']
  if (uncovered !== 0) {
    return `有 ${uncovered} 顆控制項出現在畫面上但沒有登記、也沒有豁免(新增 UI 時忘了登記)`
  }
  if (notRun !== 0) {
    return `有 ${notRun} 顆控制項有登記、但這一輪沒有任何探針給出結論(「沒量到」不等於「沒問題」)`
  }
  if (neverSeen !== undefined && neverSeen !== 0) {
    return (
      `有 ${neverSeen} 顆控制項登記了、但沒有任何被宣告的狀態裡出現過它 —— ` +
      '這種控制項不在報告裡(不是 0 筆,是沒有這一列),所以它必須讓閘門紅燈:' +
      '把狀態宣告齊,或把它標成豁免並寫下理由'
    )
  }
  return null
}

const STEPS = [
  { name: 'build', cmd: [npm, 'run', 'build'] },
  { name: 'lint', cmd: [npm, 'run', 'lint'] },
  { name: 'lint:baseline', cmd: [npm, 'run', 'lint:baseline'] },
  { name: 'typecheck', cmd: [npm, 'run', 'typecheck'] },
  // production 依賴漏洞 + 版本一致性。刻意不含 devDependencies 的漏洞:
  // electron-builder 鏈上的 high 目前沒有可用修復版本,設成紅燈只會讓這條
  // 規則永遠紅著(等於沒有規則)。理由見 scripts/lib/release-checks.mjs。
  { name: 'release-checks', cmd: [npm, 'run', 'release:checks'] },
  { name: 'unit', cmd: [npm, 'run', 'test'] },
  { name: 'audit:ui', cmd: [npm, 'run', 'audit:ui'] },
  { name: 'audit:deep', cmd: [npm, 'run', 'audit:deep'] },
  { name: 'audit:states', cmd: [npm, 'run', 'audit:states'] },
  { name: 'audit:edge', cmd: [npm, 'run', 'audit:edge'] },
  { name: 'audit:journey', cmd: [npm, 'run', 'audit:journey'] },
  { name: 'audit:effects', cmd: [npm, 'run', 'audit:effects'] },
  // e2e 走 run-e2e.mjs(讀 e2e/manifest.mjs),不是 npx playwright test。
  // 原先這裡是 `playwright test` = **全部** spec,比 CI 的封鎖清單多一支 ——
  // 本地閘門與 CI 對「什麼算通過」有不同答案,而沒有任何地方寫著這件事。
  // 那一支不是被刪掉,是移到 advisory:它仍然會跑,只是不擋 merge
  // (理由見 manifest.mjs 裡那一條)。
  { name: 'e2e', cmd: [node, 'scripts/run-e2e.mjs', 'blocking'], special: 'e2e' }
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
  // audit:effects 的覆蓋率門檻
  if (rule.maxExempt !== undefined || rule.minWorks !== undefined || rule.minControls !== undefined) {
    const cov = data.meta?.notes?.['覆蓋率'] ?? {}
    const four = data.meta?.notes?.['四態統計'] ?? {}
    const works = four.works ?? -1
    const controls = cov['控制項實例'] ?? -1
    const exempt = cov['豁免'] ?? -1
    if (rule.minControls !== undefined && controls < rule.minControls) {
      return { ok: false, why: `只列舉到 ${controls} 顆控制項實例,基線要求 ≥${rule.minControls}`, n }
    }
    if (rule.minWorks !== undefined && works < rule.minWorks) {
      return {
        ok: false,
        why: `只有 ${works} 顆控制項真的觀察到效果,基線要求 ≥${rule.minWorks}(量到的東西變少了)`,
        n
      }
    }
    if (rule.maxExempt !== undefined && exempt > rule.maxExempt) {
      return {
        ok: false,
        why: `豁免從 ${rule.maxExempt} 顆變成 ${exempt} 顆 —— 豁免是債務,只能持平或下降;新增豁免要同時下修基線數字`,
        n
      }
    }
    const covWhy = checkEffectsCoverage(data)
    if (covWhy) return { ok: false, why: covWhy, n }
  }
  return { ok: true, n, minStates: rule.minStates }
}

/**
 * 給人看的額外一行:稽核的「證明強度」摘要。
 *
 * 為什麼要印:這個 gate 的另一半價值是讓人看到數字在動 ——
 * 「134 顆有效果 / 101 顆有結論 / 24 顆豁免」與「12 顆 / 0 筆問題」
 * 在只看 ✓ 的時候長得一模一樣。
 */
export function extraSummary(name) {
  if (name !== 'audit:effects') return ''
  try {
    const f = join(ROOT, 'docs/audit/effects/report.json')
    if (!existsSync(f)) return ''
    const d = JSON.parse(readFileSync(f, 'utf8'))
    const four = d.meta?.notes?.['四態統計'] ?? {}
    const cov = d.meta?.notes?.['覆蓋率'] ?? {}
    return ` · 有效果 ${four.works ?? '?'} 顆 / 豁免 ${cov['豁免'] ?? '?'} 顆 / 環境量不到 ${four.unverifiable ?? '?'} 項`
  } catch {
    return ''
  }
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
  // 直接呼叫 playwright 而不是走 run-e2e.mjs:這裡需要拿到 JSON 報告來
  // 抽出失敗清單做「只重跑失敗的那幾支」。檔案清單仍然來自 manifest。
  const first = await run(npx, ['playwright', 'test', ...blockingArgs(), '--reporter=list,json'], {
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut }
  })
  if (first === 0) return { code: 0, flaky: [] }

  // 從 JSON 報告抽出失敗的檔案與標題
  const failures = []
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

  // 步驟數用動態計數:STEPS 增減時橫幅跟著變,不再出現「寫七個、跑十個」的漂移。
  console.log(C.b(`\n發布閘門 —— ${STEPS.length} 個步驟,任何一項紅燈就停\n`))
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
        console.log(C.g(`✓ ${label}  ${fmt(ms)}  ${C.dim(`${b.n} 個狀態 / 0 筆問題(基線 ≥${b.minStates})${extraSummary(step.name)}`)}`))
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
