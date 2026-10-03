/**
 * e2e — 資料備份的完整往返
 *
 * 為什麼這條不能只在單元測試裡:
 *   單元測試驗的是「三個 store 能不能往返」。這條驗的是**使用者實際會走的那條路**:
 *   備份內容真的被產出來 → 真的寫到磁碟 → 從磁碟讀回來 → 真的取代掉現有資料。
 *   「寫進一個 JS 物件、從同一個 JS 物件讀出來」測不到任何序列化層的問題,
 *   而備份的全部風險都在那裡。
 *
 * 兩件這條**沒有**測、而由別處覆蓋的事(寫在這裡是為了不要誤以為它漏了):
 *   - 原生的存檔/開檔對話框:headless 點不到。取代方式是用測試自己的路徑寫檔,
 *     寫入的**內容**仍然來自 renderer 的真實序列化結果。
 *   - 設定頁那兩顆鈕與確認對話框:由本檔第三條測試用 DOM 斷言。
 *
 * 資料層是 renderer 直接讀寫的 IndexedDB(Dexie),沒有 IPC,所以測試用原生
 * indexedDB 播種與讀取 —— 與 scripts/audit-states.mjs 用的是同一套做法。
 * 刻意**不**用動態 import 去拿打包後的模組路徑:那些路徑在 production build
 * 裡不存在,而這種寫法在 dev 下會通過、發佈後才爆。
 *
 * 執行需先 `npm run build`。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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

const navTo = async (main: Page, label: string): Promise<void> => {
  await main.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('aside button')).find((b) => b.textContent?.includes(l)) as HTMLElement | undefined
    btn?.click()
  }, label)
  await main.waitForTimeout(500)
}

/** 用原生 indexedDB 播種 / 讀取。schema 必須與 lib/db.ts 的 version(1) 一致。 */
const withDb = <T>(main: Page, fn: string): Promise<T> =>
  main.evaluate(
    // eslint-disable-next-line no-new-func
    new Function(
      'return (async () => { const open = () => new Promise((res, rej) => { const r = indexedDB.open("ai-teleprompter"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const db = await open(); try { return await (' +
        fn +
        ')(db) } finally { db.close() } })()'
    ) as () => Promise<T>
  )

const seedScripts = (main: Page, titles: string[]): Promise<number> =>
  withDb<number>(
    main,
    `(db) => new Promise((res, rej) => { const tx = db.transaction('scripts', 'readwrite'); const os = tx.objectStore('scripts'); const now = Date.now(); for (const t of ${JSON.stringify(titles)}) os.put({ title: t, content: '內容:' + t, createdAt: now, updatedAt: now }); tx.oncomplete = () => res(${titles.length}); tx.onerror = () => rej(tx.error) })`
  )

const clearScripts = (main: Page): Promise<void> =>
  withDb<void>(main, `(db) => new Promise((res, rej) => { const tx = db.transaction('scripts', 'readwrite'); tx.objectStore('scripts').clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error) })`)

const listScriptTitles = (main: Page): Promise<string[]> =>
  withDb<string[]>(
    main,
    `(db) => new Promise((res, rej) => { const tx = db.transaction('scripts', 'readonly'); const r = tx.objectStore('scripts').getAll(); r.onsuccess = () => res(r.result.map(s => s.title)); r.onerror = () => rej(r.error) })`
  )

/** 產生備份內容。走真實的 renderer 序列化路徑(BackupSection 用的是同一組函式)。 */
const buildBackupText = (main: Page, poisonKey: boolean): Promise<{ text: string; name: string; counts: any }> =>
  main.evaluate(
    async (poison) => {
      const r = (window as any).__auditForce?.('backup.probe', poison)
      if (!r) return { text: '', name: '', counts: null, error: 'audit bridge missing' }
      return (await r).result ?? { error: 'no result' }
    },
    poisonKey
  )

