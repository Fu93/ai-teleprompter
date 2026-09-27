import { AppSettings } from '@shared/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OllamaChatRequest {
  requestId: string
  baseUrl: string
  model: string
  messages: ChatMessage[]
  temperature?: number
}

const DEFAULT_TIMEOUT_MS = 300_000 // 本地模型生成可能較慢

export async function ollamaListModels(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) throw new Error(`Ollama 回應 ${res.status}`)
  const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> }
  return (data.models ?? [])
    .map((m) => m.name ?? m.model ?? '')
    .filter((n): n is string => n.length > 0)
}

export async function ollamaVersion(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/version`, {
      signal: AbortSignal.timeout(3000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { version?: string }
    return data.version ?? null
  } catch {
    return null
  }
}

const abortControllers = new Map<string, AbortController>()

export function abortOllamaChat(requestId: string): void {
  abortControllers.get(requestId)?.abort()
  abortControllers.delete(requestId)
}

export async function ollamaChat(req: OllamaChatRequest, settings: AppSettings): Promise<string> {
  const model = req.model || settings.ai.ollama.model
  if (!model) throw new Error('尚未選擇 Ollama 模型，請到設定頁選擇')

  const controller = new AbortController()
  abortControllers.set(req.requestId, controller)
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const res = await fetch(`${req.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: req.messages,
        stream: false,
        options: req.temperature != null ? { temperature: req.temperature } : undefined
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Ollama 回應 ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as { message?: { content?: string } }
    return data.message?.content ?? ''
  } catch (err) {
    if (controller.signal.aborted) throw new Error('已取消')
    throw err
  } finally {
    clearTimeout(timeout)
    abortControllers.delete(req.requestId)
  }
}
