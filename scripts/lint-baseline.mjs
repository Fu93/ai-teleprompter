/**
 * lint-baseline.mjs — 讓「先有 lint,再慢慢修」不變成「先有例外,再永遠不修」
 *
 * ── 為什麼需要這個檔案 ──
 * 這個專案在加 lint 之前就累積了 warning:`any` 集中在 e2e 測試(evaluate 進頁面
 * 之後本來就沒有可用的型別),hooks 依賴集中在浮層的即時跟讀(那幾個 effect
 * 刻意只跑一次)。一次把它們全修掉不是選項 —— 那會把一次「導入品質工具」變成
 * 一次大規模改寫,而 review 的人無從分辨哪一行是為了修 lint、哪一行是為了修行為。
 *
 * 但也不能就這樣不管:warning 清單只會**單向增長**才有意義。
 *
 * ── 這個檔案是什麼 ──
 * 它是每條規則的**現況筆數**,而且是**上限**。比較是單向的:
 *   - 少於 baseline → 通過(而且應該順手把 baseline 調低)
 *   - 等於 baseline → 通過
 *   - 多於 baseline → 紅燈,並指出是哪些規則多了
 *
 * 注意 error 完全不在這裡:error 是當場紅燈的(見 eslint.config.mjs)。
 * 這份 baseline **只管 warning**。
 *
 * ── 為什麼只按規則彙總,不逐行記錄 ──
 * 逐行記錄(每個檔案每行一筆)聽起來更嚴,但它壞在:只要有人在上游加一行程式碼,
 * 整份 baseline 的行號就全部位移,於是「少了一筆」的訊號會變成幾十筆「位置變了」
 * 的雜訊。那種檔案三個月後就沒有人會看,紅燈也就失效了。
 * 按規則計數犧牲了「是哪一行」,換來的是**這個數字真的會被信任**。
 */
import { spawnSync } from 'child_process'
import { readFileSync, realpathSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BASELINE_PATH = join(ROOT, 'eslint-baseline.json')

/** 讀 baseline。檔案不存在時回空物件 —— 呼叫端會把它視為「上限 0」。 */
export function loadBaseline(path = BASELINE_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 比較「這次量到的」與「baseline 允許的」。
 *
 * 回傳的是**超出上限的規則**,不是全部差異 —— 紅燈訊息要能直接指出要修哪一條,
 * 而不是丟一份 22 行的清單給人自己比對。
 */
export function exceedances(actual, baseline) {
  // 底線檔用 `_` 前綴放說明文字(為什麼是這些數字)。那些鍵不是規則名稱,
  // 把它們當上限會讓「說明有五行」變成「有五條規則的現況是 undefined」。
  const caps = Object.fromEntries(Object.entries(baseline).filter(([rule]) => !rule.startsWith('_')))
  const rules = new Set([...Object.keys(actual), ...Object.keys(caps)])
  const out = []
  for (const rule of [...rules].sort()) {
    const got = actual[rule] ?? 0
    const cap = caps[rule] ?? 0
    if (got > cap) out.push({ rule, got, cap })
  }
  return out
}

/** 上限加總(排除說明鍵),用於「現況 vs 上限」那行輸出。 */
export function capTotal(baseline) {
  return Object.entries(baseline)
    .filter(([rule]) => !rule.startsWith('_'))
    .reduce((a, [, n]) => a + n, 0)
}

/** 跑 eslint(不要自己看 stdout,格式會變),把結果收斂成 { 規則: 筆數 }。 */
export function countWarnings(eslintPath, cwd = ROOT) {
  const res = spawnSync(process.execPath, [eslintPath, '.', '--format', 'json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  // eslint 在有 error 時也是 exit 1,那是它的工作而不是這支腳本的失敗。
  // 只有「連報告都產不出來」(例如設定本身壞掉)才是真的失敗。
  if (!res.stdout) {
    throw new Error(`eslint 沒有產出報告(exit ${res.status}):\n${res.stderr || '(無 stderr)'}`)
  }
  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch (err) {
    throw new Error(`eslint 的 JSON 報告無法解析: ${err.message}`)
  }
  const counts = {}
  for (const file of parsed) {
    for (const m of file.messages) {
      if (m.severity !== 1) continue // 只算 warning;error 已經在 lint 階段擋掉了
      const rule = m.ruleId ?? '(directive)'
      counts[rule] = (counts[rule] ?? 0) + 1
    }
  }
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }
}

function main() {
  const eslintPath = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
  const { counts, total } = countWarnings(eslintPath, ROOT)
  const baseline = loadBaseline()
  const over = exceedances(counts, baseline)

  const lines = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, n]) => `    ${String(n).padStart(3)}  ${rule}`)

  console.log(`lint: ${total} 筆 warning(上限 ${capTotal(baseline)} 筆)`)
  if (lines.length) console.log(lines.join('\n'))

  if (over.length === 0) {
    console.log('  ✓ 沒有任何一條規則超過 baseline。')
    // 少於 baseline 時提示:baseline 該往下調,否則它會慢慢失真。
    const slack = Object.keys(baseline)
      .filter((r) => !r.startsWith('_') && (counts[r] ?? 0) < baseline[r])
      .map((r) => `${r}(${counts[r] ?? 0} < ${baseline[r]})`)
    if (slack.length) {
      console.log(`  ⚠ 低於 baseline:${slack.join(', ')}`)
      console.log('    → 請把 eslint-baseline.json 的上限調成現況,讓上限永遠等於現況。')
    }
    return 0
  }

  console.error('')
  console.error('✗ 有規則超過 baseline 上限:')
  for (const { rule, got, cap } of over) console.error(`    ${rule}: ${got} > ${cap}(多了 ${got - cap} 筆)`)
  console.error('')
  console.error('  兩種處理方式,選一種:')
  console.error('    1. 修掉它們(首選)。')
  console.error('    2. 確認是合理的既有狀況,然後把 eslint-baseline.json 的上限調高 ——')
  console.error('       並且在 CHANGELOG 寫下為什麼它可以留著。')
  console.error(`  (檔案:${relative(process.cwd(), BASELINE_PATH)})`)
  return 1
}

// 當作模組被匯入時(e.g. 測試)不要執行。
// 用 realpath 後比對:直接比對 `file://${process.argv[1]}` 在 Windows 上不成立
// —— 那邊是 file:///C:/...(三個斜線)而 import.meta.url 也是,拼出來的字串
// 差一個斜線,結果是「直接執行也會被當成匯入」而什麼都不跑。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main())
}
