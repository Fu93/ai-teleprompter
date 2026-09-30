import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { deepMerge, mergeLoadedSettings } from '../settings'

/**
 * 這一組測試的存在理由:載入設定時曾經有一個 stripVolatileOverlay(),
 * 會把 `compact` / `lensMode` 從落盤內容裡刪掉(理由是「那只是上次關閉前的
 * 暫態 UI 狀態」)。實際後果是使用者每天都要重按一次「收合成藥丸」。
 *
 * 形態是使用者刻意選的顯示方式。測試在這裡把「它必須存活」變成契約,
 * 避免下一個人又覺得那兩個旗標「髒髒的」而「清理」掉。
 */
describe('mergeLoadedSettings', () => {
  it('compact / lensMode 必須跨啟動保留', () => {
    const saved = JSON.stringify({ overlay: { compact: true, lensMode: false } })
    const loaded = mergeLoadedSettings(saved)
    expect(loaded.overlay.compact).toBe(true)
    expect(loaded.overlay.lensMode).toBe(false)
  })

  it('貼鏡模式同樣保留(它不是「先還原成展開」再進去的過渡狀態)', () => {
    const loaded = mergeLoadedSettings(JSON.stringify({ overlay: { lensMode: true } }))
    expect(loaded.overlay.lensMode).toBe(true)
  })

  it('展開尺寸仍隨設定落盤 —— 藥丸不會把它覆蓋掉', () => {
    // 藥丸的視窗尺寸 (460x56) 不寫回 width/height:
    // 那兩個值代表「退出藥丸時要還原到多大」,被覆蓋就會展開成一顆藥丸。
    const loaded = mergeLoadedSettings(JSON.stringify({ overlay: { compact: true, width: 720, height: 260 } }))
    expect(loaded.overlay.width).toBe(720)
    expect(loaded.overlay.height).toBe(260)
  })

  it('缺少的欄位回退到預設值(舊版 settings.json 不會讓新欄位變 undefined)', () => {
    const loaded = mergeLoadedSettings('{}')
    expect(loaded.overlay.width).toBe(DEFAULT_SETTINGS.overlay.width)
    expect(loaded.overlay.compact).toBe(DEFAULT_SETTINGS.overlay.compact)
  })

  it('壞掉的 JSON 由呼叫端處理(mergeLoadedSettings 本身拋錯,loadSettings 會 catch)', () => {
    expect(() => mergeLoadedSettings('{ not json')).toThrow()
  })

  it('深層欄位(main 用 deepMerge)不會整顆被覆蓋', () => {
    const loaded = mergeLoadedSettings(JSON.stringify({ hotkeys: { panicRescue: 'F9' } }))
    expect(loaded.hotkeys.panicRescue).toBe('F9')
    // 同一層的其他熱鍵要保留預設值,不能因為 patch 只帶一個欄位就整層換掉
    expect(loaded.hotkeys.toggleOverlay).toBe(DEFAULT_SETTINGS.hotkeys.toggleOverlay)
  })
})

describe('deepMerge', () => {
  it('undefined 不覆蓋既有值(IPC patch 只帶部分欄位時的行為)', () => {
    const merged = deepMerge({ a: 1, b: 2 }, { a: undefined })
    expect(merged).toEqual({ a: 1, b: 2 })
  })

  it('非物件值直接取代', () => {
    expect(deepMerge({ a: 1 }, { a: 5 })).toEqual({ a: 5 })
  })
})
