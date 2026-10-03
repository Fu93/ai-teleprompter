/**
 * e2e — 設定必須真的存下來，而且使用者關掉 App 不會遺失。
 *
 * 為什麼這條測試要用「固定 userData 重啟兩次」而不是一般 e2e 的做法:
 *   AI_TP_E2E=1 會讓 main 把 userData 重導到 `ai-teleprompter-e2e-${Date.now()}`
 *   （見 src/main/index.ts）—— 每個實例都是全新目錄。**那對隔離是對的，
 *   但它讓「跨啟動持久化」在這個 harness 底下原理上不可能被驗證。**
 *   而持久化正是這支測試的全部重點。所以這裡刻意不設 AI_TP_E2E，改用
 *   固定的 --user-data-dir，並在前後清乾淨。
 *
 * 它抓到過一個真缺陷（已修）：兩個 API Key 欄位是 onChange 更新本地 state、
 * **onBlur 才存檔**，而同一頁其他 14 個欄位都是 onChange 立刻存。
 * 使用者「打完金鑰 → 直接關視窗」時那個 blur 事件不一定發生，於是輸入的
 * 金鑰整個遺失、**沒有任何提示**，下次打開看到空白欄位只會以為自己記錯。
 * 負向驗證：還原成 onBlur-only 時本測試讀回 null。
 *
 * 執行需先 `npm run build`。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const UD = join(tmpdir(), 'e2e-settings-persistence')

/**
 * 刻意**不**設 AI_TP_E2E。
 *
 * playwright.config.ts 會把 `process.env.AI_TP_E2E` 設成 '1'，而 main 看到它
 * 就執行 `app.setPath('userData', temp/ai-teleprompter-e2e-${Date.now()})`
 * （src/main/index.ts:21）—— **`--user-data-dir` 會被完全忽略**。
 *
 * 對隔離而言那是對的（測試資料不汙染真實使用者資料），但它讓這支測試要驗的
 * 「跨啟動持久化」**在原理上不可能成立**：每次啟動都是一個全新目錄。
 *
 * 我就是這樣誤判成「普通欄位也存不住」的：單獨用 `node` 跑探針時環境裡
 * 沒有 AI_TP_E2E，`--user-data-dir` 生效所以通過；用 Playwright 跑就必敗。
 * **同一段程式碼、同一個宣稱，只因為繼承了別人設的環境變量而有兩種結果。**
 *
 * 傳一份去掉 AI_TP_E2E 的 env 給子程序即可，只影響這個 Electron，不動共用
 * 的 process.env —— 同一個 worker 程序還會跑其他 spec。
 */
async function boot(): Promise<{ app: import('@playwright/test').ElectronApplication; main: Page }> {
  const env = { ...process.env }
  delete env.AI_TP_E2E
  const app = await electron.launch({ args: ['.', `--user-data-dir=${UD}`], env: env as Record<string, string>, timeout: 60_000 })
  let main: Page | undefined
  for (let i = 0; i < 60 && !main; i++) {
    for (const w of app.windows()) {
      if (await w.evaluate(() => !!document.querySelector('aside')).catch(() => false)) {
        main = w
        break
      }
    }
    if (!main) await new Promise((r) => setTimeout(r, 250))
  }
  if (!main) throw new Error('15 秒內沒有任何視窗渲染出側欄')
  return { app, main }
}

/** 沒有 __auditForce（未開 AI_TP_AUDIT），所以走真實的側欄點擊。 */
async function gotoSettings(main: Page): Promise<void> {
  await main.evaluate(() => {
    const b = [...document.querySelectorAll('aside button')].find(
      (x) => x.textContent?.includes('設定')
    ) as HTMLElement | undefined
    b?.click()
  })
  await main.waitForTimeout(1500)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => rmSync(UD, { recursive: true, force: true }))
test.afterAll(() => rmSync(UD, { recursive: true, force: true }))

