/**
 * pill-progress.spec.ts — 藥丸進度細線的語意回歸(使用者視角試用抓到的 bug)。
 *
 * 症狀(修正前):
 *   收合成藥丸後在主視窗換一份講稿 → 藥丸的狀態點 600ms 就從「播放中」跳成
 *   「已播畢」,進度細線閃一下就不見;接著把藥丸展開,講稿仍停在頂端、
 *   狀態仍是 completed、計時器是 0:00 / -0:00 —— 提詞機看起來完全壞掉。
 *
 * 根因:
 *   藥丸(收合)沒有捲動容器,量測管線拿不到 scrollHeight → 引擎的
 *   totalH/wrapH 一直是 undefined → maxScroll 退化成 40px(只剩尾部緩衝),
 *   播放不到一秒就自己完成;而展開時量測 effect 的 deps 只有字體/行高,
 *   容器重新掛上來並不會觸發重新量測,於是永遠回不去。
 *
 * 這條測試把「什麼時候該顯示這條線」一起鎖住:
 *   量不到捲動範圍時不畫線(畫一條永遠 0% 的線比不畫更糟),量到了就畫。
 *
 * 執行需先 `npm run build`;AI_TP_E2E 由 playwright.config 注入。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function launch(): Promise<{ app: ElectronApplication; main: Page; overlay: Page }> {
  const app = await electron.launch({ args: ['.'], timeout: 60_000 })
  let main: Page | undefined
  let overlay: Page | undefined
  for (let i = 0; i < 60; i++) {
    const all = app.windows()
    main = all.find((w) => !w.url().includes('overlay'))
    overlay = all.find((w) => w.url().includes('overlay'))
    if (main && overlay) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!main || !overlay) throw new Error('windows not ready')
  await main.waitForLoadState('domcontentloaded')
  await overlay.waitForLoadState('domcontentloaded')
  return { app, main, overlay }
}

const winSize = (overlay: Page): Promise<string> =>
  overlay.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)

/** 藥丸的狀態點 + 進度細線(展開形態沒有這兩個元素) */
const pillProbe = (overlay: Page): Promise<{ opacity: number; fill: number; dot: string | null }> =>
  overlay.evaluate(() => {
    const bar = document.querySelector('[data-pill-progress]')
    const fill = document.querySelector('[data-pill-progress] > div')
    const dot = document.querySelector('[data-pill-dot]')
    return {
      opacity: bar ? Number(getComputedStyle(bar).opacity) : -1,
      fill: fill ? Math.round(fill.getBoundingClientRect().width) : -1,
      dot: dot ? dot.getAttribute('title') : null
    }
  })

// 24 行(≈15s 的捲動量):整條測試從頭到尾都在「播放中」的區間内,
// 不然「還在播」與「剛好播完」會隨排程快慢互相偽裝
const scriptOf = (tag: string): string =>
  Array.from(
    { length: 24 },
    (_, i) => `${tag}第${i + 1}點,我們的產品願景是幫助每個人在重要場合自信表達。`
  ).join('\n')

test('藥丸換稿不會被誤標成播畢,展開後重新量測並繼續播', async () => {
  test.setTimeout(120_000)
  const { app, main, overlay } = await launch()
  try {
    const show = (title: string, content: string) =>
      main.evaluate((p) => window.api.overlayShow(p), { title, content })

    // 1) 展開 + 自動播放(捲動容器存在 → 量測得到)
    await show('進度回歸', scriptOf(''))
    await overlay.waitForTimeout(1_600)
    await expect(overlay.locator('[title="展開完整面板"]')).toHaveCount(0)
    await expect(overlay.locator('[title^="暫停"]').first()).toBeVisible({ timeout: 5_000 })

    // 2) 播放中收合成藥丸:量測值留在同一顆引擎上 → 線可見、填充有進度、仍在播
    await overlay.locator('[title*="收合成藥丸"]').click()
    await overlay.waitForTimeout(1_500)
    expect(await winSize(overlay)).toBe('320x48')
    const collapsed = await pillProbe(overlay)
    expect(collapsed.dot).toBe('播放中')
    expect(collapsed.opacity).toBeGreaterThan(0.9)
    expect(collapsed.fill).toBeGreaterThan(0)

    // 3) 藥丸模式下換稿:沒有容器可量 → 時鐘照走,但線不畫(不給永遠 0% 的假進度)
    await show('臨時插播', scriptOf('插播'))
    await overlay.waitForTimeout(1_800)
    const reloaded = await pillProbe(overlay)
    expect(reloaded.dot).not.toBe('已播畢')
    expect(reloaded.dot).toBe('播放中')
    expect(reloaded.opacity).toBeLessThan(0.1)

    // 4) 展開:容器回來 → 重新量測 → 計時器繼續倒數(修正前是 0:00 / -0:00 卡死)
    await overlay.locator('[title="展開完整面板"]').click()
    await overlay.waitForTimeout(1_800)
    expect(await winSize(overlay)).toBe('720x260')
    const clock = (): Promise<string | null> =>
      overlay.evaluate(() => document.body.innerText.match(/\d+:\d\d \/ -\d+:\d\d/)?.[0] ?? null)
    const clock1 = await clock()
    expect(clock1).not.toBeNull()
    // 剩餘時間不是 0 = 引擎量到真實高度後真的在捲(修正前這裡恆為 0:00 / -0:00)
    expect(clock1).not.toMatch(/0:00$/)

    await overlay.waitForTimeout(1_500)
    expect(await clock()).not.toMatch(/0:00$/)
    const fill = await overlay.evaluate(
      () => document.querySelector('[data-overlay-progress]')?.getBoundingClientRect().width ?? 0
    )
    expect(fill).toBeGreaterThan(0)
  } finally {
    await app.close().catch(() => undefined)
  }
})
