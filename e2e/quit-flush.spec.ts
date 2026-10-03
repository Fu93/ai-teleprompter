/**
 * e2e — 錄音中退出,逐字稿不能靜默消失。
 *
 * ## 這條在守什麼
 *
 * 逐字稿全程只存在 renderer 的 React state,按下「停止」才寫進 IndexedDB。
 * 而 `before-quit` 會繞過視窗守衛(否則 OS 關機會被一個沒人能回答的確認框卡住),
 * `autoInstallOnAppQuit = true` 又讓「自動更新下載完就退出安裝」是常見路徑。
 * 兩者相加的結果原本是:**使用者正在錄音時關機或更新,整場會議無聲無息地消失。**
 *
 * 修法是在退出前把手上已有的東西存一次(見 src/main/quitGuard.ts 與
 * src/renderer/src/lib/sessionPersist.ts)。
 *
 * ## 這條測的是 renderer 那一半,為什麼這樣切
 *
 * main 端是 `webContents.executeJavaScript('window.__aiTpFlushRecording()')`。
 * 所以這裡呼叫的是**同一個掛鉤**:元件真的掛載、refs 是真的、寫入真的進 Dexie。
 * main 端「呼叫掛鉤、擋一次退出、逾時放行」那部分是 src/main/quitGuard.ts,
 * 由單元測試釘住(它需要 electron 的事件循環,在 e2e 裡測反而不可靠)。
 *
 * 為什麼不真的 `app.quit()`:關掉之後就沒有視窗可以讀 IndexedDB 了,要驗結果
 * 就得重開另一個實例,那時 dev 的 userData 是否同一份又是另一個變數。
 * 這條要釘的是「退出前存檔這條路徑真的會寫」,不是「App 關掉後資料還在」——
 * 後者是 IndexedDB 自己的性質。
 *
 * 為什麼不為了測試在 Record.tsx 加注入用的掛鉤:那會讓產品程式多一條只給測試
 * 走的路,而它自己沒有被任何使用者情境驗證過。走真的錄音路徑(假麥克風白噪 +
 * 雲端 STT mock)代價是多等幾秒,換掉的是「測試量到的不是產品」。
 *
 * 執行需先 `npm run build`。
 */
import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { launchApp as launchMain } from './helpers/launch'

/**
 * 雲端 STT 的 mock:收下音訊,回一段固定文字,夠讓 Record 頁有東西可存。
 * 監聽 0 埠讓 OS 挑一個空埠 —— 寫死 8080 會和別的測試/服務打架,
 * 而那種衝突的症狀是「這條測試偶爾失敗」而不是「埠被占用」。
 */
async function startSttMock(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: '退出前存檔的測試逐字稿' }))
    })
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('mock STT 拿不到連接埠')
  return { port: addr.port, close: () => new Promise<void>((res) => server.close(() => res())) }
}

