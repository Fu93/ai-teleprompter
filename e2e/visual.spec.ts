/**
 * 視覺驗證 — 啟動真實 app,逐一觸發本輪 Polish 的功能並截圖存檔。
 * 執行:npx playwright test e2e/visual.spec.ts(需先 npm run build)
 *
 * 觸發路徑皆為真實使用者操作(可重現):
 * - toast:Record 兩來源全不勾 → 「請至少選擇一個音訊來源」;Practice 空職位 → 「請填寫職位或情境」
 * - 折射:開浮層 → 收合成藥丸;Chromium 不支援時驗證「降級路徑」(無折射 class = 正確 fallback)
 *
 * 產出(docs/screenshots/):
 * - 12-toast-stack.png        toast 堆疊(scale 遞減)
 * - 13-toast-hover-pause.png  hover 暫停中的 toast
 * - 14-pill-refraction.png    藥丸折射 + specular(CSS 變數注入後)
 * - 15-overlay-refraction.png 展開浮層狀態
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchApp as launchMain } from './helpers/launch'

/**
 * 用共用 helper 而不是自己寫 firstWindow()。
 * 理由見 helpers/launch.ts:主視窗與浮層同一個檔案,firstWindow() 拿到浮層
 * 是真的會發生,而浮層裡沒有側欄也沒有 `.toast-item` —— 於是這支測試會在
 * 30 秒後以「Timeout exceeded while waiting on the predicate」失敗,看不出原因。
 * 本檔案是全量跑時偶發失敗、單獨跑必綠的其中一個。
 */
async function launchApp(): Promise<{ app: Awaited<ReturnType<typeof launchMain>>['app']; main: Page }> {
  const { app, main } = await launchMain()
  return { app, main }
}

function navTo(main: Page, label: string): void {
  void main.evaluate((l) => {
    const nav = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(l))
    nav?.click()
  }, label)
}

test('toast 堆疊與 hover 暫停截圖', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(90_000)
  try {
    // toast 1:Record 頁,兩來源全不勾 → 按開始聆聽
    navTo(main, '錄音轉錄')
    await main.locator('input[type="checkbox"]').first().waitFor({ state: 'attached' })
    await main.evaluate(() => {
      const mic = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null
      if (mic?.checked) mic.click() // 取消麥克風(系統音訊預設關)
    })
    await main.evaluate(() => {
      const start = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('開始聆聽'))
      start?.click()
    })
    await main.locator('.toast-item').first().waitFor({ state: 'visible', timeout: 10_000 })

    // toast 2:切到 Practice 頁,空職位按開始練習(跨頁堆疊 = 全域 store 的展示)
    navTo(main, '面試練習')
    await main
      .locator('button', { hasText: '開始練習' })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('開始練習'))
      btn?.click()
    })
    // 等「兩則」而不是等固定時間:固定 600ms 在慢機器上不夠,而這支測試
    // 偶發失敗時報的就是「預期 2 實際 1」。
    await expect(main.locator('.toast-item')).toHaveCount(2, { timeout: 10_000 })
    await main.screenshot({ path: 'docs/screenshots/12-toast-stack.png' })

    // hover 暫停:滑入第一則,超過 toast2 剩餘壽命後兩則都還在。
    //
    // 這裡**必須**等真實的 2.5 秒(產品行為:暫停計時器應該在這段期間不計時),
    // 但斷言改成「時間到了之後仍然是 2 則」—— 原本也是這樣,差別在於前面的
    // 等待全部改成條件式,於是這支測試的預算不再被無謂的 sleep 吃光。
    const first = main.locator('.toast-item').first()
    await first.hover()
    await main.waitForTimeout(2500)
    expect(await main.locator('.toast-item').count()).toBe(2)
    await main.screenshot({ path: 'docs/screenshots/13-toast-hover-pause.png' })

    // 移開滑鼠 → 到期消失。
    // 這兩則都是錯誤,停留 12s 而非資訊的 4s(lib/toast.ts 的 ERROR_DISPLAY_MS):
    // 使用者看到「麥克風權限被拒」之後要離開 App 去 Windows 設定改權限再回來,
    // 4 秒不夠他讀完一句話。
    await main.mouse.move(10, 10)
    // 原本是 sleep(4000) 之後斷言「還有 >0 則」。改成直接等到歸零:
    // 「錯誤比資訊久」這件事由 12_000 這個常數與這條等待的時長共同保證,
    // 不需要靠 sleep 精確命中「4 秒剛好過、12 秒還沒到」這個窄窗口 ——
    // 而那個窄窗口正是這支測試偶發失敗的原因。
    await expect(main.locator('.toast-item')).toHaveCount(0, { timeout: 25_000 })
  } finally {
    await app.close()
  }
})

