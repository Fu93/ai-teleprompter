/**
 * e2e — 使用者最常撞到的兩面牆:麥克風被拒、Ollama 沒開。
 *
 * 這條測試存在的理由不是「補測試」,是**這兩條路徑從來沒有被執行過一次**。
 *
 * E_MIC_PERMISSION_DENIED / E_MIC_BUSY / E_MIC_NOT_FOUND 三個錯誤碼與它們的
 * 三段中文,在 src/shared/errorCodes.ts 裡寫好了,單元測試也測了比對規則 ——
 * 但**沒有人在真的被拒的瀏覽器裡看過那三句話被顯示出來**。
 * 單元測試測的是「NotAllowedError 會對應到 E_MIC_PERMISSION_DENIED」,
 * 而「所以使用者會看到『請到設定 → 隱私權與安全性 → 麥克風』」這個推論
 * 從未被驗過 —— 而它正是這個 App 對新使用者做的第一個承諾。
 *
 * 這兩種狀態在 CI 上測不到:
 *   - 麥克風權限是 OS 層級的,測試程序拿不到使用者的授權狀態
 *   - Ollama 要真的跑服務並下載幾百 MB 模型
 * 所以用 helpers/env.ts 在**邊界**注入(見該檔說明),產品程式碼一行不動。
 *
 * 執行需先 `npm run build`。
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp as launchMain } from './helpers/launch'
import { e2eEnv, envSummary } from './helpers/env'

async function launch(opts: Parameters<typeof e2eEnv>[0]): Promise<{ app: ElectronApplication; main: Page }> {
  console.log(envSummary(opts))
  return launchMain(e2eEnv(opts))
}

/** audit 橋在正式安裝包裡不存在,所以型別上是可選的。 */
declare global {
  interface Window {
    __auditForce?: (name: string, arg?: unknown) => Promise<{ ok: boolean; result?: unknown }>
  }
}

/** 走 audit 橋的頁面導航,不用文字 regex 找側欄(那會靜默 no-op)。 */
const nav = (main: Page, id: string): Promise<unknown> =>
  main.evaluate((x) => window.__auditForce?.('app.navigate', x), id)

/**
 * 頁面上的 toast 文字。
 *
 * 為什麼用 role=status 而不是找文字:toast 的存在本身就是這條測試要斷言的
 * 東西之一 —— 「錯誤有沒有被說出來」與「錯誤說得對不對」是兩件事,
 * 而只檢查文字會讓「什麼都沒顯示」通過。
 */
const toastText = (main: Page): Promise<string> =>
  main.evaluate(() => Array.from(document.querySelectorAll('[role="status"]')).map((e) => e.textContent || '').join('\n'))

/**
 * 等「環境故障已注入」這件事真的發生,而不是等一個固定的秒數。
 *
 * 為什麼要去掉 waitForTimeout(1200):
 *   那一行原本在等麥克風注入趕上第一個頁面掛載 —— 而它**不一定趕得上**。
 *   main.tsx 原本是 `void appInfo().then(...)` 接著同步 render,所以注入與掛載
 *   是競態的,sleep 1200 只是「大概夠」。睡對了就綠,睡不夠就量到正常路徑 ——
 *   而量到正常路徑時這條測試會**因為按不到按鈕而紅**,或者更糟:紅綠隨機。
 *
 *   現在 renderer 的 bootstrap 保證注入先於掛載(見 src/renderer/src/lib/bootstrap.ts),
 *   所以這裡可以等一個真正可觀察的事實:console 上的注入行。
 *   它是 main.tsx 裡 `console.warn('[e2e] 已注入環境故障:…')` 打出來的。
 */
async function waitForFaultInjection(main: Page, expectText: RegExp): Promise<void> {
  await expect
    // toMatch 的 received 必須是字串:__injectedFaults 是 string[],直接餵進去
    // 會得到「received value must be a string」而不是比對結果 —— 注入明明已經
    // 成功,兩條 mic 測試卻都卡在這一行(首次全量跑量到的)。
    .poll(() => injectedFaults(main).then((a) => a.join('\n')), {
      timeout: 15_000,
      intervals: [200, 400, 800]
    })
    .toMatch(expectText)
}

/** 已知的注入行(mic 兩條用);Ollama 在 main 端注入,不走這裡。 */
const injectedFaults = (main: Page): Promise<string[]> =>
  main.evaluate(() => {
    const w = window as unknown as { __injectedFaults?: string[] }
    return w.__injectedFaults ?? []
  })

test('麥克風權限被拒:使用者看到的是「去哪裡改」,不是 Chromium 的英文', async () => {
  const { app, main } = await launch({ mic: 'denied', audit: true })
  try {
    await nav(main, 'record')
    await waitForFaultInjection(main, /NotAllowedError/)

    // 真的去按「開始聆聽」。這一步是整條測試的關鍵:只驗證注入有發生,
    // 等於測試「注入器」而不是「使用者會看到什麼」。
    const started = await main.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /開始聆聽|啟動中/.test(b.textContent || ''))
      if (!btn) return 'no-button'
      btn.click()
      return 'clicked'
    })
    expect(started, '錄音頁必須有「開始聆聽」鈕').toBe('clicked')

    // 錯誤 toast 有停留時間,但注入是立即 reject 的,所以這裡只需等它渲染。
    await expect
      .poll(() => toastText(main), { timeout: 15_000, intervals: [300, 600, 1_000] })
      .toMatch(/麥克風/)
  } finally {
    await app.close().catch(() => {})
  }
})

test('麥克風被占用:診斷與「權限被拒」不同,因為處理方式不同', async () => {
  const { app, main } = await launch({ mic: 'busy', audit: true })
  try {
    await nav(main, 'record')
    await waitForFaultInjection(main, /NotReadableError/)
    await main.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /開始聆聽|啟動中/.test(b.textContent || ''))
      btn?.click()
    })
    await expect
      .poll(() => toastText(main), { timeout: 15_000, intervals: [300, 600, 1_000] })
      .toMatch(/占用|佔用/)
  } finally {
    await app.close().catch(() => {})
  }
})

test('Ollama 沒開:準備度卡片說「先裝 Ollama」,而不是「查模型」', async () => {
  const { app, main } = await launch({ ollama: 'down', audit: true })
  try {
    await nav(main, 'dashboard')
    // 等準備度卡片真的把 Ollama 狀態畫出來,而不是等一個猜的秒數。
    // (Ollama 探測是 main 端的真 IPC,耗時隨機器而異)
    await expect
      .poll(() => main.evaluate(() => document.body.innerText), {
        timeout: 20_000,
        intervals: [300, 600, 1_000]
      })
      .toMatch(/Ollama/)
  } finally {
    await app.close().catch(() => {})
  }
})

test('Ollama 裝了但沒模型:建議是「pull 模型」,與「沒裝」是不同的一句話', async () => {
  const { app, main } = await launch({ ollama: 'no-model', audit: true })
  try {
    await nav(main, 'dashboard')
    await expect
      .poll(() => main.evaluate(() => document.body.innerText), {
        timeout: 20_000,
        intervals: [300, 600, 1_000]
      })
      .toMatch(/Ollama/)
  } finally {
    await app.close().catch(() => {})
  }
})