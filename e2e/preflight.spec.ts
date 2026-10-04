/**
 * e2e — 第一次使用的準備度卡片
 *
 * 這條測的是這個 App 最貴的一個失敗模式:使用者第一次打開、按下第一顆鈕,
 * 之後看到「ollama pull qwen2.5:7b」——一句要他在**終端機**裡打的指令,
 * 而且前面沒有任何說明。這個 App 就死在這裡,死得沒有任何錯誤訊息。
 *
 * 兩個方向都要量,因為這是同一個元件的兩面:
 *   - 沒有模型:卡片必須出現,而且**每一件事都要能點下去做**。
 *     只會顯示「請檢查您的設定」是等於沒做。
 *   - 有模型:卡片必須收掉。一個永遠亮著的警告會訓練使用者忽略它,
 *     那下一次真的出問題時他們也不會看了。
 *
 * 怎麼製造兩種狀態:
 *   走 audit 橋(preflight.models)攔截 ollamaListModels 的結果 ——
 *   不去真的裝 Ollama,那在 CI 上不可能。
 *
 * 執行需先 `npm run build`。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import './helpers/auditBridge' // 宣告 window.__auditForce 的型別(帶 any 的稽核橋接從此不需要)

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

/** 走 audit 橋的頁面導航,不用文字 regex 找側欄(那會靜默 no-op) */
const nav = (main: Page, id: string): Promise<unknown> =>
  main.evaluate((x) => window.__auditForce?.('app.navigate', x), id)

/** 攔截 ollamaListModels 的結果。null = 讓它真的去查(測試環境必然失敗)。 */
const setModels = (main: Page, models: string[] | null): Promise<unknown> =>
  main.evaluate((m) => window.__auditForce?.('preflight.models', m), models)

