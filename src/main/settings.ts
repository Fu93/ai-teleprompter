import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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
  return deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw))
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
