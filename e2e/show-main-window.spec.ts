/**
 * show-main-window.spec.ts — 主視窗被「關掉」之後,使用者還回得去主視窗。
 *
 * ## 這條在守什麼
 *
 * 主視窗關掉之後,這個 App 沒有 tray、沒有工作列圖示(浮層是 skipTaskbar),
 * App 可能只剩浮層活著 —— 而浮層的空狀態還在指示「到主視窗『提詞講稿』頁按
 * 『開始提詞』」。指示一條到不了的路,比沒有指示更糟。
 *
 * 修法是浮層上的「主視窗」鈕(IPC.AppShowMain):視窗還活著就 show/focus,
 * 真的不在了就重建。見 docs/UX_FINDINGS.md 第三輪 P0-2。
 *
 * ## 為什麼 audit:effects 不夠
 *
 * 效果稽核量的是「主視窗被**藏起來**(hide)→ 按鈕把它帶回前景」那一支,因為
 * 關掉主視窗會把稽核自己後面所有步驟要用的視窗弄掉(它接下來還有十幾個步驟)。
 * 結果是「真的關掉 → 重建」這半邊 —— 也就是這個修復真正的難處 —— 在自動稽核裡
 * 是**空白**的:一個永遠只在 hide 狀態下量到的按鈕,連線壞掉時稽核仍然是綠的。
 * 這裡補上那一半。
 *
 * ## 為什麼兩條測試都要有
 *
 *   1. 關掉 → 重建(真的壞掉時使用者回不去)
 *   2. 隱藏 → 叫回來,而且**不得**多長一扇視窗
 *
 * 第 2 條防的是相反方向的缺陷:一個「無腦呼叫 createMainWindow」的實作在第 1 條
 * 裡是綠的,但使用者按一次就會多出一扇主視窗,兩扇搶同一份狀態 —— 而症狀是
 * 「按了之後畫面上多了一個東西」,沒有任何一條只驗「回得去」的斷言抓得到。
 *
 * 執行需先 `npm run build`;AI_TP_E2E 由 playwright.config 注入(userData 隔離)。
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp } from './helpers/launch'

const TITLE = '叫回主視窗的回歸'
const CONTENT = '各位好,這份稿存在的唯一目的是讓浮層有一個工具列可以按。'

/**
 * 主視窗的辨識:**只有主視窗有側欄**(與 helpers/launch.ts 同一條規則)。
 *
 * 為什麼不用標題:錄音/錄影時 document.title 會被換成「● 錄音中 — AI 提詞機」
 * (見 lib/captureIndicator.ts),用標題會在錄音中的測試裡指錯視窗。
 *
 * 為什麼不用 URL 反過來推主視窗:這支測試本來就要**關掉**主視窗,而關掉之後
 * 「哪一扇還在」只能靠「誰有側欄」回答。主視窗那側才用 URL 判斷(排除 hash 為
 * overlay 的那一扇),那與 confirm-close.spec.ts 是同一個做法。
 */
async function isMain(p: Page): Promise<boolean> {
  return p
    .evaluate(() => !!document.querySelector('aside'))
    .catch(() => false)
}

/** 在 main 端數「不是浮層的視窗」—— 用來分辨「重建了」與「只是叫回來」。 */
async function mainWindowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((w) => !w.webContents.getURL().includes('overlay')).length
  )
}

/** 主視窗目前可見嗎(同樣在 main 端問,才不會被 Playwright 的 page 狀態騙到)。 */
async function mainWindowVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => !w.webContents.getURL().includes('overlay') && w.isVisible()
    )
  )
}

