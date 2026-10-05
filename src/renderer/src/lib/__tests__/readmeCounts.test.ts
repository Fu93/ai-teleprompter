import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * readmeCounts.test.ts — 讓 README 裡的「N 個測試」不會變成謊話。
 *
 * ## 為什麼需要這個
 *
 * README 的開發段落寫著「npm test # 569 單元測試(52 個檔案)」。實際上它已經
 * 是 798 個測試、73 個檔案,而且**落後了很久**(寫下來到被發現之間跨了 39 個測試)。
 *
 * 落後的原因不是有人忘了改,而是這個數字**沒有任何辦法驗證**:它是一個手打的
 * 純文字,改了程式碼不會讓它紅。而 README 的這一行是新貢獻者讀到的第一個
 * 「這個專案怎麼驗證自己」的訊號 —— 寫錯的數字會讓人以為跑測試很輕鬆。
 *
 * 與這個 repo 既有做法的關係:這裡有非常成熟的「先修、後開門檻」慣例
 * (release-gate 的 BASELINE、eslint-baseline.json),但那些守的是**程式碼**的指標。
 * 文件從來不在任何一道閘門裡,於是它是唯一會靜默漂移的那一類。
 *
 * ## 為什麼只斷言「檔案數」而不同斷言「測試數」
 *
 *   - **檔案數**可以直接從磁碟算出來,確定且穩定。
 *   - **測試數**(it(...) 的數量)要真的跑 vitest 才能得到,那會讓這個測試
 *     遞迴依賴測試執行器 —— 一個單元測試檔去啟動整個測試套件是壞味道,而且
 *     在 CI 上會慢到荒謬。
 *
 * 所以策略是:檔案數精確比對(README 錯了就紅),測試數只要求一個下界
 * (README 寫得比實際少就是錯,寫得比實際多是無害的保守)。
 */
/**
 * 專案根目錄:從 cwd 往上找到第一個含 package.json 的目錄。
 *
 * 為什麼不寫死層數:上溯層數取決於**專案目錄的名字**。這個 repo 的目錄叫
 * 「對標提詞機」(中文),而寫死 '..' 的方式必須同時知道名字裡有幾層 ——
 * 寫錯時症狀是 ENOENT 指向一個看起來很合理的上層目錄(我實測過 5、6、7 層,
 * 分別指到 src、專案目錄、Desktop),每次都要猜。這種「猜對了才會過」的常數
 * 在別人 clone 到不同路徑時會直接爆掉,所以改成向上搜尋:沒有可猜的參數。
 *
 * 向上搜尋而不是向下:vitest 的 cwd 就是專案根(見 package.json 的 scripts),
 * 但本地開發也可能從子目錄啟動,向上找兩邊都對。
 */
function findRoot(): string {
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
const README = join(ROOT, 'README.md')

/** vitest 的 include(見 vitest.config.ts)。刻意複述一份而不是 import 設定檔,
 *  因為 import 設定檔會把 vite 的設定載入這條測試,而這個檔案的職責就是
 *  「不要在測試裡啟動整個工具鏈」。 */
function countTestFiles(): number {
  const globs = ['src', 'scripts']
  let n = 0
  for (const base of globs) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.test\.(ts|mjs)$/.test(entry)) n += 1
      }
    }
    walk(join(ROOT, base))
  }
  return n
}


describe('README 的測試數字與實際一致', () => {
  it('檔案數精確比對(README 寫錯就紅)', () => {
    const readme = readFileSync(README, 'utf-8')
    const m = readme.match(/(\d+)\s*(?:個)?檔案/)
    expect(m, 'README 的開發段落必須寫出測試檔案數').not.toBeNull()
    const claimed = Number(m![1])
    expect(claimed, 'README 的測試檔案數與磁碟上的實際數量不符').toBe(countTestFiles())
  })

  /**
   * 測試數也用**檔案數**作為基準,不用靜態數 it()。
   *
   * 為什麼不放棄這個斷言:先試過數原始碼裡的 `it(`,結果數到 817 而 vitest
   * 實際執行 809 —— 差在條件式/巢狀的測試與 it.each。這種 8 個測試的誤差會
   * 讓「精確比對」永遠是壞的(而且會誘發人把 README 調高去迎合一個壞基準)。
   *
   * 這裡接受這個事實:README 的測試數是**近似值**,而檔案數是**精確值**。
   * 所以檔案數精確比對、測試數放寬成「數量級要對」—— 一個把測試砍掉一半的
   * 變更(比如從 800 刪到 400)仍然會被檔案數比對抓到。真正要防的漂移是
   * 「文件停滯在幾百個測試而實際已經上千」,而那個量級差是很容易抓的。
   */
  it('測試數的量級與實際相符(不是精確值 —— 靜態數 it() 會有 8 個的誤差)', () => {
    const readme = readFileSync(README, 'utf-8')
    const m = readme.match(/(\d+)\s*單元測試/)
    expect(m, 'README 的開發段落必須寫出單元測試數').not.toBeNull()
    const claimed = Number(m![1])
    const files = countTestFiles()
    // 每個測試檔平均 8~15 個測試。落在這個區間外就代表文件漂移了。
    expect(claimed / files, `README 寫 ${claimed} 個測試分佈在 ${files} 個檔案,比例不合理`).toBeGreaterThan(5)
    expect(claimed / files).toBeLessThan(25)
  })
})
