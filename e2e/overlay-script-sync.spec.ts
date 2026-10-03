/**
 * overlay-script-sync.spec.ts — 「改一句稿 → 立刻上台」這條主流程必須成立。
 *
 * 修掉的缺陷:浮層內容只在 OverlayShow 收到一次。於是使用者在講稿頁改完存檔,
 * 站在台上講的還是三十分鐘前的舊版,而且畫面上沒有任何地方說明它是舊的。
 *
 * 這條測試量的**兩件事**,缺一不可:
 *   1. 同一份稿改完存檔 → 浮層要換成新內容(修好的部分)。
 *   2. 存**另一份**稿 → 浮層不能被換掉。這是「不要用更糟的問題換掉原來的問題」:
 *      使用者編輯 A 稿時存檔 B 稿很常見,把 B 稿推上舞台等於講到別人的稿。
 *
 * 走真 IPC(renderer → main → overlay),所以 payload 少帶 scriptId、
 * 或「同一份稿才同步」這條規則被拿掉,這裡都會紅。
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchApp } from './helpers/launch'

const navTo = async (main: Page, label: string): Promise<void> => {
  await main.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(l))
    btn?.click()
  }, label)
  await main.waitForTimeout(500)
}

test('改稿存檔後浮層跟著換稿,而且存別的稿不會搶走舞台', async () => {
  test.setTimeout(120_000)
  const { app, main } = await launchApp()
  try {
    // 浮層視窗是另外一個 Page(只有主視窗有側欄,helpers/launch 已經分辨過)
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const overlay = app.windows().find((w) => w !== main)
    expect(overlay, '應該要有一個浮層視窗').toBeTruthy()
    const ov = overlay!

    await navTo(main, '提詞講稿')
    await main.locator('button', { hasText: '新講稿' }).click()
    await expect(main.locator('input[placeholder="講稿標題"]')).toBeVisible({ timeout: 5_000 })
    await main.locator('input[placeholder="講稿標題"]').fill('產品發表')
    await main.locator('textarea').fill('第一版開場白:今天要講的是進度與下一步。')
    await main.locator('button', { hasText: '儲存' }).click()

    // 開浮層。它此時載入的是第一版。
    await main.locator('button', { hasText: '開始提詞' }).click()
    await expect.poll(() => ov.locator('body').innerText(), { timeout: 10_000 }).toContain('第一版開場白')

    // 同一份稿改完存檔 → 浮層要跟著換(這是修好的那一半)
    await main.locator('textarea').fill('第二版開場白:今天改講風險與取捨。')
    await main.locator('button', { hasText: '儲存' }).click()
    await expect
      .poll(() => ov.locator('body').innerText(), { timeout: 10_000, intervals: [300, 500, 800] })
      .toContain('第二版開場白')

    // 另一份稿存檔 → 浮層不能被換掉(這是「不要修得更糟」的那一半)
    await main.locator('button', { hasText: '新講稿' }).click()
    await main.locator('input[placeholder="講稿標題"]').fill('另一場會議')
    await main.locator('textarea').fill('另一份講稿的內容,不該出現在舞台上。')
    await main.locator('button', { hasText: '儲存' }).click()
    // 給同步一個合理的機會送出來:同步是存檔後立刻發生的 IPC,
    // 這裡等的是「有沒有被換掉」,不是「會不會換」—— 所以用短暫停再檢查,
    // 而這段時間遠大於一次 IPC 往返。
    await main.waitForTimeout(1_500)
    const afterOther = await ov.locator('body').innerText()
    expect(afterOther).toContain('第二版開場白')
    expect(afterOther).not.toContain('另一份講稿的內容')
  } finally {
    await app.close().catch(() => undefined)
  }
})