/**
 * short-script-overlay.spec.ts — 浮層狀態必須誠實(第四輪 P0-1 / P0-2)。
 *
 * 修掉的兩個缺陷(都是使用者視角實測出來的,不是讀碼猜的):
 *
 *   P0-1 短稿按「開始提詞」一秒內自己播完並宣布「已播畢」。
 *         maxScroll = max(0, totalH - wrapH + 40),內容一頁放得下時那 40px
 *         **全部是尾部緩衝**,沒有一行內容在可視區下面,而 tickScroll 只要
 *         `next >= maxScroll` 就宣告 completed。預設浮層 720×260 扣掉工具列約
 *         4 行 → 約 96 字以內的稿開箱即中,而 3~4 行的開場白正是最常見的稿長。
 *
 *   P0-2 根本沒有講稿時,狀態列也寫「已播畢」。同一個畫面裡上面寫
 *         「尚未載入講稿」,下面寫「已播畢」—— 互相矛盾,而且是關於一件
 *         根本沒發生過的事。
 *
 * 這條測試量的是**使用者看到的字**,不是引擎內部狀態:
 *   1. 短稿 + 自動播放 → 不得出現「已播畢」,且必須說清楚為什麼不動
 *   2. 空稿 → 不得出現「已播畢」(也不得出現任何時間)
 *   3. 長稿 → 仍然正常倒數(**不要修得更糟**:引擎那條防線不能誤傷長稿)
 *
 * 走真 IPC 與真 RAF,所以只改引擎、或只改文案層,這三條都會各自轉紅。
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchApp } from './helpers/launch'
// Page 只用於 navTo 的型別

const navTo = async (main: Page, label: string): Promise<void> => {
  await main.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(l))
    btn?.click()
  }, label)
  await main.waitForTimeout(500)
}

test('短稿不會秒播畢:空稿不報「已播畢」,短稿說清楚原因,長稿照常倒數', async () => {
  test.setTimeout(150_000)
  const { app, main } = await launchApp()
  try {
    // 浮層視窗是另外一個 Page(helpers/launch 已經用「有沒有側欄」分辨過)
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const ov = app.windows().find((w) => w !== main)!
    expect(ov, '應該要有一個浮層視窗').toBeTruthy()

    // ── P0-2:一開始沒有稿,浮層不得對一件沒發生過的事結案 ──
    await expect.poll(() => ov.locator('body').innerText(), { timeout: 15_000 }).toContain('尚未載入講稿')
    const emptyText = await ov.locator('body').innerText()
    expect(emptyText, '空稿狀態不得出現「已播畢」').not.toContain('已播畢')
    // 也不得出現任何時間 —— 沒有稿就沒有「播過」
    expect(emptyText, '空稿狀態不得出現時間列').not.toMatch(/已播\s*\d/)

    await navTo(main, '提詞講稿')

    // ── P0-1:短稿(3~4 行,預設浮層放得下)──
    await main.locator('button', { hasText: '新講稿' }).click()
    await expect(main.locator('input[placeholder="講稿標題"]')).toBeVisible({ timeout: 5_000 })
    await main.locator('input[placeholder="講稿標題"]').fill('開場白')
    await main
      .locator('textarea')
      .fill('各位好,今天要跟大家說三件事。第一件事是進度。第二件事是節奏。第三件事是收尾。')
    await main.locator('button', { hasText: '儲存' }).click()
    await main.locator('button', { hasText: '開始提詞' }).click()
    await expect.poll(() => ov.locator('body').innerText(), { timeout: 15_000 }).toContain('各位好')

    // 按播放(「開始提詞」本來就會自動播放,這裡再明確按一次以免時序)
    await ov.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.getAttribute('data-effect-id')?.includes('play') || b.textContent?.includes('播放')
      )
      btn?.click()
    })

    // 給它 3 秒:舊行為在這裡早就跳成「已播畢」了(60px/s × 40px < 1 秒)
    await ov.waitForTimeout(3_000)
    const shortText = await ov.locator('body').innerText()
    expect(shortText, '短稿不得自己播完並宣布「已播畢」').not.toContain('已播畢')
    // 不能只是「不宣告完成」就留給使用者猜:必須說清楚這一頁放得下。
    // (否則狀態停在「播放中」而內容不動,那和壞掉難以區分。)
    expect(shortText, '短稿必須說清楚「這一頁就放得下」').toContain('這一頁就放得下')

    // ── 對照組:長稿必須照常倒數(防「修得更糟」)──
    const longScript = Array.from(
      { length: 40 },
      (_, i) => `第 ${i + 1} 句:這是一段足夠長的提詞內容,用來驗證長稿仍然會正常計時與倒數。`
    ).join('\n')
    await main.locator('button', { hasText: '提詞' }).first().click()
    await navTo(main, '提詞講稿')
    await main.locator('button', { hasText: '新講稿' }).click()
    await expect(main.locator('input[placeholder="講稿標題"]')).toBeVisible({ timeout: 5_000 })
    await main.locator('input[placeholder="講稿標題"]').fill('長稿')
    await main.locator('textarea').fill(longScript)
    await main.locator('button', { hasText: '儲存' }).click()
    await main.locator('button', { hasText: '開始提詞' }).click()
    await expect
      .poll(() => ov.locator('body').innerText(), { timeout: 15_000, intervals: [300, 500, 800] })
      .toContain('第 1 句')
    await ov.waitForTimeout(3_000)
    const longText = await ov.locator('body').innerText()
    expect(longText, '長稿必須照常顯示已播與剩餘').toMatch(/已播\s*\d+:\d{2}\s*·\s*剩/)
    expect(longText, '長稿不得被誤判成「這一頁就放得下」').not.toContain('這一頁就放得下')
  } finally {
    await app.close().catch(() => undefined)
  }
})