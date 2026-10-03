/**
 * video-recording.spec.ts — 錄影提詞的守衛。
 *
 * 這一條補的是一道**原本完全不存在**的防線:
 *
 *   錄音轉錄有三道(closeGuard / 側欄離頁守衛 / 退出前 flush + powerSave),
 *   而錄影提詞一道都沒有:`useCloseGuard` 只吃 dirty、App 沒有把 onGuardChange
 *   傳給 Scripts、`powerSaveStart` 全 repo 只有 Record 呼叫。
 *
 *   症狀有兩種,而且都沒有任何畫面會說:
 *     1. 錄影中按 X → 主視窗銷毀 → renderer 跟著死 → `recorder.onstop` 根本
 *        不跑 → 存檔對話框不出現 → **整段錄影無聲消失**。
 *     2. 錄影中點側欄 → unmount 直接 `recorder.stop()` → 使用者只是想切個頁面,
 *        卻被丟一個存檔對話框,而且錄影已經結束了。
 *
 * 為什麼這條測試**必須存在**:整個 e2e 目錄原本 grep 不到「錄影」一次 ——
 * 最資料密集的功能剛好是唯一完全沒被測的那一個,而這個 repo 自己的結論是
 * 「元件內的接線,單元測試測不到」。
 *
 * 兩個刻意的設計決定:
 *   - 走**真實 UI**:點真的「錄影提詞」按鈕,讓真的 MediaRecorder 開起來。
 *     用稽核橋直接設狀態的話,驗到的是「對話框會顯示」而不是「錄影中的介面
 *     真的會擋住關窗」——後者才是使用者遇到的那件事。
 *   - **絕不讓原生存檔對話框出現**。Playwright 關不掉它,測試會掛在那裡。
 *     所以收尾一律先 abort(它把 isRecording 放下、刪掉暫存檔),之後錄音器
 *     停止時 `finish` 會回「沒有進行中的錄影」→ 走 toast 分支,不會彈對話框。
 *     這同時驗證了「收尾失敗不會去開對話框」這條路。
 *
 * 執行需先 `npm run build`。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function launch(): Promise<{ app: ElectronApplication; main: Page; overlay: Page }> {
  const app = await electron.launch({
    args: ['.', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    timeout: 60_000
  })
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  let main = first
  for (let i = 0; i < 40; i++) {
    if (await main.evaluate(() => !!document.querySelector('aside')).catch(() => false)) break
    const cand = app.windows().find((w) => w !== main)
    if (cand && (await cand.evaluate(() => !!document.querySelector('aside')).catch(() => false))) main = cand
    await new Promise((r) => setTimeout(r, 250))
  }
  const overlay = app.windows().find((w) => w !== main) ?? main
  return { app, main, overlay }
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

/** 有內容的講稿(錄影提詞在空稿上是 disabled),並且跳過 3-2-1 倒數 */
async function scriptReady(main: Page): Promise<void> {
  // 倒數會讓「按了之後什麼都還沒發生」多出 2.4 秒的空窗。跳過它不影響被測行為 ——
  // 被測的是「錄影中」的守衛,不是倒數本身。
  await main.evaluate(() => localStorage.setItem('rec-countdown-off', '1'))
  await navTo(main, '提詞講稿')
  if ((await main.locator('textarea').count()) === 0) {
    await clickByText(main, '新講稿')
    await expect(main.locator('textarea')).toBeVisible({ timeout: 10_000 })
  }
  await main.locator('textarea').fill('這是一段用來驗證錄影守衛的講稿內容。')
  await main.waitForTimeout(250)
}

/** 按「錄影提詞」並等到錄影真的在跑(rec-stop 出現) */
async function startRecording(main: Page): Promise<void> {
  await clickByText(main, '錄影提詞')
  // 開攝影機 + 開暫存檔 + 建 MediaRecorder:假裝置下這整條路是通的,
  // 但要給它時間。15 秒是實測值的三倍。
  await expect(main.locator('[data-effect-id="rec-stop"]')).toBeVisible({ timeout: 15_000 })
}

/**
 * 收尾:把錄影結掉,**不要**讓原生存檔對話框出現。
 * 先 abort(放下 isRecording + 刪暫存檔),再清 blocker,最後關 App。
 */
async function teardown(app: ElectronApplication, main: Page): Promise<void> {
  await main.evaluate(() => window.api.videoRecordingAbort().catch(() => undefined)).catch(() => undefined)
  await main.evaluate(() => window.api.setCloseBlocker(null)).catch(() => undefined)
  await app.close().catch(() => undefined)
}

const closeMainWindow = async (app: ElectronApplication): Promise<void> => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('overlay'))
    win?.close()
  })
}

test('錄影中關閉視窗會被擋下,取消後視窗與錄影都還在', async () => {
  const { app, main } = await launch()
  test.setTimeout(120_000)
  try {
    await scriptReady(main)
    await startRecording(main)

    await closeMainWindow(app)

    // 守衛的作用是「先說清楚會丟什麼」:訊息必須指名錄影,而不是泛泛的未存變更
    const dialog = main.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog).toContainText('正在錄影')

    // 取消 → 視窗還在,錄影計時器也還在(沒有任何東西被停掉)
    await main.locator('[data-confirm="cancel"]').click()
    await expect(dialog).toHaveCount(0)
    await expect(main.locator('[data-effect-id="rec-stop"]')).toBeVisible()
  } finally {
    await teardown(app, main)
  }
})

