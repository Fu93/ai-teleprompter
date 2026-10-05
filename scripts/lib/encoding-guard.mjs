/**
 * encoding-guard.mjs — 抓出被寫壞的 UTF-8(U+FFFD 取代字元)。
 *
 * ## 為什麼需要這個
 *
 * 這個專案的原始碼、註解與文件幾乎全是中文,而中文在這個工作流裡已經被寫壞過
 * 多次:某個字元在寫入時被截成非法位元組,Node 讀回來就是 U+FFFD(取代字元)。
 *
 * 它的危險性在於**症狀不明顯**:
 *   - TypeScript 照樣編譯(它在註解裡)、lint 照過、測試照綠。
 *   - 壞掉的是註解裡最關鍵的那一個詞,例如本指令檔頭提到的:
 *     「所以這裡斷言的是**最底層**的可觀察事實」曾經變成「最<3 個壞字元>層」——那個詞正是「斷言的是哪一層的可觀察事實」。
 *   - 這個專案的註解承載了大量**為什麼**的決策理由,那些正是下一個人
 *     (以及下一次 review)最需要讀到的東西。把它們靜默地腐化掉,代價是
 *     「看不懂為什麼這樣寫」,而那種退化不會有任何一項工具回報。
 *
 * 所以它需要一道會紅的閘門,而不是靠每次寫完都記得掃一遍。
 *
 * ## 為什麼是「允許清單」而不是「禁止清單」
 *
 * 二進位檔(wasm、png、字型)用 UTF-8 解碼會產生上萬個 U+FFFD —— 那是**正常**的,
 * 不是損壞。列一份副檔名黑名單會漏掉 `.task`、`.onnx` 這種沒人預想到的格式,
 * 於是閘門會在第一次遇到新型二進位時爆紅,而那種紅會訓練大家忽略它。
 *
 * 反過來,允許清單的預設是「不讀」,所以新型二進位只會**被忽略**(安全),
 * 要納入檢查必須顯式加進來。這個方向的錯誤是安全的,另一個不是。
 *
 * ## 這個檔自己為什麼沒有用 U+FFFD 字面值
 *
 * 因為掃描器會掃到它自己 —— 這個檔與它的測試都在掃描範圍內。
 * 用數字(0xfffd)組出來,而不是把取代字元寫成字面值 —— 否則這道閘門
 * 掃到自己時會報「這裡有一個損壞字元」。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** U+FFFD。刻意用跳脫序列:本檔會被自己的掃描器讀到。 */
const REPLACEMENT = String.fromCharCode(0xfffd)

/** 會被讀成文字的副檔名。新增一種語言時記得加進來。 */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.css',
  '.html',
  '.yml',
  '.yaml'
])

/**
 * 沒有副檔名但確實是文字的檔名。
 * `LICENSE`、`Dockerfile`、`.gitignore` 這類 —— 用副檔名判斷會把它們全部漏掉。
 */
const TEXT_FILENAMES = new Set(['LICENSE', 'Dockerfile', 'Makefile', '.gitignore', '.npmrc'])

/**
 * 完全跳過的目錄。
 *
 * 為什麼需要:`docs/audit/` 是稽核產物(截圖 + report.json),`node_modules/` 是
 * 上游程式碼,`out/` 與 `dist/` 是建置輸出。它們不在原始碼的責任範圍內,
 * 而且掃描成本會從零點幾秒變成數十秒 —— 一道慢的閘門遲早會被 `--no-verify` 跳過。
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'docs/audit',
  'tmp-ux',
  'tmp-ui-audit',
  'test-results',
  'playwright-report',
  'fixtures/audit',
  '.freebuff',
  '.zcode'
])

/**
 * 超過這個大小就跳過。
 *
 * 這是一道**保險**,不是優化:万一允許清單漏了一個副檔名,那個檔案會被當成文字
 * 解碼,然後回報上萬筆假的損壞 —— 而人面對上萬筆紅字的反應是把它整個關掉。
 * 單一檔案超過 2MB 對這個專案的原始碼來說不可能(最大的原始碼約 700 行),
 * 所以這個門檻不會擋掉任何真的該被檢查的檔案,但能擋住「壞掉一次閘門」這個結局。
 */
