/**
 * aiProvider.ts — 統一 AI 呼叫層(electron 側;以 flowprompt-v3 aiProvider 為藍本)
 *
 * 金鑰安全:雲端 key 存 userData/keys.enc(safeStorage 加密),設定檔內的
 * 明文欄位僅作為遷移期 fallback。provider 解析:設定 > key 前綴偵測。
 */

import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import type { AppSettings } from '@shared/types'
import { PROVIDERS, buildAuthHeaders, buildRequestBody, extractChatText, resolveEndpoint } from './providerRegistry'
import type { ProviderConfig } from './providerRegistry'
import { resolveProviderId, resolveModel } from './providerDetection'
import { OLLAMA_DEFAULT_ENDPOINT } from './ollamaEndpoint'
import type { ChatCompletionRequest, ChatCompletionResult } from './types'
import type { ChatMessage } from './types'

const KEYS_FILE = (): string => join(app.getPath('userData'), 'keys.enc')
const CACHE_TTL_MS = 5000

interface SecureKeys {
  apiKey?: string
  sttApiKey?: string
  [provider: string]: unknown
}

let cachedKeys: SecureKeys | null = null
let cachedAt = 0

export function invalidateApiKeyCache(): void {
  cachedKeys = null
  cachedAt = 0
}

function readSecureKeys(): SecureKeys | null {
  const now = Date.now()
  if (cachedKeys && now - cachedAt < CACHE_TTL_MS) return cachedKeys
  try {
    if (!safeStorage.isEncryptionAvailable() || !existsSync(KEYS_FILE())) return null
    const decrypted = safeStorage.decryptString(readFileSync(KEYS_FILE()))
    cachedKeys = JSON.parse(decrypted) as SecureKeys
    cachedAt = now
    return cachedKeys
  } catch {
    return null
  }
}

export function getUserKeys(): SecureKeys | null {
  return readSecureKeys()
}

export function setUserKeys(keys: SecureKeys): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    const enc = safeStorage.encryptString(JSON.stringify(keys))
    const p = KEYS_FILE()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, enc)
    invalidateApiKeyCache()
    return true
  } catch {
    return false
  }
}

/** 將舊版 settings.json 的明文金鑰遷移至 safeStorage；只有加密寫入成功才清除明文。 */
export function migrateLegacyKeys(settings: AppSettings): boolean {
  const legacyAiKey = settings.ai.openaiCompatible.apiKey
  const legacySttKey = settings.stt.cloud.apiKey
  if (!legacyAiKey && !legacySttKey) return false

  const keys = readSecureKeys() ?? {}
  const encryptedAiKey = keys.apiKey || legacyAiKey
  const encryptedSttKey = keys.sttApiKey || legacySttKey
  if (!encryptedAiKey && !encryptedSttKey) return false
  keys.apiKey = encryptedAiKey
  keys.sttApiKey = encryptedSttKey

  // safeStorage 不可用或落盤失敗時保留舊設定以維持功能，不要丟失金鑰。
  if (!setUserKeys(keys)) return false
  if (legacyAiKey && encryptedAiKey) settings.ai.openaiCompatible.apiKey = ''
  if (legacySttKey && encryptedSttKey) settings.stt.cloud.apiKey = ''
  return Boolean((legacyAiKey && encryptedAiKey) || (legacySttKey && encryptedSttKey))
}

interface ResolvedProvider {
  cfg: ProviderConfig
  endpoint: string
  model: string
  apiKey: string | null
}

/**
 * 由設定 + 安全金鑰解析出實際可用的 provider。
 * 回傳 null 表示設定不完整(缺 key / endpoint 無效)。
 */
