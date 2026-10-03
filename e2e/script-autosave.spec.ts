/**
 * script-autosave.spec.ts — 講稿不能因為使用者忘了按「儲存」而消失。
 *
 * ## 這兩條在守什麼
 *
 * 原本講稿只有一條出路:按那顆「儲存」按鈕。而它跟所有會丟資料的設計一樣,
 * **看起來沒事** —— 使用者打完稿、離開、隔天回來,稿子還在記憶體裡(切頁沒事,
 * 關視窗有防呆攔截),直到某個瞬間整份消失。
 *
 * 真正會咬人的情境不是「他忘了按」,是「他以為自己按了」:
 *   - 他按了 Ctrl+S(所有編輯器的肌肉記憶),這個 App 沒有接 → 什麼事都沒發生,
 *     他以為存了。**這是最常見的一種,因為他沒有犯錯。**
 *   - 他打完一段就去講了,中間隔了幾分鐘,回來直接關 App。
 *
 * 補上「停手 1.5 秒自動存檔」與 Ctrl+S 之後,這兩條測的就是那兩個情境。
 *
 * ## 為什麼要真的關掉 App 再重開
 *
 * 斷言「textarea 的值還在」是不成立的:React state 就是它自己,換個方式讀都會
 * 綠。真正要證明的是**位元組落到了 IndexedDB**。
 *
 * 所以這裡讀 IndexedDB —— 而且第一條還會真的 `app.quit()` 再開一個實例。
 * 進程都死過一次了資料還在,那才是「存檔」。這也是為什麼需要
 * `AI_TP_E2E_USERDATA`:e2e 預設每次啟動都用新的暫存 userData(隔離測試資料),
 * 第二個實例否則會讀到一個全空的資料庫 —— **測試的前提錯了,不是產品壞了。**
 *
 * ## 第二條怎麼分辨「Ctrl+S 真的寫了」與「debounce 剛好也觸發了」
 *
 * 這是這條 spec 最容易寫得沒有意義的地方。debounce 是 1500ms,如果只用
 * 「最後內容有沒有進資料庫」當斷言,那麼**只接 autosave、Ctrl+S 壞掉**的情況
 * 完全會綠 —— 等 1.5 秒就寫進去了,斷言成立,而 Ctrl+S 其實根本沒接。
 *
 * 所以這條用一個**自動存檔永遠做不出來的狀態差異**:
 * `persistQuietly` 刻意不把正規化的標題寫回輸入框(寫回受控欄位會截斷
 * Ctrl+Z 堆疊),而 `save()` 會。把標題清空、按 Ctrl+S,輸入框必須變回
 * 「未命名講稿」。自動存檔就算在旁邊跑完了也不會有這個現象。
 *
 * 執行需先 `npm run build`。
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { launchApp } from './helpers/launch'

const AUTOSAVED = '開場白\n\n各位好,今天我要分享三個重點,第一是進度,第二是挑戰,第三是下一步。'
const CTRL_S = 'Ctrl+S 立刻存下來的內容:這一版還沒到 debounce 的時間。'

interface StoredScript {
  title: string
  content: string
}

/**
 * 進到提詞講稿頁,並確保有一份**正在編輯**的講稿。
 *
 * 為什麼要順手按「建立第一份講稿」:編輯器只在有選取時才渲染,全新的 userData
 * 進來是空狀態,連 textarea 都不存在。所以這裡必須自己走完「零講稿 → 有編輯
 * 目標」這一步,否則後面每一個斷言都會是「元素不存在」而不是「寫入失敗」。
 */
async function openEditor(main: Page): Promise<void> {
  await main.locator('aside button', { hasText: '提詞講稿' }).first().click()
  // 「新講稿」是這一頁唯一的按鈕標誌,用它當「頁面真的換過來了」的訊號。
  // 不要用 /建立第一份講稿|新講稿/ 那種合併比對 —— 兩顆都存在時會 strict mode
  // violation,而那種失敗訊息完全不會提到真正的問題(空狀態)。
  await expect(main.getByRole('button', { name: '新講稿', exact: true })).toBeVisible({
    timeout: 15_000
  })
  const empty = main.getByRole('button', { name: '建立第一份講稿', exact: true })
  if (await empty.isVisible().catch(() => false)) await empty.click()
  await expect(main.locator('input[placeholder="講稿標題"]')).toBeVisible({ timeout: 10_000 })
}

