/**
 * providerRegistry.ts — 多 provider 註冊表與請求組裝(自 flowprompt-v3 移植,純函數)
 *
 * 支援:OpenAI / Anthropic / Groq / Ollama / 自訂 OpenAI 相容 endpoint。
 * 此檔不依賴 electron,供 main 與測試共用。
 */

import type { ChatMessage } from './types'
import { normalizeOllamaEndpointUrl } from './ollamaEndpoint'

export interface ProviderConfig {
  id: string
  name: string
  endpoint: string
  defaultModel: string
  models: string[]
  supportsJson: boolean
  isLocal?: boolean
  /** anthropic 用 x-api-key,其餘 Bearer;ollama 免鑰 */
  authScheme: 'bearer' | 'anthropic' | 'none'
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    supportsJson: true,
    authScheme: 'bearer'
  },
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-3-5-haiku-20241022',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
    supportsJson: false,
    authScheme: 'anthropic'
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it', 'mixtral-8x7b-32768'],
    supportsJson: true,
    authScheme: 'bearer'
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    endpoint: 'http://localhost:11434',
    defaultModel: 'qwen2.5:7b',
    models: ['qwen2.5:7b', 'llama3.2', 'llama3.1', 'mistral', 'gemma2'],
    supportsJson: false,
    isLocal: true,
    authScheme: 'none'
  },
  'openai-compatible': {
    id: 'openai-compatible',
    name: 'OpenAI 相容',
    endpoint: '',
    defaultModel: '',
    models: [],
    supportsJson: true,
    authScheme: 'bearer'
  }
}

export function buildAuthHeaders(cfg: ProviderConfig, apiKey: string | null): Record<string, string> {
  switch (cfg.authScheme) {
    case 'anthropic':
      return { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
    case 'bearer':
      return { Authorization: `Bearer ${apiKey ?? ''}` }
    default:
      return {}
  }
}

export interface CompletionOptions {
  model: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  jsonMode?: boolean
}

/** 依 provider 組出請求 body(anthropic 的 system 訊息抽到頂層) */
export function buildRequestBody(cfg: ProviderConfig, opts: CompletionOptions): Record<string, unknown> {
  const { model, messages, maxTokens = 500, temperature = 0.7, jsonMode = false } = opts

  if (cfg.authScheme === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    const userMsgs = messages.filter((m) => m.role !== 'system')
    return {
      model,
      max_tokens: maxTokens,
      messages: userMsgs,
      ...(system ? { system } : {}),
      temperature
    }
  }

  if (cfg.isLocal) {
    return {
      model,
      messages,
      stream: false,
      options: { temperature, num_predict: maxTokens }
    }
  }

  // OpenAI 相容(openai / groq / 自訂)
  return {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(jsonMode && cfg.supportsJson ? { response_format: { type: 'json_object' } } : {})
  }
}

/** 依 provider 從回應 JSON 抽出文字 */
export function extractChatText(cfg: ProviderConfig, data: unknown): string {
  const d = data as Record<string, unknown>
  if (cfg.authScheme === 'anthropic') {
    const content = d?.content as Array<{ text?: string }> | undefined
    return content?.[0]?.text ?? ''
  }
  if (cfg.isLocal) {
    const message = d?.message as { content?: string } | undefined
    return message?.content ?? ''
  }
  const choices = d?.choices as Array<{ message?: { content?: string } }> | undefined
  return choices?.[0]?.message?.content ?? ''
}

/**
 * 解析實際請求用的 endpoint:
 * - ollama:以使用者設定的 baseUrl 經 SSRF 正規化(無效→回 null)
 * - openai-compatible:使用者 baseUrl + /chat/completions(去尾斜線)
 * - 其他:註冊表預設
 */
export function resolveEndpoint(cfg: ProviderConfig, userEndpoint: unknown): string | null {
  if (cfg.isLocal) return normalizeOllamaEndpointUrl(userEndpoint)
  if (cfg.id === 'openai-compatible') {
    if (!userEndpoint || typeof userEndpoint !== 'string') return null
    const base = userEndpoint.replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) return null
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  }
  return cfg.endpoint
}
