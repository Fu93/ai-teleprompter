/**
 * e2e — 崩潰復原畫面(ErrorBoundary)
 *
 * 為什麼這件事需要真的 e2e:
 *   「renderer 渲染期丟錯之後畫面長什麼樣」是這個 App 最貴的失敗模式,而它
 *   **沒有任何一條 headless 測試碰得到** —— 你得先把樹真的弄壞。
 *   在有這條測試之前,ErrorBoundary 只是一段看起來合理的程式碼:沒有人知道
 *   復原畫面會不會自己也被邊界吃掉、有沒有按鈕、按了會不會真的重來。
 *
 * 怎麼弄壞:
 *   走 audit 強制橋(AI_TP_AUDIT=1,見 src/main/debug.ts 的 AUDIT)。掛在
 *   CrashProbe 上而不是用一個會壞掉的 fixture 頁,是因為要保證「崩潰的是
 *   真實的 App 子樹」,而不是測試專用頁 —— 後者量到的是測試頁的行為。
 *
 * 斷言的四件事(每一件都對應一個使用者會問的問題):
 *   1. 畫面上真的有可讀的訊息與三顆可操作的鈕?（不是白畫面、不是 stack trace）
 *   2. 「你會失去什麼」是從 main 讀出來的實況,還是猜的?
 *   3. 錯誤有落盤,而且落盤的是 componentStack 而不是只有 JS stack?
 *   4. 點重新載入之後 App 真的回來了?
 *
 * 執行需先 `npm run build`。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

async function launch(): Promise<{ app: ElectronApplication; main: Page }> {
  const env = { ...process.env, AI_TP_E2E: '1', AI_TP_AUDIT: '1' }
  const app = await electron.launch({ args: ['.'], timeout: 60_000, env })
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

/** main 端 userData 由 AI_TP_E2E=1 重導到 temp;日誌路徑要先問 main 才知道 */
async function readMainLog(app: ElectronApplication): Promise<string> {
  // 只把 userData 字串帶回來,在 Node 端 join。
  // 那個 evaluate 環境裡沒有 import callback 也沒有 require
  // (實測兩者都擲:dynamic import → "A dynamic import callback was not specified";
  //  require → "require is not defined"),所以路徑只能在測試進程組。
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const p = join(userData, 'logs', 'main.log')
  return existsSync(p) ? readFileSync(p, 'utf-8') : ''
}

/** 走側欄真實導航到指定頁 */
async function navTo(main: Page, label: string): Promise<void> {
  await main.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('aside button')).find((b) => b.textContent?.includes(l))
    btn?.click()
  }, label)
  await main.waitForTimeout(500)
}

