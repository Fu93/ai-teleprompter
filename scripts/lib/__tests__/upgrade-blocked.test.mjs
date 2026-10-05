/**
 * upgrade-blocked.test.mjs — 讓 docs/UPGRADE_BLOCKED.md 不會爛掉。
 *
 * ## 為什麼需要這個
 *
 * 那份文件的存在是為了回答「為什麼這些套件沒升?能不能升?」。它記錄的是
 * **查證過的結論**,而結論的價值全部來自它與現況一致。
 *
 * 而它爛掉了 —— 而且是本專案最典型的那種爛法:文件裡寫
 * 「electron 被 EBUSY 阻塞在 `^44.4.5`」,但 `package.json` 早已是 `^44.5.1`。
 * 同一份文件裡「e2e 57 支」也已經是 58 passed / 1 skipped。
 *
 * 為什麼沒有任何東西發現:這是一份純 Markdown,改了程式碼不會讓它紅。
 * 這與 `readmeCounts.test.ts` 處理的是**同一個病根** —— 這個專案有非常成熟的
 * 「先修後開門檻」慣例(release-gate 的 BASELINE、eslint-baseline.json、
 * e2e/manifest.mjs 的登記制),但那些守的都是程式碼的指標。
 * **文件從來不在任何一道閘門裡**,所以它是唯一會靜默漂移的那一類。
 *
 * ## 這個測試只擋「會自己變假」的欄位,不是全部
 *
 * 「阻塞者是誰」與「何時可以升」是**人的判斷**,沒有辦法從磁碟驗證。
 * 但「目前版本」是:它必須等於 package.json 裡的值。
 * 一旦那一欄過期,整張表的可信度就歸零 —— 因為讀者會合理地假設
 * 其他欄位也一樣新。而「假設沒被驗證過的東西是準的」正是這個專案
 * 反覆記錄過的失敗模式(thin-slider 的註解寫得很完整,但它量的東西不存在)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 專案根目錄。沿用 readmeCounts.test.ts 的向上搜尋,理由相同:
 * 這個 repo 的目錄名是中文,寫死層數必須知道名字裡有幾層,而寫錯時症狀是
 * ENOENT 指向一個看起來很合理的上層目錄。
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

const ROOT = findRoot()
const DOC_PATH = join(ROOT, 'docs/UPGRADE_BLOCKED.md')
const DOC = readFileSync(DOC_PATH, 'utf-8')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))

/**
 * 解析「目前的三筆」那張表。
 *
 * 只取那張表而不是全文的原因:文件裡還有「已完成的升級」對照表與建議段落,
 * 那些不該被當成「被阻塞的項目」來檢查。錨定在標題上,標題一改這裡就紅 ——
 * 那正是我們想要的(文件結構變了,這個測試需要被重新看一眼)。
 */
function parseBlockedTable() {
  const start = DOC.indexOf('## 目前的')
  expect(start, 'docs/UPGRADE_BLOCKED.md 缺少「## 目前的…」段落').toBeGreaterThan(-1)
  const rows = []
  for (const line of DOC.slice(start).split(/\r?\n/)) {
    const m = line.match(/^\|\s*`?([\w@/-]+)`?\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/)
    if (m) rows.push({ pkg: m[1], current: m[2], target: m[3] })
  }
  return rows
}

