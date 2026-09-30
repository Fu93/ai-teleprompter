/**
 * confirm-close.spec.ts — App 內確認對話框與關閉視窗守衛的回歸測試。
 *
 * 這一組補的是兩個原本完全不存在的保護:
 *   1. 七處原生 window.confirm 換成 App 內對話框(風格一致、Esc 取消、
 *      預設焦點在取消、Tab 鎖在對話框內)。
 *   2. 關閉視窗時若「講稿有未存變更」會擋下來問 —— 在這之前側欄切頁有確認,
 *      關視窗沒有,而後者損失更徹底。
 *
 * 全部走真實 UI 與真實 IPC(main 擋 close → 通知 renderer → 使用者回答 →
 * confirm/cancel IPC),不是單獨測元件。
 *
 * 執行需先 `npm run build`。
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
  await main.waitForTimeout(400)
}

const clickByText = async (main: Page, text: string): Promise<void> => {
  await main.evaluate((t) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(t))
    btn?.click()
  }, text)
  await main.waitForTimeout(300)
}

/** 建一份新講稿並打字,讓 dirty = true(未存變更的守衛來源) */
async function makeDirty(main: Page): Promise<void> {
  await navTo(main, '提詞講稿')
  // 全新 profile 沒有任何講稿 → 編輯器不會渲染(selectedId 為 null)。
  // 先建一份;此時還不 dirty,不會彈對話框。
  if ((await main.locator('textarea').count()) === 0) {
    await clickByText(main, '新講稿')
    await expect(main.locator('textarea')).toBeVisible({ timeout: 10_000 })
  }
  await main.locator('textarea').fill('第一段用來觸發未儲存狀態的文字。')
  await main.waitForTimeout(250)
}

test('未存變更的確認改用 App 內對話框,且 Esc 等於取消', async () => {
  const { app, main } = await launch()
  test.setTimeout(60_000)
  try {
    await makeDirty(main)

    // 點「新講稿」→ 應該被對話框攔下來,而不是原生 confirm
    await clickByText(main, '新講稿')
    const dialog = main.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(dialog).toContainText('未儲存的修改')

    // 預設焦點在「取消」:破壞性操作不該讓 Enter 直接生效
    const focused = await main.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.getAttribute('data-confirm')
    )
    expect(focused).toBe('cancel')

    // Esc = 取消:對話框消失,而且內容還在(沒有真的丢掉)
    await main.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(main.locator('textarea')).toHaveValue('第一段用來觸發未儲存狀態的文字。')

    // 再點一次並確認 → 這次真的換掉
    await clickByText(main, '新講稿')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await main.locator('[data-confirm="ok"]').click()
    await expect(dialog).toHaveCount(0)
    await expect(main.locator('textarea')).toHaveValue('')
  } finally {
    await app.close()
  }
})

test('Tab 焦點鎖在對話框內,不會跑到背後的側欄', async () => {
  const { app, main } = await launch()
  test.setTimeout(60_000)
  try {
    await makeDirty(main)
    await clickByText(main, '新講稿')
    const dialog = main.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // 對話框裡的兩個按鈕來回循環:連按三次 Tab 應該還是在對話框內
    for (let i = 0; i < 3; i++) await main.keyboard.press('Tab')
    const inside = await main.evaluate(() => {
      const el = document.activeElement
      return !!el?.closest('[role="dialog"]')
    })
    expect(inside).toBe(true)

    // 收尾:先解除守衛再關閉。講稿仍然是 dirty 的,直接 app.close() 會撞上
    // 我們自己的關閉守衛而永遠關不掉(這正是上一版測試卡住的原因)。
    await main.evaluate(() => window.api.setCloseBlocker(null)).catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('未存變更時關閉視窗會被擋下,取消後視窗仍在', async () => {
  const { app, main } = await launch()
  test.setTimeout(60_000)
  try {
    await makeDirty(main)

    // 從 main 端呼叫 close(),走真實的 close 事件處理
    const closeMainWindow = async (): Promise<void> => {
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('overlay'))
        win?.close()
      })
      await main.waitForTimeout(600)
    }

    await closeMainWindow()
    const dialog = main.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(dialog).toContainText('未儲存的修改')
    expect(main.isClosed()).toBe(false)

    // 取消:視窗必須還開著(擋下來之後沒有被強制關掉)
    await main.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(main.isClosed()).toBe(false)

    // 再關一次並確認放棄 → 這次真的關閉
    await closeMainWindow()
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await main.locator('[data-confirm="ok"]').click()
    // 視窗關掉之後 page 就不能再操作了,所以用 poll 而不是 waitForTimeout
    await expect.poll(() => main.isClosed(), { timeout: 8_000 }).toBe(true)
  } finally {
    await app.close().catch(() => undefined)
  }
})
