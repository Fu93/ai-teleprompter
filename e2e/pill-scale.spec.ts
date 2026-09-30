/**
 * pill-scale.spec.ts — 「藥丸大小」滑桿的回歸。
 *
 * 為什麼需要這條:
 *   藥丸是「一個視窗」,而它的尺寸有三份來源 —— 設定值(pillScale)、
 *   滑桿下方的換算說明,以及真正的 BrowserWindow 大小。三者只要有一份走鐘,
 *   使用者看到的就是:「說明寫 384×58,但視窗還是 320×48」或
 *   「我調了大小,結果只有字變大、膠囊沒變」。
 *
 *   這條測試從真實的 range 滑桿(鍵盤,不是直接呼叫 API)開始,一路對到
 *   window.innerWidth/innerHeight,並且在兩端(0.8× / 1.3×)確認藥丸仍然是
 *   一個「真膠囊」(半徑 = 高度一半),而不是被壓成圓角矩形。
 *
 * 執行需先 `npm run build`;AI_TP_E2E 由 playwright.config 注入(userData 隔離 →
 * 每次啟動都是預設設定,所以藥丸基準是 320×48 / 1.00×)。
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

const SIZE = '各位好,今天要跟大家介紹我們最新的產品,以及接下來三個月的計畫。'

test('藥丸大小滑桿:數值、換算說明、真實視窗尺寸三者一致', async () => {
  test.setTimeout(90_000)
  const { app, main, overlay } = await launch()
  try {
    await main.evaluate(
      (content) => window.api.overlayShow({ title: '尺寸回歸', content }),
      SIZE
    )
    await overlay.waitForTimeout(1_500)
    // 預設形態是展開 → 明確收合成藥丸,尺寸才會由 pillScale 決定
    await overlay.locator('[title*="收合成藥丸"]').click()
    await overlay.waitForTimeout(1_400)

    const winSize = (): Promise<string> =>
      overlay.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)
    expect(await winSize()).toBe('320x48')

    // 側欄 → 設定頁
    await main.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const hit =
        btns.find((b) => (b.textContent || '').trim() === '設定') ??
        btns.find((b) => (b.textContent || '').includes('設定'))
      hit?.click()
    })
    await main.waitForTimeout(500)

    const slider = main.locator('input[type=range][aria-label="藥丸大小"]')
    await expect(slider).toHaveCount(1)
    const helpText = (): Promise<string> =>
      main.locator('div:has(> div > input[aria-label="藥丸大小"])').last().innerText()
    expect(await slider.inputValue()).toBe('1')
    expect(await helpText()).toContain('320×48')

    // 真實鍵盤操作(不是直接寫設定):4 格 → 1.2×
    await slider.focus()
    for (let i = 0; i < 4; i++) await main.keyboard.press('ArrowRight')
    await overlay.waitForTimeout(1_200)
    expect(await slider.inputValue()).toBe('1.2')
    expect(await helpText()).toContain('384×58')
    expect((await main.evaluate(() => window.api.getSettings())).overlay.pillScale).toBe(1.2)
    expect(await winSize()).toBe('384x58')

    // 上端 1.3×
    for (let i = 0; i < 4; i++) await main.keyboard.press('ArrowRight')
    await overlay.waitForTimeout(1_200)
    expect(await slider.inputValue()).toBe('1.3')
    expect(await winSize()).toBe('416x62')

    // 下端 0.8×:仍然要是真膠囊(半徑 = 高度一半),不是圓角矩形
    for (let i = 0; i < 10; i++) await main.keyboard.press('ArrowLeft')
    await overlay.waitForTimeout(1_200)
    expect(await slider.inputValue()).toBe('0.8')
    expect(await winSize()).toBe('256x38')
    const geo = await overlay.evaluate(() => {
      const el = document.querySelector('[data-overlay-surface="pill"]')
      if (!el) return null
      return {
        radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
        h: el.getBoundingClientRect().height
      }
    })
    expect(geo).not.toBeNull()
    expect(geo!.radius).toBeGreaterThanOrEqual(geo!.h / 2 - 1)
  } finally {
    await app.close().catch(() => undefined)
  }
})