/** 等一扇有側欄的視窗真的長出來(新建的 BrowserWindow 要等 React 渲染,不是等 load)。 */
async function waitForMainWindow(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const step = 250
  for (let waited = 0; waited <= timeoutMs; waited += step) {
    for (const p of app.windows()) {
      if (p.isClosed()) continue
      if (await isMain(p)) return p
    }
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error(
    `20 秒內沒有任何視窗渲染出側欄。實際視窗數:${app.windows().length}` +
      `,main 端數到的非浮層視窗數:${await mainWindowCount(app)}`
  )
}

/** 浮層工具列 / 空狀態上的「主視窗」鈕(兩處共用同一個 data-effect-id)。 */
const showMainBtn = (overlay: Page) => overlay.locator('[data-effect-id="overlay-show-main"]')

test('主視窗真的被關掉之後:浮層的「主視窗」鈕把它重建回來,而且重建的那扇能用', async () => {
  test.setTimeout(180_000)
  const { app, main, overlay } = await launchApp()
  try {
    expect(overlay, '應該要有一個浮層視窗').toBeTruthy()
    const ov = overlay!

    // 讓浮層開著並載入稿 —— 這才是「使用者把主視窗關掉」的真實前提,
    // 而且浮層可見時 App 不會在寬限期後退出(quitWhenOverlayHidden 會續命)。
    await main.evaluate(
      ([title, content]) => window.api.overlayShow({ title, content }),
      [TITLE, CONTENT] as const
    )
    await expect
      .poll(() => ov.locator('body').innerText(), { timeout: 15_000, intervals: [300, 600, 1_000] })
      .toContain(CONTENT.slice(0, 8))

    // 工具列上的「主視窗」鈕此刻應該只有一顆(空狀態那顆在有稿時不渲染)
    await expect(showMainBtn(ov), '有稿時應該只有工具列那一顆').toHaveCount(1)

    // 真的關掉主視窗。走 close 事件(守衛與寬限計時器都照真的走),不繞過它們。
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.webContents.getURL().includes('overlay')) w.close()
      }
    })

    // 關閉守衛:全新 profile、沒在錄音、沒編輯講稿 → 不應該有 blocker,
    // 主視窗應該**直接**關掉。
    //
    // 判斷順序是這一段的關鍵:守衛只能在主視窗還活著的時候問。頁面一關掉,
    // 再去數它的對話框會拿到「Target page has been closed」—— 那不是「沒有
    // 對話框」,而是「已經沒有東西可以問了」,而這兩件事回傳同一個失敗。
    // 所以改成:先等它真的關掉;若它遲遲不關,而還活著,才是守衛擋下來的證據。
    let blockedByGuard = false
    try {
      await expect.poll(() => main.isClosed(), { timeout: 15_000 }).toBe(true)
    } catch {
      blockedByGuard = true
    }
    if (blockedByGuard) {
      const dialogText = await main
        .locator('[role="dialog"]')
        .first()
        .innerText()
        .catch(() => '(讀不到對話框)')
      throw new Error(
        `全新 profile、沒在錄音、沒編輯講稿,主視窗卻沒有直接關掉 —— ` +
          `畫面上的確認框寫著:${dialogText.replace(/\s+/g, ' ').trim()}。` +
          `這是「關閉守衛在這個前提下不該擋」的失敗,不是後面按鈕的問題。`
      )
    }

    // App 必須還活著,而且只剩浮層 —— 這是這條測試的起點。
    // (浮層可見 → 寬限計時器會續命;若這裡是 0 扇,後面的按鈕根本沒有宿主。)
    expect(await mainWindowCount(app), '主視窗應該真的被關掉了').toBe(0)
    expect(ov.isClosed(), '浮層必須還活著,否則使用者連按鈕都沒有').toBe(false)

    // 按「主視窗」
    await showMainBtn(ov).first().click()

    const revived = await waitForMainWindow(app)
    await expect(revived.locator('aside')).toBeVisible({ timeout: 15_000 })
    expect(await mainWindowCount(app), '只該重建出**一**扇主視窗').toBe(1)
    expect(await mainWindowVisible(app), '重建的主視窗必須是可見的').toBe(true)

    // 重建出來的那扇必須真的能用 —— 「視窗回來了」不等於「App 回來了」。
    // 一扇永遠停在白畫面/空載入畫面的主視窗,與沒有主視窗在使用者眼中是同一件事:
    // 他要的是回到「提詞講稿」,不是回到一塊空白。
    await revived.locator('aside button', { hasText: '提詞講稿' }).first().click()
    await expect(revived.locator('button', { hasText: '新講稿' })).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('主視窗只是被隱藏時:按鈕把它叫回來,而且不得多長一扇主視窗', async () => {
  test.setTimeout(180_000)
  const { app, main, overlay } = await launchApp()
  try {
    expect(overlay, '應該要有一個浮層視窗').toBeTruthy()
    const ov = overlay!

    await main.evaluate(
      ([title, content]) => window.api.overlayShow({ title, content }),
      [TITLE, CONTENT] as const
    )
    await expect
      .poll(() => ov.locator('body').innerText(), { timeout: 15_000, intervals: [300, 600, 1_000] })
      .toContain(CONTENT.slice(0, 8))

    // 隱藏(不是關閉)。使用者「最小化」與被別的視窗蓋住都走到這個狀態。
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.webContents.getURL().includes('overlay')) w.hide()
      }
    })
    await expect.poll(() => mainWindowVisible(app), { timeout: 10_000 }).toBe(false)
    expect(main.isClosed(), '隱藏不等於關閉').toBe(false)

    const before = app.windows().length
    await showMainBtn(ov).first().click()

    await expect.poll(() => mainWindowVisible(app), { timeout: 15_000 }).toBe(true)
    // 視窗還活著,所以這一格必須走 show/focus 而不是重建。
    expect(await mainWindowCount(app), '視窗還活著時不該重建 —— 那會變成兩扇主視窗').toBe(1)
    expect(app.windows().length, '不該多出任何一扇視窗').toBe(before)
    expect(main.isClosed(), '同一扇主視窗被叫回來,不該被換掉').toBe(false)

    // 被叫回來的必須是同一扇、還活著的視窗(側欄還在)
    await expect(main.locator('aside')).toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close().catch(() => undefined)
  }
})
