import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * copyConsistency.test.ts — 文案一致性抽查(第三輪 P1-2 的驗收)。
 *
 * 為什麼是字串掃描而不是渲染測試:這些規則管的是**字面**——
 * 數字有沒有單位、異體字有沒有混進來、同一句話的括號規則一不一致。
 * 渲染測試量的是行為,對「字寫錯了」天生沒有感覺;而沒有任何規則釘住的話,
 * 下一次改文案又會把「部份」或裸數字放回來(docs/UX_FINDINGS.md 第三輪 P1-2)。
 *
 * 只釘住少量高頻規則 —— 完整的文案規範還沒定(見 P2 附錄 #4),
 * 過度的字串斷言會讓每一次文案調整都撞牆,那種測試很快就會被關掉。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
/** 這裡是 src/renderer/src/lib/__tests__ → 兩層上來是 src/renderer/src */
const RENDERER_SRC = join(HERE, '..', '..')

const read = (rel: string): string => readFileSync(join(RENDERER_SRC, rel), 'utf-8')

/** 遞迴收集 renderer 原始碼(測試檔本身除外 —— 它裡面就有反例字串) */
function rendererSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push({ rel: p.slice(RENDERER_SRC.length), text: readFileSync(p, 'utf-8') })
      }
    }
  }
  walk(RENDERER_SRC)
  return out
}

describe('文案一致性(字串掃描)', () => {
  it('設定頁「字級／速度」的第二個數字帶 px/s 單位(裸數字讀不出是什麼)', () => {
    const s = read('pages/SettingsPage.tsx')
    const at = s.indexOf('derivedSpeed')
    expect(at, '設定頁找不到 derivedSpeed —— 單位抽查的對象變了').toBeGreaterThan(-1)
    // 單位緊跟在 derivedSpeed 的渲染之後(同一段 JSX 內)
    const window = s.slice(at, at + 300)
    expect(window, `derivedSpeed 之後沒有 px/s 單位:${window.slice(0, 120)}`).toContain('px/s')
  })

  it('「部分」不寫成異體字「部份」(教育部標準)', () => {
    const offenders = rendererSources()
      .filter((f) => f.text.includes('部份'))
      .map((f) => f.rel)
    expect(offenders, `這些檔案用了「部份」:${offenders.join(', ')}`).toEqual([])
  })

  it('浮層工具列的語速 title 不混用全形括號(與「速度 -(...)」同一種)', () => {
    const s = read('overlay/OverlayApp.tsx')
    expect(s).not.toContain('語速 -（')
    expect(s).not.toContain('語速 +（')
  })

  it('「已存成講稿」的 toast 用全形標點並把標題框起來', () => {
    const s = read('pages/Record.tsx')
    expect(s).toContain('已存成講稿:「')
    expect(s).toContain('」,在「提詞講稿」頁。')
    expect(s, '半形逗號混進全形句子里(修復前的原狀)').not.toContain('（講稿）,在')
  })

  it('總覽首屏的問候語看有沒有資料(無條件的「歡迎回來」是第四輪 P1-1)', () => {
    const s = read('pages/Dashboard.tsx')
    // 修復前是 <h1 className="text-2xl font-bold">歡迎回來</h1> —— 沒有分支。
    expect(s, '總覽找不到 isReturning 判斷 —— 問候語又變成無條件字串了').toContain('isReturning')
    // 三種資料任一存在就算回頭使用者
    expect(s).toMatch(/isReturning\s*=\s*recent\.length\s*>\s*0/)
    expect(s).toMatch(/isReturning[^\n]*totals\.sessions\s*>\s*0/)
    expect(s).toMatch(/isReturning[^\n]*totals\.runs\s*>\s*0/)
  })

  it('浮層時間列有「這一頁就放得下」這個狀態(短稿不再秒播畢)', () => {
    const s = read('overlay/OverlayApp.tsx')
    expect(s, '找不到 fitsOnePage —— 短稿會停在「播放中」而內容不動').toContain('fitsOnePage')
    expect(s).toContain('這一頁就放得下')
    // 空稿時時間列不渲染(沒有稿就沒有「播過」)
    expect(s).toContain('transportText &&')

    // 條件本身必須真的接在引擎的判斷上。
    // 這一條是因為踩過才加的:先前只斷言「檔案裡有 fitsOnePage 這個字」,
    // 結果把整個條件寫死成 `const fitsOnePage = false` 時測試**照樣全綠** ——
    // 守衛在,接線卻不在,正是這個 repo 定義的假綠燈。只查字串不等於驗過接線。
    expect(
      s,
      'fitsOnePage 沒有接在引擎的 scrollable 上 —— 這一頁放得下時使用者仍然看不到原因'
    ).toMatch(/const fitsOnePage = [^;]*measured[^;]*!scrollable/)
    // 文案必須真的由這個狀態觸發,而不是一個無關的常數
    expect(s).toMatch(/const transportText = fitsOnePage[^;]*\?/)
  })

  it('沒命名的會議標題不含時間戳(下方那行會再印一次)', () => {
    const s = read('lib/sessionPersist.ts')
    expect(s, 'sessionPersist 又把時間戳寫進自動標題了').toContain('UNTITLED_SESSION_TITLE')
    // 反例字串:把 formatDateTime 重新接回標題就會命中這一條
    expect(s).not.toMatch(/title:[^\n]*formatDateTime/)
  })
})
