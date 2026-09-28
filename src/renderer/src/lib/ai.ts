// 統一 AI 呼叫介面：依設定路由到 Ollama 或 OpenAI 相容 API
import type { AppSettings } from '@shared/types'
import type { OllamaChatApiRequest } from '@shared/api'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export async function aiChat(
  settings: AppSettings,
  messages: ChatMessage[],
  opts?: { temperature?: number }
): Promise<string> {
  const ai = settings.ai
  if (ai.provider === 'ollama') {
    const req: OllamaChatApiRequest = {
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseUrl: ai.ollama.baseUrl,
      model: ai.ollama.model,
      messages,
      temperature: opts?.temperature
    }
    const res = await window.api.ollamaChat(req)
    if (!res.ok) throw new Error(res.error ?? 'AI 呼叫失敗')
    return res.text ?? ''
  }
  const { baseUrl, apiKey, model } = ai.openaiCompatible
  if (!baseUrl || !model) throw new Error('請先在設定頁填入 OpenAI 相容 API 的 Base URL 與模型')
  const res = await window.api.openAiChat({ baseUrl, apiKey, model, messages, temperature: opts?.temperature })
  if (!res.ok) throw new Error(res.error ?? 'AI 呼叫失敗')
  return res.text ?? ''
}

/** 實際會收到請求的模型名稱(與 aiChat 的路由一致);摘要紀錄等出處標記用 */
export function resolvedModelName(settings: AppSettings): string {
  const ai = settings.ai
  return ai.provider === 'ollama' ? ai.ollama.model : ai.openaiCompatible.model
}

/** 從 LLM 輸出中取出 JSON（容忍 ```json 圍籬、前後雜文） */
export function extractJson<T>(raw: string): T {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(candidate) as T
  } catch {
    // 找第一個 { 或 [ 到最後一個 } 或 ]
    const start = candidate.search(/[{[]/)
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T
    }
    throw new Error('AI 回傳的不是有效 JSON：' + raw.slice(0, 200))
  }
}