describe('docs/UPGRADE_BLOCKED.md 的版本敘述與 package.json 一致', () => {
  const rows = parseBlockedTable()

  it('表格有被解析到(不是 0 列 —— 那會讓下面每一條都 vacuous 通過)', () => {
    expect(rows.length, '沒從 UPGRADE_BLOCKED.md 解析到任何一列').toBeGreaterThan(0)
  })

  it('每一列的「目前」都等於 package.json 的實際宣告', () => {
    for (const row of rows) {
      const declared = PKG.dependencies?.[row.pkg] ?? PKG.devDependencies?.[row.pkg]
      expect(declared, `UPGRADE_BLOCKED.md 列了 ${row.pkg},但 package.json 沒有這個套件`).toBeDefined()
      expect(
        row.current,
        `${row.pkg}:文件寫「目前 ${row.current}」,package.json 是「${declared}」。` +
          `升級完成後請把它從這張表移到「已完成的升級」。`
      ).toBe(declared)
    }
  })

  it('「目標」必須比「目前」新 —— 否則那不是「被阻塞」,是寫錯了', () => {
    for (const row of rows) {
      // 只比 major —— 而且刻意用「開頭的第一段數字」而不是 Number():
      // Number('9.39.5') 是 NaN(多一個小數點),而 semver 的 major 足以回答
      // 「目標有沒有比目前新」這個唯一的問題。比 minor 更嚴謹是假的精確。
      const majorOf = (range) => {
        const m = String(range).match(/(\d+)/)
        return m ? Number(m[1]) : NaN
      }
      const cur = majorOf(row.current)
      const tgt = majorOf(row.target)
      expect(Number.isFinite(cur), `${row.pkg} 的「目前」解析不出 major:${row.current}`).toBe(true)
      expect(Number.isFinite(tgt), `${row.pkg} 的「目標」解析不出 major:${row.target}`).toBe(true)
      expect(tgt, `${row.pkg}:目標 major(${tgt})沒有比目前 major(${cur})新,這列不該出現在「被阻塞」表`).toBeGreaterThan(cur)
    }
  })

  it('清單裡的套件名稱是 npm 上真的存在的形式(不是誤植)', () => {
    // 只有兩種合理的寫法:純名,或 @scope/name。
    for (const row of rows) {
      expect(row.pkg, `套件名 "${row.pkg}" 不合法`).toMatch(/^(@[\w-]+\/)?[\w-]+$/)
    }
  })

  it('TypeScript 7 的刻意不升有被記錄(那是一筆「風險在本專案」的決策)', () => {
    // 這一筆與上面三筆性質不同:不是上游沒做,而是升了會讓 typescript-eslint
    // 不支援 —— 而 typecheck 是三道閘門之一。把它拿掉而不留理由,
    // 下一次 `npm outdated` 會讓人以為漏看了。
    expect(DOC).toContain('TypeScript 7')
    expect(DOC, '必須寫明 TS 7 是刻意不升,而不是查不到').toContain('不建議升')
  })

  it('文件說明「為什麼沒有用 --force」(那是被 review 會問的問題)', () => {
    expect(DOC).toContain('--force')
  })
})

describe('文件裡的數字不能是憑記憶寫的', () => {
  it('electron 的版本與 package.json 一致', () => {
    // 這條其實是上面那個迴圈的特例,但值得單獨留一條:electron 是這一輪唯一
    // 真的升級成功的套件,而它的「阻塞原因」(EBUSY)在升級後就消失了 ——
    // 文件沒跟著改,讀者會以為它還升不了。
    expect(DOC, 'UPGRADE_BLOCKED.md 仍把 electron 列為被阻塞,但它已經升級了').not.toMatch(
      /\|\s*`?electron`?\s*\|\s*`\^?44\.4\.5`/
    )
  })

  it('e2e 支數不是過期的數字', () => {
    // 「e2e 57 支」出現過,而實際是 58 passed / 1 skipped。
    // 這個數字會隨著 manifest.mjs 增減而變,所以只擋「明顯過期」——
    // 精確比對會讓每加一支 spec 都要改文件,而那種必然會被忘記的維護
    // 正是漂移的來源(見 readmeCounts.test.ts 對「精確比對」的同一個判斷)。
    const m = DOC.match(/e2e (\d+) 支/)
    if (m) {
      expect(Number(m[1]), 'UPGRADE_BLOCKED.md 的 e2e 支數看起來已經過期').toBeGreaterThanOrEqual(58)
    }
  })
})