test('藥丸折射 + 輪廓光截圖', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(60_000)
  try {
    navTo(main, '提詞講稿')
    await main.waitForTimeout(500)
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('新講稿'))
      btn?.click()
    })
    await main.waitForTimeout(300)
    await main.locator('textarea').fill('大家好,今天想跟大家分享三個重點。第一是我們的進度,第二是遇到的挑戰,第三是接下來的計畫。')
    await main.waitForTimeout(200)
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('開始提詞'))
      btn?.click()
    })
    await main.waitForTimeout(2000)

    const overlay = app.windows().find((w) => w !== main)
    expect(overlay).toBeTruthy()
    if (!overlay) return
    await overlay.waitForLoadState('domcontentloaded')
    await overlay.waitForTimeout(800)

    // **這條斷言是補上一個真正的量測缺口,不是錦上添花。**
    //
    // 這支測試原本只驗浮層的**外觀**(hasFilter / filterId / hasRefractClass),
    // 所以「浮層開了但沒帶到講稿內容」這種狀態一直是全綠 —— 而那就是使用者
    // 對著一片空白講整場會議。scripts/audit-journey.mjs 這一輪才把它補上,
    // 證據取自**另一個視窗的實際文字**,不是主視窗按鈕的狀態。
    //
    // 為什麼值得寫進 e2e:稽核是「每次發布跑一次」,而這是使用者 100% 會走
    // 的主流程 —— 它值得有一條每次都跑的回歸。
    const SENTINEL = '大家好,今天想跟大家分享三個重點'
    const overlayText = await overlay.evaluate(() => document.body?.innerText || '')
    expect(
      overlayText,
      '浮層必須真的帶到剛剛輸入的講稿內容 —— 只驗外觀會讓「空白浮層」一直通過'
    ).toContain(SENTINEL)

    // 引擎能力偵測(與 app 內 CSS.supports 同判準)
    const chromiumRefract = await overlay.evaluate(() =>
      CSS.supports('backdrop-filter', 'url(#x)') || CSS.supports('-webkit-backdrop-filter', 'url(#x)')
    )

    // 15:展開浮層整體狀態
    await overlay.screenshot({ path: 'docs/screenshots/15-overlay-refraction.png' })

    // 收合成藥丸
    await overlay.locator('[title*="收合成藥丸"]').click()
    await overlay.waitForTimeout(1200) // 等 morph 彈簧收斂

    const info = await overlay.evaluate(() => ({
      hasFilter: !!document.getElementById('liquid-glass'),
      filterId: document.getElementById('liquid-glass')?.querySelector('filter')?.id ?? null,
      hasRefractClass: !!document.querySelector('.glass-refract'),
      hasRim: !!document.querySelector('.lg-rim')
    }))

    if (chromiumRefract) {
      // 支援引擎:filter 注入 + pill 套用折射
      expect(info.hasFilter).toBe(true)
      expect(info.filterId).toBe('liquid-glass-f')
      expect(info.hasRefractClass).toBe(true)
    } else {
      // 降級路徑:不套折射 class(@supports 擋住)= 正確 fallback
      expect(info.hasRefractClass).toBe(false)
    }
    // 輪廓改由 CSS 的方向性 rim light 表達;游標 specular 與彩色呼吸光暈
    // 都已移除(見 CHANGELOG 的 Liquid Glass 改版),這裡確保它們不會回來。
    expect(info.hasRim).toBe(true)
    const removed = await overlay.evaluate(() => ({
      spec: !!document.querySelector('.glass-specular'),
      glow: getComputedStyle(document.querySelector('.dynamic-island-pill')!, '::before').content
    }))
    expect(removed.spec).toBe(false)
    expect(removed.glow).not.toContain('""') // 舊的呼吸光暈 ::before 已不存在

    // 靈動島改版的兩條反向錨定:
    //  1. 藥丸必須是「真膠囊」:radius ≥ 高的一半(rounded-full 的 9999px 由引擎
    //     繪製時夾到 h/2,所以比對的是「不小於」;半徑較小就是圓角長方形,
    //     也就是「看起來像有白邊的長方形」那個症狀)。
    //  2. 藥丸 root **不能**有任何動畫:舊版的 content-morph-in(delay 120ms +
    //     fill both)讓 morph 的前 120ms 整顆膠囊是空白的,那是量得到的缺陷。
    const island = await overlay.evaluate(() => {
      const el = document.querySelector('.dynamic-island-pill')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
        h: r.height,
        w: r.width,
        animations: el.getAnimations().length
      }
    })
    expect(island).not.toBeNull()
    expect(island!.radius).toBeGreaterThanOrEqual(island!.h / 2 - 1)
    expect(island!.w / island!.h).toBeLessThan(7) // 比例:不再是 8:1 的狀態列
    expect(island!.animations).toBe(0)

    await overlay.waitForTimeout(400)
    await overlay.screenshot({ path: 'docs/screenshots/14-pill-refraction.png' })
  } finally {
    await app.close()
  }
})
