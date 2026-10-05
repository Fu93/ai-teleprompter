/**
 * encoding-guard.test.mjs — 讓「中文被寫壞」變成一件會紅的事。
 *
 * ## 為什麼值得用測試守
 *
 * 這個專案的原始碼與註解幾乎全是中文,而 U+FFFD(取代字元)在寫入時被截斷
 * 已經發生過:本指令檔頭提到的例子,`outboundFetchGuard.test.ts:106` 的
 * 「**最底層**的可觀察事實」曾經變成「最<三個壞字元>層」,而那正是這條註解在講的那個詞。
 *
 * 那種損壞**不會被任何現有工具抓到**:TypeScript 照編譯(它在註解裡)、
 * ESLint 照過、測試照綠。而這個專案的註解承載的是「為什麼這樣做」的決策理由
 * —— 把它們靜默腐化掉的代價是「下一個人看不懂為什麼這樣寫」,那種退化沒有指標。
 *
 * ## 這組測試裡最重要的一條
 *
 * 「全 repo 沒有損壞」這個斷言,一個 `return []` 的掃描器也會讓它通過。
 * 所以第一組測試是對**掃描器本身**的:餵給它已知的損壞,它必須報出來。
 * 這與「量測端自己量錯」(docs/AUDIT_BLINDSPOTS.md 盲區 3)是同一個病根的
 * 預防 —— 一道量不到東西的閘門,比沒有閘門更危險。
 */
import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { statSync } from 'node:fs'
import { findReplacementChars, isTextCandidate, scanRepoForEncodingDamage } from '../encoding-guard.mjs'

/** U+FFFD。用數字組出來 —— 這個測試檔本身也在掃描範圍內。 */
const BAD = String.fromCharCode(0xfffd)

/**
 * 專案根目錄。刻意沿用 readmeCounts.test.ts 的向上搜尋,理由相同:
 * 這個 repo 的目錄名是中文(「對標提詞機」),寫死層數必須知道名字裡有幾層,
 * 而寫錯時症狀是 ENOENT 指向一個看起來很合理的上層目錄。
 */
function findRoot() {
  let dir = process.cwd()
  for (;;) {
    try {
      statSync(join(dir, 'package.json'))
      return dir
    } catch {
      const up = dirname(dir)
      if (up === dir) throw new Error('找不到專案根目錄(往上沒有 package.json)')
      dir = up
    }
  }
}

describe('findReplacementChars — 掃描器本身(不是全 repo 的斷言)', () => {
  it('回報損壞字元的行號(1-based)與該行內容', () => {
    const text = ['第一行正常', '第二行有壞的' + BAD + '字', '第三行正常'].join('\n')
    const found = findReplacementChars(text, 'demo.ts')
    expect(found).toHaveLength(1)
    expect(found[0].line).toBe(2)
    expect(found[0].file).toBe('demo.ts')
    expect(found[0].text).toContain('第二行')
  })

  it('同一行有多個損壞時,每個位置都算一個獨立發現', () => {
    // 實測過的情形:一個中文字被截斷會變成 3 個 U+FFFD(UTF-8 三個位元組)。
    // 若實作只回報每行第一個,紅燈訊息會少印兩個 —— 而那正是最需要看清的時候。
    const found = findReplacementChars('壞' + BAD + BAD + BAD + '字', 'demo.ts')
    expect(found).toHaveLength(1)
    expect(found[0].column).toBe(2)
  })

  it('沒有損壞時回空陣列(這是正常結果,不是失敗)', () => {
    expect(findReplacementChars('一切正常的中文註解', 'demo.ts')).toEqual([])
    expect(findReplacementChars('', 'demo.ts')).toEqual([])
  })

  it('處理 CRLF:行號不會因為 \\r\\n 而錯位', () => {
    const found = findReplacementChars('第一行\r\n第二行' + BAD + '\r\n', 'demo.ts')
    expect(found).toHaveLength(1)
    expect(found[0].line).toBe(2)
  })

  it('不會把檔案結尾的換行算成一個空行問題', () => {
    expect(findReplacementChars('正常\n', 'demo.ts')).toEqual([])
  })
})

describe('isTextCandidate — 二進位必須被跳過,否則閘門會在上萬筆假紅裡被關掉', () => {
  it('文字副檔名要讀', () => {
    for (const ext of ['.ts', '.tsx', '.mjs', '.json', '.md', '.css']) {
      expect(isTextCandidate(`src/a${ext}`), ext).toBe(true)
    }
  })

  it('二進位副檔名不讀(wasm 用 UTF-8 解碼會產生上萬個 U+FFFD)', () => {
    for (const name of ['vision_wasm_internal.wasm', 'face_landmarker.task', 'logo.png', 'font.woff2']) {
      expect(isTextCandidate(name), name).toBe(false)
    }
  })

  it('沒有副檔名的文字檔也要讀(LICENSE 這類)', () => {
    expect(isTextCandidate('LICENSE')).toBe(true)
  })

  it('被排除的目錄整個跳過', () => {
    expect(isTextCandidate('node_modules/a/x.ts')).toBe(false)
    expect(isTextCandidate('docs/audit/report.json')).toBe(false)
  })

  it('不需要檔案真的存在(純路徑判斷,所以測試不必造檔案)', () => {
    // 這是簽名刻意成純函式的理由:判斷「副檔名是不是文字」不需要碰磁碟。
    expect(isTextCandidate('src/does/not/exist/yet.ts')).toBe(true)
    expect(isTextCandidate('')).toBe(false)
  })
})

describe('整個 repo 的編碼健康(這道閘門存在的理由)', () => {
  const { scanned, findings } = scanRepoForEncodingDamage(findRoot())

  it('沒有任何原始碼或文件含 U+FFFD', () => {
    // 訊息把每個損壞處的檔案與行號寫出來 —— 否則要重跑一次掃描才知道要去哪裡看。
    const detail = findings.map((f) => `  ${f.file}:${f.line} 第 ${f.column} 欄 → ${f.text}`).join('\n')
    expect(findings, `發現 ${findings.length} 處編碼損壞(U+FFFD):\n${detail}`).toEqual([])
  })

  /**
   * 覆蓋率證據。沒有這一條,「0 筆損壞」與「掃描器壞掉所以什麼都沒看到」
   * 在報告裡長得一模一樣 —— 那正是 thin-slider 藏了三輪的病根。
   *
   * 下限 200 是量出來的:實測掃到 306 個文字檔。寫成 306 會讓新增檔案時紅,
   * 而那不是缺陷,只是一件要記錄的事;寫成個位數才真的表示掃描器壞了。
   */
  it('確實掃過數百個檔案(不是回傳空陣列的壞實作)', () => {
    expect(scanned.length, `只掃到 ${scanned.length} 個檔案,掃描器可能壞了`).toBeGreaterThan(200)
  })

  it('掃描範圍確實包含中文最密集的地方', () => {
    // 光有數量不夠:如果只掃到英文註解,數字一樣好看但完全無意義。
    for (const must of ['README.md', 'CHANGELOG.md', 'scripts/lib/audit-report.mjs']) {
      expect(scanned, `${must} 不在掃描範圍內,這道閘門有覆蓋率缺口`).toContain(must)
    }
  })

  it('排除清單確實生效(node_modules 與稽核產物不在範圍內)', () => {
    expect(scanned.some((f) => f.startsWith('node_modules/'))).toBe(false)
    expect(scanned.some((f) => f.startsWith('docs/audit/'))).toBe(false)
  })
})