test.describe('崩潰復原畫面', () => {
  test('渲染期例外被接住:可讀訊息 + 三顆鈕 + 重新載入真的回來', async () => {
    const { app, main } = await launch()
    try {
      expect(await main.evaluate(() => !!document.querySelector('aside'))).toBe(true)

      // 先記下 log 長度,後面只比對「新增的」那一段 —— 舊內容不該算數
      const before = (await readMainLog(app)).length

      const forced = await main.evaluate(() => (window as any).__auditForce?.('crash.render', true))
      expect(forced?.ok, `強制橋應該可用: ${JSON.stringify(forced)}`).toBe(true)

      const screen = main.locator('[data-testid="crash-screen"]')
      await expect(screen).toBeVisible({ timeout: 5000 })

      // 1) 講人話,不是 stack trace。整頁文字不該是英文錯誤堆疊。
      const text = (await screen.innerText()).trim()
      expect(text).toContain('畫面出了問題')
      expect(text).not.toMatch(/at\s+\w+\s+\(/)
      // 使用者最需要的一句:已存的東西安全
      expect(text).toContain('已存進資料庫的內容不會受影響')

      // 三顆可操作鈕,每一顆都要有可及名稱(不依賴圖示)
      await expect(screen.getByRole('button', { name: /複製錯誤詳細資料/ })).toBeVisible()
      await expect(screen.getByRole('button', { name: /開啟記錄資料夾/ })).toBeVisible()
      const reload = screen.locator('[data-crash="reload"]')
      await expect(reload).toBeVisible()
      await expect(reload).toHaveText(/重新載入/)

      // 2) 「你會失去什麼」此刻是查得到的(沒有未存內容),所以不能停在
      //    「正在讀取…」的等待狀態 —— 那會讓使用者以為壞掉了
      await expect(screen).toContainText('未存內容', { timeout: 5000 })

      // 3) 日誌:必須有 componentStack,而 window.onerror 只寫得出 JS stack
      const after = await readMainLog(app)
      const added = after.slice(before)
      expect(added, '崩潰必須落盤').toContain('ErrorBoundary:')
      expect(added, '必須有 componentStack,那是「哪個元件拋的」的唯一來源').toContain('componentStack')
      expect(added).toContain('故意丟出的渲染期錯誤')

      // 4) 重新載入真的回來
      await reload.click()
      await expect(main.locator('aside')).toBeVisible({ timeout: 20_000 })
      await expect(main.locator('[data-testid="crash-screen"]')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('有未存內容時,重新載入前必須先問一次(不直接吃掉使用者的東西)', async () => {
    const { app, main } = await launch()
    try {
      // 走真實的使用者路徑:到講稿頁 → 開新講稿 → 輸入,產生「未存變更」
      // (先前這裡漏了導航,「新講稿」鈕在講稿頁而不在總覽頁,於是整段靜默 no-op)
      await navTo(main, '提詞講稿')
      await main.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('新講稿'))
        btn?.click()
      })
      await main.waitForTimeout(500)
      const filled = await main.evaluate(() => {
        const ta = document.querySelector('textarea')
        if (!ta) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(ta, '還沒存的草稿')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })
      expect(filled, '講稿頁應該有一個可輸入的內容欄位').toBe(true)
      await main.waitForTimeout(600)

      // 用「使用者看得見的訊號」確認未存變更真的產生了:工具列的鈕在已存時
      // 寫「已儲存」,有未存時寫「儲存」。不去讀內部狀態。
      // (鈕裡面有一顆 icon,textContent 帶前導空白,所以用 trim 後的完全比對)
      const saveBtn = main.locator('button').filter({ hasText: /儲存/ }).first()
      await expect(saveBtn).toHaveText(/^\s*儲存\s*$/, { timeout: 5000 })

      await main.evaluate(() => (window as any).__auditForce?.('crash.render', true))
      const screen = main.locator('[data-testid="crash-screen"]')
      await expect(screen).toBeVisible({ timeout: 5000 })

      // 復原畫面必須把 App 崩潰當下記下的實況講出來,而不是通用話術。
      // 講稿頁的守衛訊息是「「<標題>」有未儲存的修改。」,所以斷言那個特徵字串。
      await expect(screen).toContainText('重新載入會失去', { timeout: 5000 })
      await expect(screen).toContainText('有未儲存的修改')
      await expect(screen).not.toContainText('未存內容」是空的')

      // 點重新載入 → 不該直接重載,要先出確認
      await screen.locator('[data-crash="reload"]').click()
      const confirmBox = screen.getByRole('alertdialog')
      await expect(confirmBox).toBeVisible()
      await expect(confirmBox).toContainText('確定要重新載入嗎')

      // 選「先不要」→ 畫面還在,App 還沒被吃掉
      await confirmBox.getByRole('button', { name: '先不要' }).click()
      await expect(confirmBox).toHaveCount(0)
      await expect(main.locator('[data-testid="crash-screen"]')).toBeVisible()

      // 再按一次並確認 → 這次才真的重載
      await screen.locator('[data-crash="reload"]').click()
      await screen.getByRole('alertdialog').getByRole('button', { name: '還是重新載入' }).click()
      await expect(main.locator('aside')).toBeVisible({ timeout: 20_000 })
    } finally {
      await app.close()
    }
  })
})
