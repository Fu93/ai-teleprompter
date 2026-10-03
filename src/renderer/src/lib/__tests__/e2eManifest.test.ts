/**
 * e2eManifest.test.ts — 「每一支 e2e spec 恰好出現在一份清單裡」。
 *
 * ── 這條測試為什麼是這個計畫裡最重要的一條工程改動 ──
 *   探索這個 repo 時發現,「測試要跑哪些」有**三份互相獨立的定義**:
 *     1. package.json 的 test:e2e(19 支,CI 用)
 *     2. package.json 的 test:all(走 e2e → 全 20 支)
 *     3. scripts/release-gate.mjs 的 STEPS(走 npx playwright test → 全 20 支)
 *
 *   結果是:本地閘門擋的東西比 CI 多一支,而「差多少」沒有人知道。
 *   這不是未來的風險,是**此刻**的漂移。
 *
 *   把清單集中到 e2e/manifest.mjs 只能解決「有一份來源」;真正防止它再次
 *   分裂的是這條測試:**新增一支 spec 卻沒登記 → 紅燈**。
 *
 *   為什麼值得用一個單元測試去守一個 JSON 檔:
 *   「我以為我加進去了」是這個專案最貴的失敗模式(見 release-gate.mjs
 *   檔頭:「我以為我跑過了」)。而一份沒被任何東西讀取的清單,與不存在的
 *   清單在報告上長得一模一樣 —— 它看起來是對的。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCKING_SPECS, ADVISORY_SPECS, ALL_SPECS, describeE2E } from '../../../../../e2e/manifest.mjs'

const e2eDir = join(process.cwd(), 'e2e')
const onDisk = readdirSync(e2eDir)
  .filter((f) => f.endsWith('.spec.ts'))
  .sort()

describe('e2e manifest 與 e2e/ 目錄一致', () => {
  it('清單裡的每一支都真的存在(刪掉一支 spec 必須變紅)', () => {
    const missing = ALL_SPECS.filter((s) => !onDisk.includes(s))
    // 這種漂移會讓 CI 報「找不到測試檔」,但那是在跑了 15 分鐘之後;
    // 這條測試 5 毫秒就抓到。
    expect(missing).toEqual([])
  })

  it('e2e/ 底下的每一支都出現在清單裡(新增一支沒登記必須變紅)', () => {
    const unregistered = onDisk.filter((f) => !ALL_SPECS.includes(f))
    // 這一條是整個機制的核心:未登記的 spec 在 CI 上**不會被跑到**,
    // 而「沒被跑到」在報告上與「通過」長得一樣 —— 這是這個專案記錄過
    // 最貴的一次教訓(practice-generation 在 CI 上曾經永遠 skip)。
    expect(unregistered).toEqual([])
  })

  it('一支 spec 只能出現在一份清單裡(不得同時是 blocking 與 advisory)', () => {
    // ⚠️ 這裡原本寫的是 `ADVISORY_SPECS.includes(s)`,而 s 是字串、
    // ADVISORY_SPECS 的元素是 { file, reason } 物件 —— includes 永遠是 false,
    // 所以這條斷言**從來沒有真的比較過任何東西**,它必定綠。
    // 證據:它寫在 .mjs 沒有型別的年代(那是隱性 any 幫它蒙混過關的原因)。
    // 一條永遠不會紅的測試比沒有這條測試更糟 —— 它讓人以為「兩邊不重疊」
    // 有人守著。改成比檔名,並且 tsc 現在會盯著型別。
    const advisoryFiles = ADVISORY_SPECS.map((s) => s.file)
    const both = BLOCKING_SPECS.filter((s) => advisoryFiles.includes(s))
    // 同時在兩邊的 spec 會被跑兩次,而 flaky 分流會因此失真:
    // 「它只在一種情況下會紅」這個結論會被重複執行稀釋掉。
    expect(both).toEqual([])
  })

  it('清單內沒有重複(同一支 spec 被登記兩次會讓重跑邏輯失準)', () => {
    // 兩份清單的元素型別不同(string 與 {file})。先把 advisory 映射成檔名,
    // 再做同樣的斷言 —— 與其放寬型別(`any[]`),不如讓兩邊真的同形。
    const names = [BLOCKING_SPECS, ADVISORY_SPECS.map((s) => s.file)]
    for (const list of names) {
      expect(list.length, `${list.join(',')} 有重複`).toEqual(new Set(list).size)
    }
  })

  it('advisory 清單非空 —— 否則「非阻塞但有報告」這一整層是形同虛設', () => {
    // 不是形式主義:這一欄空了的話,視覺/時序敏感的測試會在某次重構裡
    // 被不知不覺地移進 blocking(然後開始製造假的紅燈),或者被刪掉。
    // 兩種結果都比「明確標成 flaky」更糟。
    expect(ADVISORY_SPECS.length).toBeGreaterThan(0)
  })

  it('每一支都是 e2e/ 目錄裡的 spec 檔名(不是路徑)', () => {
    // manifest 存的是檔名而不是 'e2e/x.spec.ts':兩種形狀混用時,
    // 產生命令列的方式會有兩套,而其中一套必然漏掉某些檔。
    for (const s of ALL_SPECS) {
      expect(s).toMatch(/^[\w-]+\.spec\.ts$/)
    }
  })
})

describe('describeE2E', () => {
  it('blocking 與 advisory 都被分類,沒有漏網的', () => {
    const d = describeE2E()
    expect(d.blocking.length + d.advisory.length).toBe(ALL_SPECS.length)
  })

  it('advisory 附有「為什麼不擋 merge」的理由', () => {
    // 沒有理由的 advisory 會在半年後被當成「忘了放進 blocking」而
    // 升級成阻塞測試,於是它開始製造假紅燈 —— 那正是它被分類出來的原因。
    for (const s of ADVISORY_SPECS) {
      expect(typeof s.reason, `${s.file} 缺少不擋 merge 的理由`).toBe('string')
      expect(s.reason.length).toBeGreaterThan(10)
    }
  })

  it('檔名在磁碟上存在(理由註解不會讓它變成一份寫錯的清單)', () => {
    for (const s of ADVISORY_SPECS) {
      expect(existsSync(join(e2eDir, s.file)), `${s.file} 不存在`).toBe(true)
    }
  })
})
