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

/** 這些旗標描述「上一次關閉前的暫態 UI 狀態」,不應跨啟動還原 */
const VOLATILE_OVERLAY_KEYS = ['compact', 'lensMode'] as const

function stripVolatileOverlay(s: AppSettings): AppSettings {
  const overlay = { ...s.overlay } as unknown as Record<string, unknown>
  for (const k of VOLATILE_OVERLAY_KEYS) delete overlay[k]
  return { ...s, overlay: overlay as unknown as AppSettings['overlay'] }
}

export function loadSettings(): AppSettings {
  try {
    const raw = readFileSync(settingsFile(), 'utf-8')
    return stripVolatileOverlay(deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw)))
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export function saveSettings(settings: AppSettings): void {
  const p = settingsFile()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8')
}
