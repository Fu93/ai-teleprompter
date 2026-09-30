/**
 * overlay-hide-follow.spec.ts — 浮層被隱藏時,語音跟讀必須自己收手。
 *
 * 為什麼這是一條隱私回歸:
 *   浮層隱藏只是「視窗不顯示」,裡面的 renderer 照常執行。語音跟讀一旦啟動,
 *   AudioSegmenter + Whisper worker 會繼續開著麥克風、繼續把使用者的每一句話
 *   轉成文字,而畫面上沒有任何指示。使用者按熱鍵「關掉提詞機」時要的是它閉嘴,
 *   不是讓它變成背景錄音機。
 *
 * 兩件事一起驗:
 *   1. main 的可見性廣播同時送到浮層視窗(原本只送主視窗,浮層是唯一不知道
 *      自己被藏起來的一方 —— 沒有這一半,後面那半不可能發生)。
 *   2. 隱藏時跟讀真的被停掉,而且重新顯示時會說明「已自動停止」(使用者回來
 *      看到跟讀自己停了,不能讓他以為是壞掉)。
 *
 * 執行需先 `npm run build`;AI_TP_E2E 由 playwright.config 注入(userData 隔離)。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function launch(): Promise<{ app: ElectronApplication; main: Page; overlay: Page }> {
  const app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    timeout: 60_000
  })
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

const bodyText = (p: Page): Promise<string> => p.evaluate(() => document.body.innerText)

const TITLE = '跟讀回歸測試'
const CONTENT = '各位好,今天要跟大家介紹三個重點。這是用來測試語音跟讀的講稿內容。'

test('浮層隱藏時自動停止語音跟讀,並在重新顯示時說明', async () => {
  test.setTimeout(120_000)
  const { app, main, overlay } = await launch()
  try {
    // 換一份講稿 → 展開形態的自動播放與跟讀按鈕才會出現
    await main.evaluate(
      ([title, content]) => window.api.overlayShow({ title, content }),
      [TITLE, CONTENT] as const
    )
    await overlay.waitForTimeout(1_500)

    // 預設形態可能是上次留下的藥丸/貼鏡(設定會跨啟動保留)→ 先明確展開
    if ((await overlay.locator('[title="語音跟讀:唸到哪、捲到哪(需麥克風)"]').count()) === 0) {
      await overlay.locator('[title="展開完整面板"]').click()
      await overlay.waitForTimeout(1_400)
    }

    // 在浮層裡記錄 main 廣播過來的可見性事件
    await overlay.evaluate(() => {
      const w = window as unknown as { __vis: boolean[] }
      w.__vis = []
      window.api.onOverlayVisibility((v) => w.__vis.push(v))
    })

    await overlay.locator('[title="語音跟讀:唸到哪、捲到哪(需麥克風)"]').click()

    // 跟讀啟動的瞬間狀態就是 loading(模型載入是非同步的),不需要模型真的下載完
    let started: 'loading' | 'error' | null = null
    for (let i = 0; i < 40; i++) {
      const t = await bodyText(overlay)
      if (t.includes('載入模型')) {
        started = 'loading'
        break
      }
      if (t.includes('跟讀啟動失敗')) {
        started = 'error'
        break
      }
      await overlay.waitForTimeout(125)
    }

    // 這一段與模型是否可下載無關:浮層必須收到「我被藏起來了」
    const beforeHide = await overlay.evaluate(() => (window as unknown as { __vis: boolean[] }).__vis)
    expect(beforeHide).not.toContain(false)

    // 走真正的使用者路徑:按浮層工具列的「關閉」。
    // 注意選擇器必須是「關閉(」——工具列上還有兩顆開關的 title 是
    // 「關閉「該你說話了」提示」與「關閉即時教練…」,用 ^=「關閉」會先命中它們
    // (實際踩過:點了等於只把提示開關關掉,視窗根本沒藏,而斷言看起來只是「沒收到事件」)。
    await overlay.locator('[title^="關閉("]').first().click()
    await overlay.waitForTimeout(800)

    const afterHide = await overlay.evaluate(() => (window as unknown as { __vis: boolean[] }).__vis)
    expect(afterHide).toContain(false)

    if (started !== 'loading') {
      // 沒有模型可用時跟讀會直接進入 error,「隱藏時停止」這條路徑就無從觸發。
      // 寧可明確跳過,也不要寫一條永遠會過的假斷言。
      test.skip(true, `跟讀未能進入 loading(此環境無法載入 Whisper 模型:${started ?? '狀態列未出現'})`)
    }

    // 隱藏期間狀態列不得再顯示載入中/聆聽中
    const hiddenText = await bodyText(overlay)
    expect(hiddenText).not.toContain('載入模型')
    expect(hiddenText).not.toContain('聆聽中')

    // 重新顯示:使用者必須被告知跟讀已停,而不是默默發現它不見了。
    // 必須一起帶上 content —— 沒有稿的浮層只會渲染「尚未載入講稿」,
    // 而提示條長在正文區塊裡,就永遠看不到。
    await main.evaluate(
      ([title, content]) => window.api.overlayShow({ title, content }),
      [TITLE, CONTENT] as const
    )
    await overlay.waitForTimeout(1_200)
    await expect(overlay.locator('text=已自動停止語音跟讀').first()).toBeVisible({ timeout: 5_000 })
  } finally {
    await app.close().catch(() => undefined)
  }
})