test('錄音中退出:逐字稿被存進來,而且不會存成兩場', async () => {
  test.setTimeout(120_000)
  const stt = await startSttMock()
  const { app, main } = await launchMain({ ...process.env, AI_TP_E2E: '1', AI_TP_AUDIT: '1' })
  try {
    await main.locator('aside button', { hasText: '錄音轉錄' }).first().click()
    await expect(main.locator('button', { hasText: '開始聆聽' })).toBeVisible({ timeout: 15_000 })

    // 清空 sessions,讓「存進來了」是可判定的結果
    await main.evaluate(async () => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise<IDBDatabase>((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').clear()
      await new Promise((res) => (tx.oncomplete = res))
    })

    // 掛鉤必須存在:它是 main 端退出流程唯一的入口。掛鉤不存在時這條測試
    // 應該明確失敗,而不是「隨便按一下,反正 sessions 數量本來就是 0」
    const hasHook = await main.evaluate(
      () => typeof (window as Window & { __aiTpFlushRecording?: unknown }).__aiTpFlushRecording === 'function'
    )
    expect(hasHook, '退出前存檔的掛鉤必須掛在 window 上(main 用 executeJavaScript 呼叫它)').toBe(true)

    // 沒在錄音時呼叫它:不得憑空產生一場會議
    const whileIdle = await main.evaluate(
      () => (window as Window & { __aiTpFlushRecording?: () => Promise<boolean> }).__aiTpFlushRecording!()
    )
    expect(whileIdle, '沒在錄音時不該寫入').toBe(false)
    expect(await countSessions(main), '沒在錄音時不該憑空多出一場會議').toBe(0)

    // 走真實錄音路徑。雲端 STT 指到 mock,假麥克風的白噪讓 VAD 切出一段。
    await main.evaluate((port) => {
      void window.api.setSettings({
        stt: { engine: 'cloud', cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', model: 'm' } }
      })
    }, stt.port)

    await main.locator('button', { hasText: '開始聆聽' }).click()
    await expect(main.locator('text=聆聽中').first()).toBeVisible({ timeout: 15_000 })
    // 白噪要讓 VAD 切出段落才會有東西可存。切不出來時這條測試應該明確說出
    // 「前提不成立」,而不是在下一個斷言以「寫入失敗」呈現 —— 那會讓人誤以為
    // 是存檔邏輯壞了。
    // 「等待說話…」這個空狀態提示在有段落之後會消失 —— 用它當「VAD 已經切出
    // 段落」的訊號,而不是為了測試往產品程式裡加一個掛鉤。
    //
    // 45 秒不是隨手寫的數字:這條依賴真的音訊擷取,切段時機本來就浮動
    // (實測 5–25 秒)。時間抓太緊的話,一條 blocking 測試會因為「今天機器慢
    // 一點」而擋住別人的 merge。
    await expect(main.locator('text=等待說話')).toBeHidden({ timeout: 45_000 })

    // 這就是 before-quit 會做的事。回 true 代表有寫進去。
    const saved = await main.evaluate(
      () => (window as Window & { __aiTpFlushRecording?: () => Promise<boolean> }).__aiTpFlushRecording!()
    )
    expect(saved, '退出前存檔必須真的寫入').toBe(true)
    expect(await countSessions(main), '退出前存檔後應該剛好有一場會議').toBe(1)

    // 「只寫一次」:退出路徑與 stop() 可能同時成立(使用者按停止的同時在關機)。
    // 寫兩次的後果是使用者看到「我明明只開了一次會,為什麼有兩筆」。
    await main.evaluate(
      () => (window as Window & { __aiTpFlushRecording?: () => Promise<boolean> }).__aiTpFlushRecording!()
    )
    expect(await countSessions(main), '同一場會議不得被寫入兩次').toBe(1)

    // 存進去的那一筆必須真的帶著逐字稿,不是空的幽靈紀錄
    const stored = await readSessions(main)
    expect(stored[0].segments.length, '存下來的逐字稿不能是空的').toBeGreaterThan(0)
    expect(stored[0].report, '會後報告要一起存').toBeTruthy()
  } finally {
    await app.close()
    await stt.close()
  }
})

async function countSessions(main: { evaluate: (fn: () => Promise<number>) => Promise<unknown> }): Promise<number> {
  return (await main.evaluate(async () => {
    const req = indexedDB.open('ai-teleprompter')
    const db = await new Promise<IDBDatabase>((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const tx = db.transaction('sessions', 'readonly')
    return new Promise<number>((res) => {
      const r = tx.objectStore('sessions').count()
      r.onsuccess = () => res(r.result)
      r.onerror = () => res(-1)
    })
  })) as number
}

async function readSessions(
  main: { evaluate: (fn: () => Promise<unknown[]>) => Promise<unknown> }
): Promise<Array<{ segments: unknown[]; report?: unknown }>> {
  return (await main.evaluate(async () => {
    const req = indexedDB.open('ai-teleprompter')
    const db = await new Promise<IDBDatabase>((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const tx = db.transaction('sessions', 'readonly')
    return new Promise<Array<{ segments: unknown[]; report?: unknown }>>((res) => {
      const r = tx.objectStore('sessions').getAll()
      r.onsuccess = () => res(r.result)
      r.onerror = () => res([])
    })
  })) as Array<{ segments: unknown[]; report?: unknown }>
}

/**
 * 這一條才是**整條鏈**的證明。
 *
 * 前一條只驗了 renderer 掛鉤「被叫到時會寫入」。但生產環境真正的鏈是:
 *
 *   renderer 上報「正在錄音」(setRecording IPC)
 *     → main 的 state.isRecording 變 true
 *       → 有人按退出 / OS 關機 / 自動更新
 *         → before-quit 觸發 quitGuard
 *           → executeJavaScript 叫 renderer 的掛鉤
 *             → 寫進 IndexedDB
 *
 * 中間任何一環沒接上,前面那條測試都還是綠的 —— 它繞過了整條鏈的前半段。
 * 所以這裡真的 `app.quit()`,**重開一個實例**再讀 IndexedDB:
 * 進程都死過一次了,資料還在,才是真的成立。
 *
 * 為什麼需要 AI_TP_E2E_USERDATA:e2e **預設每次啟動都用新的暫存 userData**
 * (見 src/main/index.ts),那正是它隔離測試資料的做法。所以第二個實例會看到
 * 一個全空的 IndexedDB,而測試會把它讀成「資料沒存到」——
 * **測試的前提錯了,不是產品壞了。** 這個環境變數只在 AI_TP_E2E=1 之下有意義,
 * 打包後的使用者永遠走不到那條程式碼。
 */
test('真的退出 App 再重開:逐字稿還在', async () => {
  test.setTimeout(180_000)
  const stt = await startSttMock()
  // 兩個實例必須共用同一個 userData,否則第二次讀到的是另一個資料庫
  const pinnedUserData = join(tmpdir(), `ai-tp-quit-flush-${Date.now()}`)
  const env = { ...process.env, AI_TP_E2E: '1', AI_TP_AUDIT: '1', AI_TP_E2E_USERDATA: pinnedUserData }
  const launched = await launchMain(env)
  try {
    await launched.main.locator('aside button', { hasText: '錄音轉錄' }).first().click()
    await expect(launched.main.locator('button', { hasText: '開始聆聽' })).toBeVisible({ timeout: 15_000 })

    await launched.main.evaluate(async (port) => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise<IDBDatabase>((res) => (req.onsuccess = () => res(req.result)))
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').clear()
      await new Promise((res) => (tx.oncomplete = res))
      void window.api.setSettings({
        stt: { engine: 'cloud', cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', model: 'm' } }
      })
    }, stt.port)

    await launched.main.locator('button', { hasText: '開始聆聽' }).click()
    await expect(launched.main.locator('text=聆聽中').first()).toBeVisible({ timeout: 15_000 })
    await expect(launched.main.locator('text=等待說話')).toBeHidden({ timeout: 45_000 })

    // 真的退出。quitGuard 應該在 before-quit 擋一次、存完再退。
    const closed = launched.app.waitForEvent('close').catch(() => undefined)
    await launched.app.evaluate(({ app }) => {
      app.quit()
    })
    await closed
    // 給 App 一點時間把最後一個 flush 收掉
    await launched.main.waitForTimeout(1_000).catch(() => undefined)
  } finally {
    await launched.app.close().catch(() => undefined)
    await stt.close()
  }

  // 重開:進程已經死過一次,資料還在才算數
  const second = await launchMain(env)
  try {
    const rows = await second.main.evaluate(async () => {
      const req = indexedDB.open('ai-teleprompter')
      const db = await new Promise<IDBDatabase>((res) => (req.onsuccess = () => res(req.result)))
      return new Promise<Array<{ segments: unknown[]; report?: { durationSec?: number } }>>((res) => {
        const r = db.transaction('sessions', 'readonly').objectStore('sessions').getAll()
        r.onsuccess = () => res(r.result)
        r.onerror = () => res([])
      })
    })
    expect(rows.length, '退出前存檔必須在 App 關閉後仍然留下紀錄').toBe(1)
    expect(rows[0].segments.length, '留下來的必須是真的逐字稿').toBeGreaterThan(0)
    expect(rows[0].report?.durationSec ?? 0, '報告的會議長度必須大於 0').toBeGreaterThan(0)
  } finally {
    await second.app.close()
    rmSync(pinnedUserData, { recursive: true, force: true })
  }
})
