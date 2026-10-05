import { describe, it, expect, vi } from 'vitest'
import { importJsonFile, DEFAULT_MAX_BACKUP_BYTES, type ImportJsonDeps } from '../importJsonFile'

/**
 * 這組測的是**呼叫順序**,不是回傳值。
 *
 * 為什麼只能這樣寫:缺陷的本質是「先讀進來才丟掉」,而它的外在表現(回傳
 * 「檔案太大」)在修復前後**完全一樣**。所以一個只斷言回傳值的測試會在修復前
 * 就通過 —— 等於沒有測到缺陷本身。因此每個案例都同時斷言 readFile **沒有被呼叫**。
 */
function deps(sizeBytes: number, text = '{"ok":true}') {
  const stat = vi.fn(async () => ({ size: sizeBytes }))
  const readFile = vi.fn(async () => text)
  const d: ImportJsonDeps = { stat, readFile }
  return { d, stat, readFile }
}

describe('importJsonFile:大小上限必須在讀內容之前生效', () => {
  it('超標時回人話錯誤,而且一個 byte 都沒讀', async () => {
    const { d, readFile } = deps(200 * 1024 * 1024)
    const result = await importJsonFile('C:/backup.json', undefined, d)

    expect(result.ok).toBe(false)
    // 這一條才是重點:舊的實作在這裡會是 true(整份 200MB 已經進了記憶體)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('超標訊息帶 MB 數字,不是位元組', async () => {
    const { d } = deps(200 * 1024 * 1024)
    const result = await importJsonFile('C:/backup.json', undefined, d)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/200MB/)
    if (!result.ok) expect(result.error).not.toMatch(/\d{9}/) // 不是位元組數
  })

  it('剛好等於上限:放行(邊界要含,否則使用者會遇到「差一點點」的莫名拒絕)', async () => {
    const max = 1024
    const { d, readFile } = deps(max, '{"format":"x"}')
    const result = await importJsonFile('C:/backup.json', max, d)
    expect(result.ok).toBe(true)
    expect(readFile).toHaveBeenCalledOnce()
  })

  it('超過上限一個 byte:擋', async () => {
    const max = 1024
    const { d, readFile } = deps(max + 1)
    const result = await importJsonFile('C:/backup.json', max, d)
    expect(result.ok).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('在上限內:正常讀回內容並帶上路徑', async () => {
    const { d, readFile } = deps(500 * 1024, '{"format":"ai-teleprompter-backup"}')
    const result = await importJsonFile('C:/backup.json', undefined, d)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.filePath).toBe('C:/backup.json')
      expect(result.text).toBe('{"format":"ai-teleprompter-backup"}')
    }
    expect(readFile).toHaveBeenCalledWith('C:/backup.json', 'utf-8')
  })

  it('預設上限就是 64MB', () => {
    expect(DEFAULT_MAX_BACKUP_BYTES).toBe(64 * 1024 * 1024)
  })

  /**
   * stat 失敗與 readFile 失敗的處理**刻意不同**:
   *   - stat 失敗 = 我們連大小都不知道 → 必須 throw(不能猜著放行)
   *   - 讀取失敗 = 已通過大小檢查,是實際的 I/O 問題 → 也 throw,附上原始訊息
   * 兩者都要保留原始錯誤內容,否則使用者只會看到「讀取備份檔失敗()」。
   */
  it('stat 失敗時往外擲,並保留原始訊息(不能猜著放行)', async () => {
    const stat = vi.fn(async () => {
      throw new Error('ENOENT: no such file')
    })
    const readFile = vi.fn(async () => 'x')
    const d: ImportJsonDeps = { stat, readFile }

    await expect(importJsonFile('C:/gone.json', undefined, d)).rejects.toThrow(/ENOENT/)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('通過大小檢查後讀取失敗:往外擲並保留原始訊息', async () => {
    const stat = vi.fn(async () => ({ size: 10 }))
    const readFile = vi.fn(async () => {
      throw new Error('EACCES: permission denied')
    })
    const d: ImportJsonDeps = { stat, readFile }

    await expect(importJsonFile('C:/locked.json', undefined, d)).rejects.toThrow(/EACCES/)
  })

  /**
   * 截斷是明確拒絕的選項:被截斷的 JSON 解析失敗,使用者看到的是一個
   * 「JSON 格式錯誤」而不是「檔案太大」—— 後者才是真的原因。
   */
  it('不做截斷:超標時回的是明確錯誤,不是被截斷的內容', async () => {
    const { d } = deps(200 * 1024 * 1024, '{"partial":')
    const result = await importJsonFile('C:/backup.json', undefined, d)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/太大/)
    if (!result.ok) expect(result.error).not.toMatch(/partial/)
  })
})