test.describe('資料備份', () => {
  const workDir = join(tmpdir(), `ai-tp-backup-e2e-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  test.afterAll(() => rmSync(workDir, { recursive: true, force: true }))

  test('備份真的寫到磁碟、格式完整、而且不含 API Key', async () => {
    const { app, main } = await launch()
    try {
      await navTo(main, '設定')
      await seedScripts(main, ['備份測試講稿 A', '備份測試講稿 B', '備份測試講稿 C'])

      const { text, name, counts, error } = (await buildBackupText(main, true)) as any
      expect(error ?? null, `備份探針應該可用: ${String(error)}`).toBeNull()
      expect(counts.scripts).toBe(3)
      expect(name).toMatch(/^ai-teleprompter-backup-\d{8}-\d{4}\.json$/)

      const outPath = join(workDir, name)
      writeFileSync(outPath, text, 'utf-8')
      expect(existsSync(outPath), '備份檔必須真的落在磁碟上').toBe(true)

      // 從磁碟讀回來再驗 —— 序列化層的問題只有在這裡才現形
      const disk = readFileSync(outPath, 'utf-8')
      expect(disk, 'API Key 不得出現在備份檔裡').not.toContain('sk-e2e-secret-value')
      const parsed = JSON.parse(disk)
      expect(parsed.format).toBe('ai-teleprompter-backup')
      expect(parsed.version).toBe(1)
      expect(typeof parsed.appVersion).toBe('string')
      expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(parsed.counts).toEqual({ scripts: 3, sessions: 0, practiceRuns: 0 })
      expect(parsed.data.scripts).toHaveLength(3)
      expect(parsed.data.scripts.map((s: { title: string }) => s.title).sort()).toEqual([
        '備份測試講稿 A',
        '備份測試講稿 B',
        '備份測試講稿 C'
      ])
      // 逐字稿與練習的欄位也要在(即使這次是空的),否則還原端會缺形狀
      expect(Array.isArray(parsed.data.sessions)).toBe(true)
      expect(Array.isArray(parsed.data.practiceRuns)).toBe(true)
      expect(parsed.settings).toBeTruthy()
    } finally {
      await app.close()
    }
  })

  test('從磁碟還原:真的取代,而且帶回來的內容一字不差', async () => {
    const { app, main } = await launch()
    try {
      await navTo(main, '設定')
      await seedScripts(main, ['原本的講稿 1', '原本的講稿 2'])
      const { text } = (await buildBackupText(main, false)) as any
      const outPath = join(workDir, 'roundtrip.json')
      writeFileSync(outPath, text, 'utf-8')

      // 破壞現況:清空後放一份「不在備份裡」的講稿
      await clearScripts(main)
      await seedScripts(main, ['還原之後不該留下來的'])
      expect(await listScriptTitles(main)).toEqual(['還原之後不該留下來的'])

      // 走 main 的讀檔 IPC 的下半段:原生開檔對話框無法自動操作,
      // 所以直接把磁碟上的字串交給 renderer。真正的風險點是
      // 「從磁碟來的字串能不能變回資料」,那一步仍然是完整的。
      const restored = (await main.evaluate(async (t) => {
        const r = (window as any).__auditForce?.('backup.restore', t)
        if (!r) return { error: 'audit bridge missing' }
        return await r
      }, readFileSync(outPath, 'utf-8'))) as any
      expect(restored.error ?? null).toBeNull()
      expect(restored.ok).toBe(true)
      expect(restored.result.counts.scripts).toBe(2)

      const titles = await listScriptTitles(main)
      expect(titles.sort(), '不在備份裡的資料必須真的消失(取代不是合併)').toEqual(['原本的講稿 1', '原本的講稿 2'])
      expect(titles.some((t) => t.includes('還原之後不該留下來的'))).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('備份檔損毀時:還原按鈕要說人話,而且資料不動', async () => {
    const { app, main } = await launch()
    try {
      await navTo(main, '設定')
      await seedScripts(main, ['不能被壞掉的備份吃掉'])
      const before = await listScriptTitles(main)

      const out = (await main.evaluate(async () => {
        const r = (window as any).__auditForce?.('backup.restore', '{"hello":"world"}')
        return r ? await r : { error: 'audit bridge missing' }
      })) as any
      expect(out.ok, '格式不符必須回報失敗,不能假裝成功').toBe(false)
      expect(out.error).toContain('AI 提詞機')

      // 最重要的一句:失敗之後資料一筆都不能少
      expect((await listScriptTitles(main)).sort()).toEqual(before.sort())
    } finally {
      await app.close()
    }
  })

  test('設定頁有備份區塊,並講清楚金鑰不進備份與取代語意', async () => {
    const { app, main } = await launch()
    try {
      await navTo(main, '設定')
      const body = main.locator('body')
      await expect(body).toContainText('資料備份')
      await expect(body.getByRole('button', { name: /匯出備份/ })).toBeVisible()
      await expect(body.getByRole('button', { name: /還原備份/ })).toBeVisible()
      // 這兩句是使用者做決定所必需的,不是裝飾
      await expect(body).toContainText('API Key 不會寫進備份')
      await expect(body).toContainText('取代')
    } finally {
      await app.close()
    }
  })
})
