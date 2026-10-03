import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { AppSettings, DEFAULT_SETTINGS } from '@shared/types'

type Plain = Record<string, unknown>

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) {
    return (patch === undefined ? base : (patch as T))
  }
  const out: Plain = { ...(base as Plain) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v
  }
  return out as T
}

const settingsFile = () => join(app.getPath('userData'), 'settings.json')

/**
 * 把落盤的 JSON 疊到預設值上。
 *
 * 抽成純函式是為了可以在 node 環境單元測試「哪些欄位必須存活」:
 * 原本這裡有一個 stripVolatileOverlay(),會把 `compact` / `lensMode` 刪掉
 * (理由是「那只是上次關閉前的暫態 UI 狀態」),結果是使用者每天都要重按一次
 * 「收合成藥丸」。形態是使用者刻意選的顯示方式,不是暫態 —— 現在會跨啟動保留,
 * 測試(settings.test.ts)就是防止它被「清理」回來。
 *
 * 連動:形態決定浮層視窗尺寸。視窗在 renderer 掛載前就建好了(用 width/height,
 * 那存的是展開尺寸),所以浮層啟動時會自己把視窗對齊還原的形態
 * (見 overlay/OverlayApp.tsx 的 restoredShapeRef),否則會出現「藥丸的內容、
 * 展開的視窗」。
 */
export function mergeLoadedSettings(raw: string): AppSettings {
  const parsed: unknown = JSON.parse(raw)
  // settings.json 的內容不是 JSON 物件(例如曾被寫進 'null')時丟錯,讓
  // loadSettings 走預設值:deepMerge 對非物件的 patch 是原樣回傳,若把 null
  // 帶進去,啟動載入經同一條 deepMerge 又是 null —— 每一次啟動都是 null,
  // 使用者只能手動刪檔救援。容錯之後,最壞情況是「設定回到預設」,不是「全 app 壞掉」。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('settings.json 的內容不是 JSON 物件')
  }
  return deepMerge(structuredClone(DEFAULT_SETTINGS), parsed)
}

export function loadSettings(): AppSettings {
  try {
    return mergeLoadedSettings(readFileSync(settingsFile(), 'utf-8'))
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export function saveSettings(settings: AppSettings): void {
  const p = settingsFile()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8')
}

/**
 * 節流落盤:合併連續的設定寫入。
 *
 * 為什麼需要:設定頁的字體/速度滑桿拖一格就是一次 SettingsSet,每格都
 * writeFileSync 的話,一次拖動就是幾十次磁碟寫入(與同頁 API Key 輸入享受的
 * debounce 待遇不一致)。廣播與視窗套用仍由呼叫端即時做 —— 那是拖動的回饋,
 * 被合併的只有磁碟寫入;trailing 保證最後一格一定會落盤。
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null
export function saveSettingsThrottled(settings: AppSettings): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      saveSettings(settings)
    } catch (err) {
      // 落盤失敗(磁碟滿等)不該炸掉 main:設定還在記憶體裡,下次變更會再試
      console.error('[settings] 節流落盤失敗:', err instanceof Error ? err.message : String(err))
    }
  }, 500)
}
