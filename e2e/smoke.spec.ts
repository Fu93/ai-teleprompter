/**
 * e2e 煙霧測試 — 以真實 Electron 進程啟動 app,走真 IPC 鏈
 * (v3 e2e/teleprompter-flow.spec.js 的精神,配新專案架構)
 *
 * 執行前需先 `npm run build`(測試載入 out/ 產物)。
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp as launchMain } from './helpers/launch'
import { waitOverlayFeedbackReady } from './helpers/turnYield'

/**
 * 用共用 helper 啟動,而不是自己寫 `app.firstWindow()`。
 *
 * 這不是重構洁癖 —— 是因為 `firstWindow()` **不保證是主視窗**:主視窗與浮層都
 * loadFile 同一個 index.html(浮層只多一個 `#/overlay` hash),而浮層可能先完成 load。
 * 本檔案原本自己寫 firstWindow(),於是「浮層 = windows().find(w => w !== main)」
 * 會在 firstWindow() 拿到浮層時**指向主視窗**。症狀是浮層提示怎麼等都不出現
 * (因為那個「浮層」其實是 dashboard),而錯誤訊息完全看不出真正原因。
 *
 * helpers/launch.ts 以 `aside`(側欄)辨識主視窗 —— 只有主視窗有。
 * 完整說明見那份檔案的註解。
 */
async function launchApp(): Promise<{ app: ElectronApplication; main: Page }> {
  const { app, main } = await launchMain()
  return { app, main }
}

test('啟動後有主視窗 + 浮層視窗,標題正確', async () => {
  const { app, main } = await launchApp()
  try {
    // renderer 側標題
    expect(await main.title()).toBe('AI 提詞機')
    // 浮層視窗與主視窗同時建立,但載入完成有先後 → 輪詢等待
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
  } finally {
    await app.close()
  }
})

test('preload 橋接可用:appInfo 回傳版本與平台', async () => {
  const { app, main } = await launchApp()
  try {
    const info = await main.evaluate(() => window.api.appInfo())
    expect(info.version).toBeTruthy()
    expect(info.platform).toBe('win32')
    expect(info.userDataPath).toContain('ai-teleprompter')
    // e2e 進程以 AI_TP_E2E=1 啟動,除錯能力必須是關的:否則除錯面板會出現在
    // 每一張稽核截圖與 DOM 稽核裡,量到的就不是使用者所見(見 src/main/debug.ts)
    expect(info.debug).toBe(false)
  } finally {
    await app.close()
  }
})

test('scene:list 經 IPC 回傳內建 8 場景 + pack 場景', async () => {
  const { app, main } = await launchApp()
  try {
    const scenes = await main.evaluate(() => window.api.sceneList())
    const keys = scenes.map((s) => s.key)
    expect(keys).toEqual(
      expect.arrayContaining(['interview', 'sales', 'investor', 'podcast', 'demo', 'support', 'defense', 'default'])
    )
    // 場景包含模板(fallback 用)
    expect(scenes.find((s) => s.key === 'interview')?.label).toBe('Job Interview')
  } finally {
    await app.close()
  }
})

test('設定讀寫經 IPC 生效且含 scenario 區塊', async () => {
  const { app, main } = await launchApp()
  try {
    const settings = await main.evaluate(() => window.api.getSettings())
    // 持久化設定可能被使用者改過 → 驗證結構與合法值域,不假設具體值
    expect(['scroll', 'phrase', 'bullet', 'karaoke']).toContain(settings.overlay.displayMode)
    expect(typeof settings.scenario.activeScene).toBe('string')
    expect(settings.scenario.activeScene.length).toBeGreaterThan(0)
    expect(typeof settings.scenario.aiModeEnabled).toBe('boolean')
    expect(settings.overlay.glass).toBeDefined()
    expect(typeof settings.hotkeys.panicRescue).toBe('string')
    expect(settings.hotkeys.panicRescue.length).toBeGreaterThan(0)
    // 寫入→讀回往返
    const roundTrip = await main.evaluate(async () => {
      const prev = (await window.api.getSettings()).overlay.rate
      await window.api.setSettings({ overlay: { rate: 1.5 } })
      const after = (await window.api.getSettings()).overlay.rate
      await window.api.setSettings({ overlay: { rate: prev } })
      return after
    })
    expect(roundTrip).toBe(1.5)
  } finally {
    await app.close()
  }
})