export function resolveProvider(settings: AppSettings): ResolvedProvider | null {
  const ai = settings.ai
  const secureKey = readSecureKeys()?.apiKey ?? null

  if (ai.provider === 'ollama') {
    const cfg = PROVIDERS['ollama']
    const endpoint = resolveEndpoint(cfg, ai.ollama.baseUrl) ?? OLLAMA_DEFAULT_ENDPOINT
    const model = ai.ollama.model || cfg.defaultModel
    return { cfg, endpoint, model, apiKey: null }
  }

  // openai-compatible(或未來擴充的具名 provider)
  const plainKey = ai.openaiCompatible.apiKey || ''
  const apiKey = secureKey || plainKey || process.env['OPENAI_API_KEY'] || null
  const id = resolveProviderId(apiKey, ai.provider)

  // key 前綴指向具名雲端 provider 且使用者未自訂 baseUrl 時,改用該 provider 官方 endpoint
  const named = id !== 'openai-compatible' && id !== 'ollama' && !ai.openaiCompatible.baseUrl
  const cfg = named ? PROVIDERS[id] : PROVIDERS['openai-compatible']
  const endpoint = resolveEndpoint(cfg, named ? cfg.endpoint : ai.openaiCompatible.baseUrl)
  if (!endpoint) return null
  if (!cfg.isLocal && cfg.authScheme !== 'none' && !apiKey) return null

  const model =
    ai.openaiCompatible.model ||
    resolveModel(cfg.models, cfg.defaultModel, ai.openaiCompatible.model, cfg.isLocal)

  return { cfg, endpoint, model, apiKey }
}

export function isAIConfigured(settings: AppSettings): boolean {
  return resolveProvider(settings) !== null
}

/** 單發非串流 chat completion;panic 等低延遲場景用 */
export async function chatCompletion(
  settings: AppSettings,
  messages: ChatMessage[],
  opts: Omit<ChatCompletionRequest, 'messages'> = {}
): Promise<ChatCompletionResult> {
  const resolved = resolveProvider(settings)
  if (!resolved) {
    return { ok: false, error: 'AI 未設定——請到設定頁選擇 provider 並填入金鑰' }
  }

  const { cfg, endpoint, model, apiKey } = resolved
  const timeoutMs = opts.timeoutMs ?? 10_000
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(cfg, apiKey) },
      body: JSON.stringify(
        buildRequestBody(cfg, {
          model,
          messages,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          jsonMode: opts.jsonMode
        })
      ),
      signal: controller.signal
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      return {
        ok: false,
        error: `${cfg.name} API error: ${res.status} - ${errorText.slice(0, 300)}`,
        meta: { provider: cfg.id, model, latencyMs: Date.now() - startedAt }
      }
    }

    const data = (await res.json()) as unknown
    const text = extractChatText(cfg, data)
    return {
      ok: true,
      text,
      meta: { provider: cfg.id, model, latencyMs: Date.now() - startedAt }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: `${cfg.name} request timeout`, meta: { provider: cfg.id, model, latencyMs: Date.now() - startedAt } }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** 設定頁「測試連線」:不落 settings,直接以參數試連 */
export async function testConnection(args: {
  provider: string
  apiKey?: string
  endpoint?: string
  model?: string
}): Promise<{ ok: boolean; error?: string }> {
  const alias = (args.provider || '').toLowerCase()
  const id = alias === 'ollama' ? 'ollama' : alias === 'groq' ? 'groq' : alias === 'anthropic' || alias === 'claude' ? 'anthropic' : 'openai-compatible'
  const cfg = PROVIDERS[id]

  try {
    if (cfg.isLocal) {
      const endpoint = resolveEndpoint(cfg, args.endpoint)
      if (!endpoint) return { ok: false, error: 'Ollama 位址無效或非本機/私有網段,無法連線' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: args.model || cfg.defaultModel,
            messages: [{ role: 'user', content: 'OK' }],
            stream: false,
            options: { num_predict: 1 }
          }),
          signal: controller.signal
        })
        if (!res.ok) return { ok: false, error: `${cfg.name} 回應 ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` }
        return { ok: true }
      } finally {
        clearTimeout(timer)
      }
    }

    const endpoint = resolveEndpoint(cfg, args.endpoint)
    if (!endpoint) return { ok: false, error: 'Base URL 無效' }
    if (!args.apiKey) return { ok: false, error: '請先輸入 API Key' }
    const model = args.model || cfg.defaultModel

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.authScheme === 'anthropic') {
      headers['x-api-key'] = args.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (cfg.authScheme === 'bearer') {
      headers['Authorization'] = `Bearer ${args.apiKey}`
    }

    const body =
      cfg.authScheme === 'anthropic'
        ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'OK' }] }
        : { model, messages: [{ role: 'user', content: 'OK' }], max_tokens: 1, temperature: 0 }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      if (!res.ok) return { ok: false, error: `${cfg.name} 回應 ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` }
      return { ok: true }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, error: `${cfg.name} 連線逾時` }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
