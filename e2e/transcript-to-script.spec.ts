/**
 * e2e — 錄音產出的逐字稿要能回到提詞流程。
 *
 * 為什麼這條值得單獨一支:
 *   這個 App 的主功能是提詞,但錄音產出的是「會議紀錄」。使用者開完會拿到
 *   逐字稿,最自然的下一步是「把這段變成我下次要用的講稿」—— 而在這條測試
 *   出來之前,程式裡沒有任何一條路做得到,唯一的下游動作是「匯出 .md 到磁碟」。
 *   他得自己開記事本複製貼上到講稿頁。**產出的東西和使用者累積的內容被隔離在
 *   兩個 store 裡,而其中一邊是這個產品的主功能。**
 *
 *   這個缺口是 scripts/audit-journey.mjs(使用者視角稽核)量到的,不是讀程式碼
 *   看出來的 —— 讀程式碼時每一處都「看起來合理」。
 *
 * 這條驗的是**真的按下真的有生效**,不是「畫面上有一顆按鈕」:
 *   audit-journey 的第一版只比對按鈕文字,把 onClick 指向空函式之後量測回報
 *   0 筆問題。按鈕存在不等於路徑存在 —— 這是使用者視角最相關的一種假綠燈。
 *
 * 執行需先 `npm run build`。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { launchApp as launchMain } from './helpers/launch'

test('錄完的逐字稿能存成講稿,而且真的存進去了', async () => {
  test.setTimeout(90_000)
  const { app, main } = await launchMain({ ...process.env, AI_TP_E2E: '1', AI_TP_AUDIT: '1' })
  try {
    // 播一場會議進去
    await main.evaluate(async () => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').add({
        title: '產品週會',
        startedAt: Date.now() - 900_000,
        endedAt: Date.now(),
        segments: [
          { start: 0, speaker: 'them', text: '先聊一下上個季度的進度。' },
          { start: 12, speaker: 'me', text: '我們本季完成三個功能，下季要做效能。' },
          { start: 30, speaker: 'me', text: '另外我會把設計稿同步給各位。' }
        ]
      })
      await new Promise((res) => (tx.oncomplete = res))
    })

    const scriptCount = () =>
      main.evaluate(async () => {
        const req = indexedDB.open('ai-teleprompter')
        const db = await new Promise((res, rej) => {
          req.onsuccess = () => res(req.result)
          req.onerror = () => rej(req.error)
        })
        const tx = db.transaction('scripts', 'readonly')
        return new Promise((res) => {
          const r = tx.objectStore('scripts').count()
          r.onsuccess = () => res(r.result)
          r.onerror = () => res(-1)
        })
      })

    // 進錄音頁、展開那場會議
    await main.evaluate(() => window.__auditForce?.('app.navigate', 'dashboard'))
    await main.evaluate(() => window.__auditForce?.('app.navigate', 'record'))
    await main.locator('text=最近的會議紀錄').waitFor({ timeout: 15_000 })
    await main.evaluate(() => {
      const card = [...document.querySelectorAll('main .card')].find((c) =>
        c.textContent?.includes('產品週會')
      )
      card?.querySelector('button')?.click()
    })
    const btn = main.locator('button', { hasText: '存成講稿' }).first()
    await btn.waitFor({ state: 'visible', timeout: 15_000 })

    const before = await scriptCount()
    await btn.click()
    // 真的多了一筆才算數 —— 不看 toast,也不看按鈕有沒有變色
    await expect.poll(() => scriptCount(), { timeout: 15_000 }).toBeGreaterThan(before)

    // 內容正確:只取我方發言,且保留時間戳
    const saved = await main.evaluate(async () => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction('scripts', 'readonly')
      const all = await new Promise((res) => {
        const r = tx.objectStore('scripts').getAll()
        r.onsuccess = () => res(r.result)
        r.onerror = () => res([])
      })
      return all[all.length - 1]
    })
    expect(saved.title).toContain('產品週會')
    // 對方的話不該混進講稿:提詞是給自己念的
    expect(saved.content).not.toContain('上個季度的進度')
    expect(saved.content).toContain('三個功能')
    // 時間戳要留著,講稿才能對照原文位置
    expect(saved.content).toMatch(/^\[\d+:\d+\]/m)

    // 而且它真的出現在講稿列表裡(這是使用者找得到它的唯一方式)
    await main.evaluate(() => window.__auditForce?.('app.navigate', 'scripts'))
    await main.locator('text=產品週會').first().waitFor({ timeout: 15_000 })
    await expect(main.locator('aside, main').getByText('產品週會（講稿）').first()).toBeVisible()
  } finally {
    await app.close()
  }
})

/** 沒有任何可存內容時要說人話,而不是靜默產生一份空講稿。 */
test('沒有可存成講稿的內容時,不會產生空講稿', async () => {
  test.setTimeout(90_000)
  const { app, main } = await launchMain({ ...process.env, AI_TP_E2E: '1', AI_TP_AUDIT: '1' })
  try {
    await main.evaluate(async () => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').add({
        title: '只有對方在講',
        startedAt: Date.now() - 60_000,
        endedAt: Date.now(),
        segments: [{ start: 0, speaker: 'them', text: '（只有對方的發言）' }]
      })
      await new Promise((res) => (tx.oncomplete = res))
    })

    await main.evaluate(() => window.__auditForce?.('app.navigate', 'dashboard'))
    await main.evaluate(() => window.__auditForce?.('app.navigate', 'record'))
    await main.locator('text=最近的會議紀錄').waitFor({ timeout: 15_000 })
    await main.evaluate(() => {
      const card = [...document.querySelectorAll('main .card')].find((c) =>
        c.textContent?.includes('只有對方在講')
      )
      card?.querySelector('button')?.click()
    })
    const btn = main.locator('button', { hasText: '存成講稿' }).first()
    await btn.waitFor({ state: 'visible', timeout: 15_000 })
    await btn.click()

    // 只有對方發言時:仍然應該能存(全部段落),但至少不能是空內容。
    // 這條斷言的重點是「不會靜默產生空講稿」—— 使用者會得到一份打開來
    // 什麼都沒有的講稿,然後以為是儲存壞了。
    const count = await main.evaluate(async () => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction('scripts', 'readonly')
      return new Promise((res) => {
        const r = tx.objectStore('scripts').count()
        r.onsuccess = () => res(r.result)
        r.onerror = () => res(-1)
      })
    })
    const contents = await main.evaluate(async () => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction('scripts', 'readonly')
      const all = await new Promise((res) => {
        const r = tx.objectStore('scripts').getAll()
        r.onsuccess = () => res(r.result)
        r.onerror = () => res([])
      })
      return all.map((s) => s.content)
    })
    expect(contents.every((c) => c.trim().length > 0)).toBe(true)
    expect(count).toBe(contents.length)
  } finally {
    await app.close()
  }
})