test('turn-yield:對方問句經 IPC → 浮層顯示「該你說話了」提示', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(60_000)
  try {
    // 浮層視窗載入有先後 → 輪詢等待
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    // main 已由 helpers/launch.ts 以 `aside` 確認是主視窗,所以「不是 main 的
    // 那一個」這才真的等於浮層。
    const overlay = app.windows().find((w) => w !== main)
    expect(overlay).toBeTruthy()
    await overlay!.waitForLoadState('domcontentloaded')

    // 強制開啟(使用者可能關過;開關持久化在 settings.json)
    await main.evaluate(() => window.api.setSettings({ overlay: { turnYield: true } }))
    // **先把浮層叫出來。**
    //
    // 這不是多此一舉 —— 這支測試原本是**在隱藏的浮層上通過的**。浮層以
    // `show: false` 建立(createOverlayWindow)且沒有 ready-to-show→show,
    // 預設就是隱藏的;而 Playwright 的 waitForSelector 判的是 DOM 盒子有沒有
    // 版面,win.hide() 之後照樣有。所以「提示有渲染出來」不等於「使用者看得到」。
    //
    // sendTurnYield 現在會檢查 isVisible() 拒絕對隱藏浮層回報送達(否則 25 秒
    // 冷卻會被一個沒人看過的提示吃掉),一改這支測試就紅 —— 而紅的原因正是
    // 它原本在量一件使用者永遠不會遇到的事。
    await main.evaluate(() => window.api.overlayShow({ title: '提詞', content: '測試內容' }))
    // 經真 IPC 推對方問句(與 Record 頁系統音訊轉錄相同的 context:push-transcript 路徑)
    // main 偵測問句語尾 → 1.2s 防抖 → 廣播 context:turn-yield → 浮層提示
    //
    // **這裡原本是一個「重試到訊號出現為止」的 expect.poll,而它結構上不可能成功。**
    // 重試送的是同一句話,而 turnYield.ts 的規則 1(同句 25 秒冷卻)會把
    // 第 2 次起的每一次重試都擋成 null —— 就算浮層早就準備好了也發不出訊號。
    // 於是這支測試只能靠「第一次 push 剛好贏得競態」通過,輸了就必紅。
    // 真正的競態(浮層還沒套用 turnYield=true)是**可以直接觀察到的**:
    // 工具列那顆按鈕的 title 會翻成「關閉「該你說話了」提示」。等它翻好再推,
    // 一次就成功。完整病因見 e2e/helpers/turnYield.ts。
    await waitOverlayFeedbackReady(overlay!, { turnYield: true })

    await main.evaluate(() =>
      window.api.pushTranscript({ text: '可以請你介紹一下你自己嗎', speaker: 'them' })
    )
    await overlay!.waitForSelector('text=該你說話了', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

/**
 * 隱藏的浮層不該「吃掉」那句問話。
 *
 * 這是本專案第一個產品缺陷的**後一半**。sendTurnYield() 原本只要視窗存在且未銷毀
 * 就回報已送達。但浮層是以 `show: false` 建立的(createOverlayWindow,沒有
 * ready-to-show→show),而使用者按熱鍵收掉它走的是 win.hide() —— 視窗活著、
 * renderer 活著、useTurnYield 照樣 setHint(),然後 6 秒的 HINT_DISPLAY_MS
 * 在沒人看的狀態裡走完。於是 25 秒同句冷卻與 15 秒全域冷卻都被一個
 * 「從來沒被看見的提示」記帳了。
 *
 * 症狀與「浮層根本不存在」完全一樣:那句話不見了,而且接下來 25 秒不會再提示。
 * 但隱藏比不存在常見得多 —— 「我不提詞」的正常動作就是按熱鍵把它收掉。
 *
 * 判別力在最後兩步:
 *   隱藏 → 推問句 A(A 不得留下任何冷卻)
 *   顯示 → **馬上**推問句 B → 必須出現提示
 *
 * B 是另一句話,所以規則 1(同句 25 秒)擋不住它;擋得住的是規則 2 的 15 秒
 * 全域冷卻 —— 而那只有「A 記了帳」才會存在。**所以 B 出現 = A 沒被記帳。**
 * 把 sendTurnYield 的 isVisible() 拿掉,這支測試必紅(已實測:紅在最後一步,
 * B 的提示 15 秒都等不到)。
 *
 * 中間本來還有一條「隱藏時不該有提示」的斷言,**已刻意拿掉**:實測它在修好與
 * 沒修好的版本裡**都會通過**(隱藏視窗的 setTimeout 被 Chromium 節流,防抖觸發時間
 * 不穩),也就是說它量不到任何東西。留著一條抓不到東西卻長得像防線的斷言,
 * 比沒有更糟 —— 下一次有人改壞了它會是綠的,而沒有人知道它從來沒紅過。
 * 只留最後一步:那一條是真的抓得住(拿掉 isVisible() 時實測紅在此行)。
 */
test('浮層隱藏時的搶話訊號不記冷卻:叫回浮層後立刻能再提示', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(60_000)
  try {
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const overlay = app.windows().find((w) => w !== main)
    expect(overlay).toBeTruthy()
    await overlay!.waitForLoadState('domcontentloaded')

    // 主程序端的浮層視窗 id:renderer 端看不到自己視窗的可見性,
    // 而「看不看得見」正是這支測試的前提,所以必須從主程序問。
    const overlayId = await app.evaluate(({ BrowserWindow }) => {
      // dev 是 #/overlay、packaged 是 #overlay(loadFile 的 hash 會吃掉斜線),兩種都收
      const isOverlay = (u: string): boolean => u.endsWith('#overlay') || u.endsWith('#/overlay')
      const w = BrowserWindow.getAllWindows().find((x) => isOverlay(x.webContents.getURL()))
      return w ? w.id : -1
    })
    expect(overlayId).toBeGreaterThan(0)
    const overlayVisible = (): Promise<boolean> =>
      app.evaluate(({ BrowserWindow }, id) => {
        const w = BrowserWindow.fromId(id)
        return !!w && !w.isDestroyed() && w.isVisible()
      }, overlayId)

    await main.evaluate(() => window.api.setSettings({ overlay: { turnYield: true } }))
    await main.evaluate(() => window.api.overlayShow({ title: '提詞', content: '測試內容' }))
    await waitOverlayFeedbackReady(overlay!, { turnYield: true })
    expect(await overlayVisible()).toBe(true)

    // 收掉浮層 —— 與按熱鍵同一條路徑(IPC.OverlayHide → setOverlayVisible(false) →
    // win.hide())。視窗與 renderer 都還活著,這正是這個 bug 成立的前提。
    await main.evaluate(() => window.api.overlayHide())
    await expect.poll(overlayVisible).toBe(false)

    const hint = overlay!.locator('text=該你說話了')

    // 問句 A:送出去了,但沒有人看得到。
    await main.evaluate(() =>
      window.api.pushTranscript({ text: '請問這個專案的資料管線是怎麼設計的', speaker: 'them' })
    )
    // 這裡刻意**不斷言**「隱藏時 DOM 裡沒有提示」:實測那條在兩種版本都會過,
    // 抓不到東西(理由見上方註解)。冷卻是否被記帳,由下面 B 的提示決定。

    // 問句 B:浮層叫回來之後**馬上**推。
    await main.evaluate(() => window.api.overlayShow({ title: '提詞', content: '測試內容' }))
    expect(await overlayVisible()).toBe(true)
    await main.evaluate(() =>
      window.api.pushTranscript({ text: '那你怎麼處理資料延遲的問題', speaker: 'them' })
    )
    await hint.waitFor({ state: 'visible', timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('即時教練:搶話訊號經 IPC → 浮層顯示教練提示', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(60_000)
  try {
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const overlay = app.windows().find((w) => w !== main)
    expect(overlay).toBeTruthy()
    await overlay!.waitForLoadState('domcontentloaded')

    await main.evaluate(() => window.api.setSettings({ overlay: { coaching: true } }))
    // 同樣的原因把浮層叫出來:浮層預設隱藏,而 win.hide() 之後 Playwright 仍然
    // 讀得到 DOM。教練訊號沒有冷卻所以不受 sendTurnYield 那個修影響,但
    // 「在藏起來的視窗裡找到元素」本來就不是使用者會遇到的情境。
    await main.evaluate(() => window.api.overlayShow({ title: '提詞', content: '測試內容' }))
    // 對方剛講完 → 2s 內我方開口 = 搶話。
    // 兩段必須在同一個 evaluate 內背靠背送出:分開兩次呼叫在併跑負載下
    // 可能間隔超過 2s 判定窗,搶話不觸發(併跑 flake 來源)。
    //
    // 這裡原本也是「重試到訊號出現為止」,同樣結構上無效,而且比 turn-yield 更嚴重:
    // interrupt 的冷卻窗是 **180 秒**(coachingRules.ts DEFAULT_COOLDOWNS.interrupt),
    // 而冷卻是在規則引擎評估時就記下的 —— 第一次推送只要讓規則命中,
    // 後續 30 秒內的重試全部被自己的冷卻擋掉。註解說「與其猜延遲不如重試」,
    // 但重試正是唯一不可能成功的方法。
    //
    // 改成等可觀察的屏障(按鈕 title 翻成「即時教練開啟中」= 浮層真的套用了
    // coaching=true),然後只推一次。斷言不變,走的仍是
    // 真 IPC → main 教練判定 → 浮層渲染 的完整路徑。
    await waitOverlayFeedbackReady(overlay!, { coaching: true })

    await main.evaluate(() => {
      void window.api.pushTranscript({ text: '那我們請你說明一下這個案例的背景', speaker: 'them' })
      void window.api.pushTranscript({ text: '這個專案主要是我負責資料管線的設計', speaker: 'me' })
    })
    await overlay!.waitForSelector('text=打斷對方', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
/**
 * P2:執行中拔螢幕 / 改解析度會讓浮層座標失效而「靜默消失」——
 * 使用者在台上沒有任何錯誤提示,只能靠盲按熱鍵猜。
 * 這支測試兩個出口:重新顯示時的自動拉回,與工具列的「置中」按鈕。
 */
test('浮層掉出畫面:自動拉回 + 工具列「置中」按鈕', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(60_000)
  try {
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const overlayPage = app.windows().find((w) => w !== main)!
    await overlayPage.waitForLoadState('domcontentloaded')
    await main.evaluate(() => window.api.overlayShow({ title: '置中測試', content: '測試內容' }))

    // 浮層與主視窗共用同一份 index.html,標題都是「AI 提詞機」,
    // 只能用 URL hash(#/overlay)區分 —— 這也是先前測試抓錯視窗的原因。
    const overlayId = await app.evaluate(({ BrowserWindow }) => {
      // dev 是 #/overlay、packaged 是 #overlay(win.loadFile 的 hash 會吃掉斜線),兩種都收
      const isOverlay = (u: string): boolean => u.endsWith('#overlay') || u.endsWith('#/overlay')
      const w = BrowserWindow.getAllWindows().find((x) => isOverlay(x.webContents.getURL()))
      return w ? w.id : -1
    })
    expect(overlayId).toBeGreaterThan(0)

    const posOf = (): Promise<number> =>
      app.evaluate(({ BrowserWindow }, id) => {
        const w = BrowserWindow.fromId(id)
        return w && !w.isDestroyed() ? w.getPosition()[0] : Number.POSITIVE_INFINITY
      }, overlayId)
    const shoveOffscreen = (): Promise<void> =>
      app.evaluate(({ BrowserWindow }, id) => {
        BrowserWindow.fromId(id).setPosition(-4000, -4000)
      }, overlayId)

    // 模擬「執行中拔掉螢幕」:推到遠離任何螢幕的座標
    await shoveOffscreen()
    // 先確認前提成立,避免測試在「其實沒推出去」的假前提下通過
    expect(await posOf()).toBeLessThan(-3000)

    // 出口 1:自動防護 —— 重新顯示時 setOverlayVisible 會先 ensureOverlayOnScreen
    await main.evaluate(() => window.api.overlayShow({ title: '置中測試', content: '測試內容' }))
    await expect.poll(posOf).toBeGreaterThan(-3000)

    // 出口 2:使用者手動 —— 工具列「置中」按鈕
    await shoveOffscreen()
    expect(await posOf()).toBeLessThan(-3000)

    const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    // 用 DOM click 而非真實指標點擊:浮層是 transparent + alwaysOnTop 的無邊框視窗,
    // 真實點擊還要過 Playwright 的 actionability(命中測試)檢查,在滿載時會不穩。
    // 而這裡要驗證的是「按鈕 → preload → IPC → 視窗移動」這條鏈,不是浮層的點擊穿透
    // ——穿透由 setOverlayVisible 處理,另有測試涵蓋。
    await overlayPage.locator('button[title^="浮層置中"]').dispatchEvent('click')
    // 落在工作區內,而不只是「x 座標變正」
    await expect.poll(posOf).toBeGreaterThan(workArea.x - 10)
    await expect.poll(posOf).toBeLessThan(workArea.x + workArea.width)
  } finally {
    await app.close()
  }
})