test.describe('第一次使用的準備度', () => {
  test('沒有模型:卡片出現,而且 ollama pull 指令可複製', async () => {
    const { app, main } = await launch()
    try {
      // 模擬「Ollama 裝好了但還沒拉任何模型」—— 這是最常見也最致命的一格
      await setModels(main, [])
      await nav(main, 'settings')

      const card = main.locator('[data-preflight="card"]')
      await expect(card, '沒有模型時必須出現卡片').toBeVisible({ timeout: 8000 })
      await expect(card).toHaveAttribute('data-severity', 'blocking')

      // 必須講清楚「裝好了但沒模型」,而不是笼統的「AI 不可用」
      const item = card.locator('[data-preflight-item="ai-ollama-no-model"]')
      await expect(item).toBeVisible()
      await expect(item).toContainText('Ollama 裝好了')
      await expect(item).toContainText('終端機')

      // 核心:指令必須**可複製**。使用者要在他自己的終端機打這行字,
      // 手抄 40 個字元錯一個就是又一轮除錯。
      const cmd = item.locator('code')
      await expect(cmd).toHaveText('ollama pull qwen2.5:7b')
      const copyBtn = item.getByRole('button', { name: /複製指令/ })
      await expect(copyBtn).toBeVisible()
      await expect(copyBtn).toHaveAttribute('aria-label', /ollama pull qwen2\.5:7b/)
      await copyBtn.click()
      // 無障礙名稱也要跟著變:aria-label 會取代可見文字,只寫「複製指令：…」的話
      // 螢幕閱讀器使用者按下去之後完全沒有回饋
      await expect(item.getByRole('button', { name: /已複製指令/ })).toBeVisible({ timeout: 3000 })

      // 每件事都要有下一步:卡片不能只是一段說明文字
      await expect(item.getByRole('button', { name: /去設定頁/ })).toBeVisible()

      // 擋路級不能有「知道了」—— 解決之前不該能消失
      await expect(item.getByRole('button', { name: /知道了/ })).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('Ollama 沒裝:給下載連結,而不是叫你去 pull 一個不存在的東西', async () => {
    const { app, main } = await launch()
    try {
      // installed=false 是「沒裝 / 沒連上」,和「裝了沒模型」是兩件事
      await main.evaluate(() => window.__auditForce?.('preflight.ollamaDown', true))
      await nav(main, 'settings')

      const item = main.locator('[data-preflight-item="ai-ollama-down"]')
      await expect(item).toBeVisible({ timeout: 8000 })
      await expect(item).toContainText('先安裝並啟動 Ollama')
      await expect(item).toContainText('https://ollama.com/download/windows')
      // 對沒裝的人說「去 pull 模型」是白費一趟 —— 必須先有安裝連結
      await expect(item).not.toContainText('ollama pull')
      const dl = item.getByRole('button', { name: /下載 Ollama/ })
      await expect(dl).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('有模型:卡片收掉,改顯示「都準備好了」', async () => {
    const { app, main } = await launch()
    try {
      // 只給 AI 模型;STT 保持 local,所以仍會有一則「第一次會下載」的可關閉提示。
      // 因此這裡斷言的是「**擋路卡片**不見了」而不是「整張卡片不見」。
      await setModels(main, ['qwen2.5:7b', 'llama3:8b'])
      await nav(main, 'settings')

      await expect(main.locator('[data-preflight-item="ai-ollama-no-model"]')).toHaveCount(0, { timeout: 8000 })
      await expect(main.locator('[data-preflight-item="ai-ollama-down"]')).toHaveCount(0)

      // 剩下的是「第一次錄音會下載」—— 這是有用的資訊,不是缺陷
      const notice = main.locator('[data-preflight-item="stt-local-download"]')
      await expect(notice).toBeVisible()
      await expect(notice).toContainText('MB')
      // 可關閉的提示必須真的能關掉,否則它每次都在那裡
      await notice.getByRole('button', { name: /知道了/ }).click()
      await expect(notice).toHaveCount(0)

      // 關掉之後要出現正向回饋,不然使用者會以為自己不小心弄壞了什麼
      await expect(main.locator('[data-preflight="ready"]')).toBeVisible()
      await expect(main.locator('[data-preflight="ready"]')).toContainText(
        '目前沒有待處理項目；本地語音模型仍可能在首次錄音時下載。'
      )
    } finally {
      await app.close()
    }
  })

  test('總覽頁也有一行提示,而且不擋路 —— 進得去才會想留下來', async () => {
    const { app, main } = await launch()
    try {
      await setModels(main, [])
      await nav(main, 'dashboard')

      const compact = main.locator('[data-preflight="compact"]')
      await expect(compact).toBeVisible({ timeout: 8000 })
      await expect(compact).toContainText('還差')
      // 卡片不能擋住使用者的路 —— 畫面上的其他東西必須照樣在
      // (那句「設定與提詞本身不受影響」只出現在 full 卡片,compact 是一行摘要;
      //  「不擋路」是透過下面這些東西還在畫面上來斷言的,不是透過文案)
      // 那是 <p> 不是 heading,所以用文字斷言
      //
      // 下面兩行斷的是**新手分支的文案**,不是「有文案就好」:這支 spec 開的是
      // 全新隔離 profile(零講稿、零會議、零練習),所以總覽的第一句應該是
      // 「歡迎開始使用」而不是「歡迎回來」(第四輪 P1-1:無條件的「歡迎回來」會
      // 讓剛裝好的使用者以為這個 App 記得他)。
      //
      // 別把它改回「歡迎回來」:那等於要求那個缺陷回來。回頭使用者的分支由
      // audit:journey(播種資料後回到總覽)與 copyConsistency 測試的接線斷言守住。
      await expect(main.locator('body')).toContainText('三大模式，隨時待命 —— 從「3 分鐘上手」開始。')
      await expect(main.locator('aside')).toBeVisible()
      await expect(main.getByRole('heading', { name: '歡迎開始使用' })).toBeVisible()
    } finally {
      await app.close()
    }
  })
})