test('錄影中點側欄會先確認,取消後留在講稿頁且錄影沒停', async () => {
  const { app, main } = await launch()
  test.setTimeout(120_000)
  try {
    await scriptReady(main)
    await startRecording(main)

    // 這是原本**沒有**的那道:App.navigate 只帶了 scriptsDirty,錄影中的
    // 離頁等於 unmount 直接停掉錄影
    await main.locator('aside button', { hasText: '總覽' }).first().click()

    const dialog = main.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog).toContainText('正在錄影')

    await main.locator('[data-confirm="cancel"]').click()
    await expect(dialog).toHaveCount(0)

    // 留在原頁,而且錄影沒被停掉(按鈕還在、狀態沒變)
    await expect(main.locator('aside button', { hasText: '總覽' }).first()).toBeVisible()
    await expect(main.locator('[data-effect-id="rec-stop"]')).toBeVisible()
  } finally {
    await teardown(app, main)
  }
})

/**
 * 阻擋系統睡眠的**兩半**都要驗:錄影中擋住、結束後放開。
 *
 * 「放開」那一半原本沒辦法驗 —— 要觀察它得先停止錄影,而正常停止會開出
 * 一個 Playwright 關不掉的原生存檔對話框。這裡先從 main 把暫存檔 abort 掉,
 * 於是 onstop 的 `finish` 回「沒有進行中的錄影」→ 走 toast 分支、不開對話框,
 * 而 setRecording(false) 照樣觸發 powerSave 的 cleanup。順帶驗了
 * 「收尾失敗不會去開對話框」這條路。
 */
/**
 * 現在有幾個電源阻擋。
 *
 * Electron 的 powerSaveBlocker **沒有 getIds()** —— 它只提供 `isStarted(id)`。
 * id 是從 0 開始遞增的小整數,所以掃前 32 個就夠(而且這是測試端的實作
 * 細節,不影響被測行為)。
 */
const readPowerBlockers = async (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ powerSaveBlocker }) => {
    let n = 0
    for (let id = 0; id < 32; id++) {
      try {
        if (powerSaveBlocker.isStarted(id)) n++
      } catch {
        // id 不存在或已釋放:繼續
      }
    }
    return n
  })

test('錄影中阻擋系統睡眠,結束後釋放', async () => {
  const { app, main } = await launch()
  test.setTimeout(120_000)
  try {
    await scriptReady(main)
    expect(await readPowerBlockers(app), '還沒開錄就該沒有電源阻擋').toBe(0)

    await startRecording(main)
    expect(await readPowerBlockers(app), '錄影中必須阻擋系統睡眠').toBeGreaterThan(0)

    // 先放掉暫存檔(見上方註解),再按「停止錄影」
    await main.evaluate(() => window.api.videoRecordingAbort().catch(() => undefined))
    await main.locator('[data-effect-id="rec-stop"]').click()
    await expect(main.locator('[data-effect-id="rec-stop"]')).toHaveCount(0, { timeout: 15_000 })

    expect(await readPowerBlockers(app), '錄影結束後必須釋放電源阻擋').toBe(0)
  } finally {
    await teardown(app, main)
  }
})

/**
 * 退出前 flush 的**負向驗證**。
 *
 * main 端 quitGuard 的呼叫點對「掛鉤不存在」是**靜默放行**:
 *   `window.__aiTpFlushRecording ? window.__aiTpFlushRecording() : false`
 * 所以 Scripts.tsx 那個掛鉤 effect 若被誤刪,quit 流程不會出任何錯 ——
 * 症狀會退回「錄影中關機,整段錄影無聲消失」的原始問題,只靠下次啟動的
 * 孤兒檔復原兜底。這一條是「拿掉掛鉤時唯一會紅的地方」,
 * 與 quit-flush.spec.ts 對會議錄音掛鉤的同一道防線成對。
 *
 * 順帶正向驗證 flush 本身:呼叫掛鉤要回 true(videoRecordingFinish 真的關檔),
 * 而且錄影介面回到停止態。quittingRef 讓這條路**不彈**存檔對話框 ——
 * 關機時沒有人能回答對話框,這正是掛鉤存在的理由。
 */
test('退出前 flush 的掛鉤存在,而且真的能收尾錄影', async () => {
  const { app, main } = await launch()
  test.setTimeout(120_000)
  try {
    await scriptReady(main)
    await startRecording(main)

    const hasHook = await main.evaluate(
      () => typeof (window as Window & { __aiTpFlushRecording?: unknown }).__aiTpFlushRecording === 'function'
    )
    expect(
      hasHook,
      '退出前收尾錄影的掛鉤必須掛在 window 上(main 的 quitGuard 以 executeJavaScript 呼叫它;拿掉 Scripts.tsx 的掛鉤 effect,這一行就會紅)'
    ).toBe(true)

    // 切片是 500ms 一片:等兩片以上落地再 flush。剛開錄就 flush 的話,
    // 0-byte 的暫存檔被 finish 如實判成 'empty' 丟棄 —— 那是產品的正確
    // 契約(不值得存的東西不留),不是這條要量的行為。
    await main.waitForTimeout(2_000)

    const flushed = await main.evaluate(
      () => (window as Window & { __aiTpFlushRecording?: () => Promise<boolean> }).__aiTpFlushRecording!()
    )
    expect(flushed, '退出前 flush 必須真的收尾錄影(videoRecordingFinish 回 ok)').toBe(true)

    // 收尾後與按「停止錄影」同一個終態:錄影按鈕消失
    await expect(main.locator('[data-effect-id="rec-stop"]')).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await teardown(app, main)
  }
})