test('改設定 → 關掉 App → 重開，值還在（普通欄位與 API Key 都要在）', async () => {
  test.setTimeout(120_000)
  const OLLAMA = 'http://localhost:9999'
  const KEY = 'sk-persistence-regression-1'

  // ── 第一次啟動:改兩個值 ──
  {
    const { app, main } = await boot()
    await gotoSettings(main)

    // API Key:先切到 OpenAI 相容分支（欄位只在這個分支渲染）
    await main.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        x.textContent?.includes('OpenAI 相容')
      )
      b?.click()
    })
    await main.waitForTimeout(900)

    // 普通欄位:onChange 立刻存（原本就正確，這裡當對照組）。
    // **順序有意義**:切到 OpenAI 分支之後 Ollama 欄位就不渲染了,
    // 所以它必須在切換之後填 —— 我第一版把它寫在前面,結果重開後讀到預設值,
    // 差點誤判成「普通欄位也存不住」。那是測試的錯:單獨量過,
    // 填完 getSettings 立刻讀回就是新值。
    await main.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        x.textContent?.includes('Ollama（本地免費）')
      )
      b?.click()
    })
    await main.waitForTimeout(900)
    const ollama = main.locator('input[aria-label="Ollama 位址"]').first()
    await ollama.waitFor({ state: 'visible', timeout: 15_000 })
    await ollama.click()
    await ollama.fill(OLLAMA)
    await main.waitForTimeout(800)

    // 再切回 OpenAI 才能填金鑰 —— 兩個分支互斥,這是產品設計不是 bug
    await main.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        x.textContent?.includes('OpenAI 相容')
      )
      b?.click()
    })
    await main.waitForTimeout(900)
    const key = main.locator('input[aria-label="API Key"]').first()
    await key.waitFor({ state: 'visible', timeout: 15_000 })
    await key.click()
    // **逐字輸入,不點任何東西** —— 模擬使用者打完就去關視窗
    await key.type(KEY, { delay: 15 })
    await main.waitForTimeout(1300) // 等 debounce(600ms)

    // 不 blur、不切頁、不點任何東西,直接關
    await app.close()
  }

  await new Promise((r) => setTimeout(r, 1500))

  // ── 第二次啟動:兩個值都要讀得回來 ──
  {
    const { app, main } = await boot()
    await gotoSettings(main)

    // **用 IPC 讀,不從 DOM 讀。**
    // 「Ollama 位址」欄位只在 provider==='ollama' 分支渲染,而這條測試最後
    // 停在 openai 分支(為了填金鑰)—— 從 DOM 讀會拿到空值,看起來像
    // 「沒存住」。我第一版就這樣誤判成普通欄位也存不住,差點多修一個
    // 根本不存在的 bug。**證據要取自資料層,不是畫面。**
    const ollama = await main.evaluate(async () => {
      const st = await window.api.getSettings()
      return st.ai?.ollama?.baseUrl
    })
    expect(ollama, '普通欄位必須跨啟動保留').toBe(OLLAMA)

    // 直接問 IPC,不繞 DOM:DOM 層可能因為分支沒展開而看不到欄位,
    // 那會讓「讀不到」和「沒存到」混在一起,分不出是哪一種。
    const keys = await main.evaluate(async () => (await window.api.keysGet?.()) ?? null)
    expect(keys, 'API Key 必須跨啟動保留（打完直接關視窗也算）').not.toBeNull()
    expect(keys?.apiKey).toBe(KEY)

    await app.close()
  }
})

test('切換 AI 供應商也會跨啟動保留', async () => {
  test.setTimeout(120_000)
  {
    const { app, main } = await boot()
    await gotoSettings(main)
    await main.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        x.textContent?.includes('Ollama（本地免費）')
      )
      b?.click()
    })
    await main.waitForTimeout(900)
    await app.close()
  }
  await new Promise((r) => setTimeout(r, 1500))
  {
    const { app, main } = await boot()
    await gotoSettings(main)
    // Ollama 分支渲染時,「API Key」欄位不應該存在 —— 用它當切換成功的證據
    const provider = await main.evaluate(async () => {
      const s = await window.api.getSettings()
      return s.ai?.provider
    })
    expect(provider, 'provider 必須跨啟動保留').toBe('ollama')
    await app.close()
  }
})
