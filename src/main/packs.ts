/**
 * packs.ts — 場景包載入器(對應 v3 plugin-system 的最小可行子集)
 *
 * 只做「發現 + 驗證 + 展開為場景」:bundled assets/packs + userData/packs。
 * 不做 prompt/template/style 類型與安裝 UI(有需要再擴充)。
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { ScenePreset } from './context-engine/scenes'
import { SCENE_PRESETS } from './context-engine/scenes'

interface PackScene {
  key: string
  label: string
  tone?: string
  tempo?: string
  lengthBudget?: number
  riskLevel?: string
  turns?: number
  templates?: string[]
}

interface PackFile {
  id: string
  name: string
  version: string
  type?: string
  scenes?: PackScene[]
}

const VALID_TONES = new Set(['calm', 'professional', 'empathic', 'energetic', 'defensive'])
const VALID_TEMPOS = new Set(['slow', 'medium', 'fast'])
const VALID_RISKS = new Set(['low', 'medium', 'high'])

export function validatePack(pack: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const p = pack as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return { ok: false, errors: ['not an object'] }
  if (typeof p['id'] !== 'string' || !p['id']) errors.push('id required')
  if (typeof p['name'] !== 'string' || !p['name']) errors.push('name required')
  if (typeof p['version'] !== 'string' || !p['version']) errors.push('version required')
  const type = p['type']
  if (type !== undefined && type !== 'scene') errors.push(`unsupported pack type: ${String(type)}`)
  if (p['scenes'] !== undefined && !Array.isArray(p['scenes'])) errors.push('scenes must be array')
  return { ok: errors.length === 0, errors }
}

/** bundled 候補路徑:開發用專案根;打包用 resources/packs(electron-builder extraResources) */
export function packRoots(): string[] {
  const roots: string[] = []
  try {
    roots.push(join(app.getAppPath(), 'assets', 'packs'))
    if (process.resourcesPath) roots.push(join(process.resourcesPath, 'packs'))
    roots.push(join(app.getPath('userData'), 'packs'))
  } catch {
    // app 未 ready 時(測試)忽略
  }
  return roots
}

/** 由目錄清單掃描 *.json 場景包;後掃描的覆蓋同 id 的前面(與 v3 一致:user > bundled) */
export function discoverPacks(dirs: string[]): PackFile[] {
  const byId = new Map<string, PackFile>()
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as unknown
        const check = validatePack(parsed)
        if (!check.ok) continue
        const pack = parsed as PackFile
        if (pack.type && pack.type !== 'scene') continue
        byId.set(pack.id, pack)
      } catch {
        // 壞檔跳過
      }
    }
  }
  return Array.from(byId.values())
}

/** 把 pack 的 scenes 展開為 ScenePreset(key = pack:<packId>:<sceneKey>) */
export function expandPackScenes(pack: PackFile): ScenePreset[] {
  return (pack.scenes ?? []).map((s) => ({
    key: `pack:${pack.id}:${s.key}`,
    label: s.label || s.key,
    tone: (VALID_TONES.has(s.tone ?? '') ? s.tone : 'calm') as ScenePreset['tone'],
    tempo: (VALID_TEMPOS.has(s.tempo ?? '') ? s.tempo : 'medium') as ScenePreset['tempo'],
    lengthBudget: typeof s.lengthBudget === 'number' ? s.lengthBudget : 80,
    riskLevel: (VALID_RISKS.has(s.riskLevel ?? '') ? s.riskLevel : 'medium') as ScenePreset['riskLevel'],
    turns: typeof s.turns === 'number' ? s.turns : 3,
    templates: Array.isArray(s.templates) ? s.templates.filter((t) => typeof t === 'string') : [],
    source: `pack:${pack.id}`
  }))
}

/** 內建 8 場景 + 所有 pack 場景的合併清單 */
export function listAllScenes(): ScenePreset[] {
  const packs = discoverPacks(packRoots())
  const fromPacks = packs.flatMap(expandPackScenes)
  return [...SCENE_PRESETS, ...fromPacks]
}