/** 直接讀 IndexedDB —— 這是「有沒有真的寫進去」的唯一可信來源。 */
async function readScripts(main: Page): Promise<StoredScript[]> {
  return (await main.evaluate(async () => {
    const req = indexedDB.open('ai-teleprompter')
    const db = await new Promise<IDBDatabase>((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    return new Promise<StoredScript[]>((res) => {
      const r = db.transaction('scripts', 'readonly').objectStore('scripts').getAll()
      r.onsuccess = () => res(r.result as StoredScript[])
      r.onerror = () => res([])
    })
  })) as StoredScript[]
}

test('講稿停手後自動存檔:沒按儲存,關掉 App 重開內容還在', async () => {
  test.setTimeout(180_000)
  const pinnedUserData = join(tmpdir(), `ai-tp-autosave-${Date.now()}`)
  const env = { ...process.env, AI_TP_E2E: '1', AI_TP_AUDIT: '1', AI_TP_E2E_USERDATA: pinnedUserData }

  const launched = await launchApp(env)
  try {
    await openEditor(launched.main)
    await expect(launched.main.locator('textarea')).toBeVisible({ timeout: 10_000 })

    // 標題也要自動存 —— 只改標題的使用者(匯入後改個名字就走)不能因此失去保護
    await launched.main.locator('input[placeholder="講稿標題"]').fill('季度簡報')
    await launched.main.locator('textarea').fill(AUTOSAVED)

    // 這顆按鈕是「有未儲存修改」的指標,旁邊那行「已寫入 HH:MM」是「剛剛真的
    // 落盤了」的證據。兩個都要看:只看按鈕的話,一個「有寫入但按鈕一直亮著」
    // 的半吊子實作也會綠。
    //
    // 用可存取名稱而不是 hasText:「已儲存」本身包含「儲存」,用 hasText: '儲存'
    // 會在兩個狀態都匹配。
    const saveBtn = launched.main.getByRole('button', { name: /^(儲存|已儲存)$/ })
    await expect(saveBtn).toHaveAccessibleName('儲存')
    await expect(saveBtn).toHaveAccessibleName('已儲存', { timeout: 10_000 })
    // 時間戳是「自動存檔真的發生並回報了時間」的可見證據
    await expect(launched.main.locator('text=/已寫入 \\d{2}:\\d{2}/')).toBeVisible({
      timeout: 10_000
    })

    // 位元組真的在資料庫裡,標題也一樣(這兩個是分開的輸入框,分開斷言)
    const stored = await readScripts(launched.main)
    expect(stored.length, '應該只有剛建立的那一份講稿').toBe(1)
    expect(stored[0].content, '內容必須真的落盤').toBe(AUTOSAVED)
    expect(stored[0].title, '標題也要落盤').toBe('季度簡報')

    // 重複寫入是最容易在 debounce 上踩到的 bug(打字快時每一下都排一個 timer)。
    // 自動存檔要嘛不寫,要嘛覆蓋同一筆 —— 絕不能凭空多出幾份一樣的稿子。
    expect((await readScripts(launched.main)).length, '自動存檔不得複製出第二份講稿').toBe(1)

    const closed = launched.app.waitForEvent('close').catch(() => undefined)
    await launched.app.evaluate(({ app }) => {
      app.quit()
    })
    await closed
  } finally {
    await launched.app.close().catch(() => undefined)
  }

  // 重開:進程死過一次,資料還在才算數
  const second = await launchApp(env)
  try {
    await openEditor(second.main)
    const rows = await readScripts(second.main)
    expect(rows.length, '重開後必須還是同一份講稿').toBe(1)
    expect(rows[0].content, '重開後內容必須還在(這才是「存檔」的定義)').toBe(AUTOSAVED)
    expect(rows[0].title).toBe('季度簡報')
  } finally {
    await second.app.close()
    rmSync(pinnedUserData, { recursive: true, force: true })
  }
})

test('Ctrl+S 立刻走完整儲存那一條路(不是安靜寫入)', async () => {
  test.setTimeout(120_000)
  const pinnedUserData = join(tmpdir(), `ai-tp-ctrls-${Date.now()}`)
  const env = { ...process.env, AI_TP_E2E: '1', AI_TP_AUDIT: '1', AI_TP_E2E_USERDATA: pinnedUserData }

  const launched = await launchApp(env)
  try {
    await openEditor(launched.main)
    await expect(launched.main.locator('textarea')).toBeVisible({ timeout: 10_000 })

    // 清空標題。save() 會把「空 → 未命名講稿」正規化後**寫回輸入框**;
    // persistQuietly(自動存檔)刻意不寫回去。這就是兩條路可分辨的地方。
    await launched.main.locator('input[placeholder="講稿標題"]').fill('')
    await launched.main.locator('textarea').fill(CTRL_S)

    // 真實鍵盤事件。走 locator.press('Control+s') 也行,但在 Electron 裡
    // 我們自己掛的是 window 的 keydown,聚焦狀態才不會影響它該不該觸發。
    const pressedAt = Date.now()
    await launched.main.locator('textarea').press('Control+s')

    // 1) 位元組確實在資料庫裡,而且內容正確。
    //
    //    這一條**不**負責證明「立刻」。誠實地說:它證明不了。上面 fill() 已經
    //    排了一顆 1500ms 的 autosave,而這裡的輪詢窗口離 fill 已過幾百毫秒,
    //    只接 autosave、Ctrl+S 壞掉的實作在這個窗口裡一樣會綠(實測確實如此)。
    //    負向驗證時親眼看到的就是這件事 —— 所以證明責任交給下面兩條。
    await expect
      .poll(async () => (await readScripts(launched.main))[0]?.content ?? '', {
        timeout: 2_000,
        intervals: [50, 100, 150]
      })
      .toBe(CTRL_S)

    // 2) **這才是「Ctrl+S 有接」的那條證據。**
    //    persistQuietly 與 save 寫進資料庫的位元組完全相同 —— 兩者都做
    //    normalizeScriptTitle,都寫 content。唯一能分辨它們的差別是
    //    save() 會把正規化後的標題**寫回輸入框**,而 persistQuietly 刻意不寫
    //    (寫回受控欄位會截斷原生 Ctrl+Z 的堆疊)。
    //    所以標題從「空」變成「未命名講稿」只有 save() 造成 —— autosave 就算
    //    在旁邊跑完了也不會有這個現象。這條在 Ctrl+S 停用時會紅(已驗證)。
    await expect(launched.main.locator('input[placeholder="講稿標題"]')).toHaveValue('未命名講稿', {
      timeout: 3_000
    })

    // 3) Ctrl+S 的既定語意是「存好了」,所以畫面不能還停在未儲存狀態。
    //    沒有這一條的話,一個「有寫入但按鈕一直亮著」的半吊子實作也會全綠。
    await expect(launched.main.getByRole('button', { name: '已儲存', exact: true })).toBeVisible({
      timeout: 3_000
    })
    await expect(launched.main.locator('text=/已寫入 \\d{2}:\\d{2}/')).toBeVisible({ timeout: 3_000 })

    // 整段鍵到「畫面說已儲存」不得慢到使用者覺得按了沒反應。db.scripts.update
    // 是本機 IndexedDB 寫入,實測在 10ms 內;給 1000ms 是為了容忍 CI runner 慢,
    // 而它仍遠小於 1500ms 的 debounce —— 所以「其實是 autosave 補上的」在這裡
    // 不成立,這才是「立刻」真正被量到的地方。
    expect(Date.now() - pressedAt, 'Ctrl+S 必須立刻回應').toBeLessThan(1_000)
  } finally {
    await launched.app.close().catch(() => undefined)
    rmSync(pinnedUserData, { recursive: true, force: true })
  }
})