const MAX_BYTES = 2 * 1024 * 1024

/**
 * 這個(相對)路徑落在排除清單裡嗎?
 *
 * 同時處理兩種用法:走訪時傳的是**目錄**的相對路徑,而 isTextCandidate 傳的是
 * **檔案**的路徑。只比對完全相等會讓後者永遠不成立 —— 於是
 * 「isTextCandidate('node_modules/a/x.ts') 回 false」這種測試會紅,
 * 而實作會看起來像壞了。清單裡有像 'docs/audit' 這種多段路徑,所以用前綴比對,
 * 並且要求分隔線是 / —— 否則 'docs/audit-backup/x.ts' 會被誤判成被排除。
 */
function isExcluded(relPath) {
  for (const dir of SKIP_DIRS) {
    if (relPath === dir || relPath.startsWith(dir + '/')) return true
  }
  return false
}

function shouldSkipDir(relPath) {
  return SKIP_DIRS.has(relPath)
}

/**
 * 這個路徑「是文字檔候選」嗎?—— **純函式,不碰檔案系統**。
 *
 * 刻意不碰檔案系統:那會讓它對不存在的檔案回 false,而「副檔名是不是文字」
 * 這個判斷根本不需要檔案存在。走訪時的檔案大小檢查是另一件事(見 scanRepoForEncodingDamage),
 * 把它們混在一起會讓這個判斷在測試裡必須真的造檔案才能驗 ——
 * 而「測試需要造檔案才能驗」正是這種小工具最常見的測試品質落坑。
 */
export function isTextCandidate(relPath) {
  if (isExcluded(relPath)) return false
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  if (TEXT_FILENAMES.has(name)) return true
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  return TEXT_EXTENSIONS.has(ext)
}

/** 超過這個大小就不讀(保險,見上方說明)。 */
function isWithinSizeLimit(absPath) {
  try {
    return statSync(absPath).size <= MAX_BYTES
  } catch {
    return false
  }
}

/**
 * 找出文字裡所有的 U+FFFD,連同行號與該行內容。
 *
 * 回傳**空陣列**是正常結果,不是失敗 —— 所以呼叫端不能只檢查「有沒有東西」,
 * 必須真的斷言陣列是空的。`__tests__/encoding-guard.test.mjs` 對這件事有專門一條。
 *
 * @param {string} text
 * @param {string} label 只出現在結果裡,讓紅燈訊息指出是哪個檔案
 * @returns {{file: string, line: number, column: number, text: string}[]}
 */
export function findReplacementChars(text, label) {
  const found = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const idx = line.indexOf(REPLACEMENT)
    if (idx === -1) continue
    found.push({ file: label, line: i + 1, column: idx + 1, text: line.trim() })
  }
  return found
}

/**
 * 走訪 root 底下的所有文字檔並回報損壞處。
 *
 * 回傳 `{ scanned, findings }` 而不是只有 findings:`scanned` 是這道閘門的
 * 覆蓋率證據。一個回傳 0 筆問題、但只掃到 3 個檔案的閘門,和一個掃到 300 個
 * 檔案的閘門,在報告裡長得一模一樣 —— 那正是 thin-slider 藏了三輪的同一個病根。
 *
 * @param {string} root
 * @returns {{scanned: string[], findings: {file: string, line: number, column: number, text: string}[]}}
 */
export function scanRepoForEncodingDamage(root) {
  const scanned = []
  const findings = []

  const walk = (absDir, relDir) => {
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (!shouldSkipDir(rel)) walk(abs, rel)
        continue
      }
      if (!entry.isFile() || !isTextCandidate(rel)) continue
      if (!isWithinSizeLimit(abs)) continue
      let content
      try {
        content = readFileSync(abs, 'utf-8')
      } catch {
        continue
      }
      scanned.push(rel)
      findings.push(...findReplacementChars(content, rel))
    }
  }

  walk(root, '')
  // 排序讓紅燈輸出穩定:檔名依字典序,同一檔案內依行號。
  // 不排序的話,檔案系統的列舉順序會讓同一份壞掉在不同機器上長成不同樣子。
  scanned.sort()
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { scanned, findings }
}
