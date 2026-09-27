/**
 * orchestrator.ts — Panic 狀態機(自 flowprompt-v3 panicOrchestrator 移植,純函數)
 *
 * - 1.5s cooldown 防連按
 * - AI 失敗後 3s 內直接走場景模板(退避)
 * - 記錄 AI vs template 比率供會後統計
 */

import type { ScenePreset, ConversationTracker } from './scenes'
import { buildPanicSystemPrompt, pickFallbackTemplate } from './scenes'

export const PANIC_COOLDOWN_MS = 1500
export const PANIC_FAILURE_BACKOFF_MS = 3000

export interface PanicTriggerResult {
  ok: boolean
  text: string
  source: 'ai' | 'template' | 'cooldown'
  meta?: {
    scene: string
    followUpType: string
    tokens: number
    aiError?: string
    confidence?: number
  }
}

export interface PanicHistoryEntry {
  scene: string
  followUpType: string
  usedTemplate: boolean
  t: number
}

export interface PanicDeps {
  scene: ScenePreset
  tracker: ConversationTracker
  /** 由呼叫端注入的 AI 呼叫;回傳空字串或丟錯視為失敗 */
  aiCall: (systemPrompt: string, userText: string) => Promise<string>
}

export class PanicOrchestrator {
  private deps: PanicDeps
  private lastPanicAt = 0
  private lastFailureAt = 0
  private history: PanicHistoryEntry[] = []

  constructor(deps: PanicDeps) {
    this.deps = deps
  }

  setDeps(deps: PanicDeps): void {
    this.deps = deps
  }

  reset(): void {
    this.lastPanicAt = 0
    this.lastFailureAt = 0
    this.history = []
    this.deps.tracker.reset()
  }

  async trigger(now = Date.now()): Promise<PanicTriggerResult> {
    const { scene, tracker, aiCall } = this.deps

    // (a) cooldown
    if (now - this.lastPanicAt < PANIC_COOLDOWN_MS) {
      return { ok: false, text: '', source: 'cooldown' }
    }

    const lastQ = tracker.lastQuestion()
    const followUpType = lastQ?.followUpType ?? 'unknown'

    // (b) 失敗退避:AI 失敗後 3s 內直接用模板
    if (now - this.lastFailureAt < PANIC_FAILURE_BACKOFF_MS) {
      this.lastPanicAt = now
      this.record(scene.key, followUpType, true)
      return {
        ok: true,
        text: pickFallbackTemplate(scene, tracker),
        source: 'template',
        meta: { scene: scene.key, followUpType, tokens: scene.lengthBudget }
      }
    }

    // (c) 正常路徑:組 prompt 呼叫 AI
    this.lastPanicAt = now
    const systemPrompt = buildPanicSystemPrompt(scene, tracker)
    const userText = lastQ?.text || 'Help me respond naturally.'

    let text = ''
    let aiError: string | undefined
    try {
      text = (await aiCall(systemPrompt, userText)) ?? ''
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err)
    }

    if (!text.trim()) {
      this.lastFailureAt = now
      this.record(scene.key, followUpType, true)
      return {
        ok: true,
        text: pickFallbackTemplate(scene, tracker),
        source: 'template',
        meta: { scene: scene.key, followUpType, tokens: scene.lengthBudget, aiError }
      }
    }

    this.record(scene.key, followUpType, false)
    return {
      ok: true,
      text,
      source: 'ai',
      meta: { scene: scene.key, followUpType, tokens: scene.lengthBudget, aiError }
    }
  }

  private record(scene: string, followUpType: string, usedTemplate: boolean): void {
    this.history.push({ scene, followUpType, usedTemplate, t: Date.now() })
    if (this.history.length > 50) this.history = this.history.slice(-50)
  }

  stats(): { total: number; templateRate: number; aiRate: number } {
    const total = this.history.length
    if (total === 0) return { total: 0, templateRate: 0, aiRate: 0 }
    const used = this.history.filter((h) => h.usedTemplate).length
    const templateRate = Math.round((used / total) * 100) / 100
    return { total, templateRate, aiRate: Math.round((1 - used / total) * 100) / 100 }
  }
}

// ── per-window registry(v3 registry.js 對應)──

const registry = new Map<string, PanicOrchestrator>()

export function getOrchestrator(windowId: string, deps: PanicDeps): PanicOrchestrator {
  let orch = registry.get(windowId)
  if (!orch) {
    orch = new PanicOrchestrator(deps)
    registry.set(windowId, orch)
  } else {
    orch.setDeps(deps)
  }
  return orch
}

export function dropOrchestrator(windowId: string): void {
  registry.delete(windowId)
}

export function listOrchestrators(): string[] {
  return Array.from(registry.keys())
}
