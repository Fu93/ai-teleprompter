/**
 * scripts-import.spec.ts — 匯入講稿時內容必須真的看得見。
 *
 * 回歸的 bug:編輯器只在「有選取中的講稿」時才渲染,而全新使用者(或剛把講稿
 * 刪光的人)沒有任何選取。原本的 importFile 只把內容寫進 draft state——
 * 使用者選了檔案、畫面毫無變化,內容其實已經丢了;更糟的是 dirty 變成 true,
 * 之後切頁或關窗會為一份他根本看不到的內容跳「有未儲存的修改」。
 *
 * 這裡刻意從「零講稿」開始(全新的隔離 userData),走真實的檔案選擇 →
 * 匯入 → 儲存 → 切頁回來還在,確認內容真的有地方落腳。
 *
 * 執行需先 `npm run build`;AI_TP_E2E 由 playwright.config 注入(userData 隔離)。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function launch(): Promise<{ app: ElectronApplication; main: Page }> {
  const app = await electron.launch({ args: ['.'], timeout: 60_000 })
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  let main = first
  for (let i = 0; i < 40; i++) {
    if (await main.evaluate(() => !!document.querySelector('aside')).catch(() => false)) break
    const cand = app.windows().find((w) => w !== main)
    if (cand && (await cand.evaluate(() => !!document.querySelector('aside')).catch(() => false))) main = cand
    await new Promise((r) => setTimeout(r, 250))
  }
  return { app, main }
}

const navTo = async (main: Page, label: string): Promise<void> => {
  await main.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(l))
    btn?.click()
  }, label)
  await main.waitForTimeout(500)
}

const TALK = '開場白\n\n各位好,今天我要分享三個重點,第一是進度,第二是挑戰,第三是下一步。'

test('零講稿時匯入檔案:內容立即出現在編輯器,而且存得下來', async () => {
  test.setTimeout(90_000)
  const { app, main } = await launch()
  try {
    await navTo(main, '提詞講稿')

    // 前提:這是一個沒有講稿的資料庫 —— 編輯器是空狀態(這是 bug 的前提條件)
    await expect(main.locator('text=選擇或建立一份講稿')).toBeVisible({ timeout: 10_000 })
    expect(await main.locator('textarea').count()).toBe(0)

    // 匯入 .md(走真實的隱藏 file input)
    await main.locator('input[type=file]').setInputFiles({
      name: '我的開場白.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(`# ${TALK}`)
    })

    // 核心斷言:編輯器出現了,而且裡面就是剛匯入的內容(不是一個看不到的 state)
    await expect(main.locator('textarea')).toBeVisible({ timeout: 5_000 })
    await expect(main.locator('textarea')).toHaveValue(`# ${TALK}`)
    await expect(main.locator('input[placeholder="講稿標題"]')).toHaveValue('我的開場白')

    // 存下來之後切頁再回來:內容必須還在(證明它是一份真的講稿,不是幽靈)
    await main.locator('button', { hasText: '儲存' }).click()
    await main.waitForTimeout(600)
    await navTo(main, '總覽')
    await navTo(main, '提詞講稿')
    await expect(main.locator('textarea')).toHaveValue(`# ${TALK}`, { timeout: 5_000 })
  } finally {
    await app.close().catch(() => undefined)
  }
})
