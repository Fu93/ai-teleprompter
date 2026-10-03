import { AppSettings } from '@shared/types'
import { E2E_ENV } from './debug'
import { abortRequest, releaseRequest, trackRequest } from './ai/aiAbort'

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
  /**
   * e2e 故障注入。放在**這裡**而不是 renderer:
   *   contextBridge 凍結了 window.api,在 renderer 改寫它會丟 TypeError 而讓
   *   整個入口檔中止(見 renderer/src/lib/e2eFaults.ts 的檔頭)。而放�� main
   *   還有一個好處:preflight 與設定頁「測試連線」兩個呼叫點都會看到同一個故障。
   *
   * 兩種情境的差別是使用者真的會分辨的:
   *   down      → fetch 真的會失敗(ECONNREFUSED),與沒有啟動 Ollama 完全同形
   *   no-model  → 200 但 models 是空的 —— 使用者看到的是「連上了但沒模型」,
   *               這與「沒裝」是**不同的兩句話**,而 preflight 對它們的建議不同
   *               (一個要下載安裝、一個要 ollama pull)。把它們合併成一種狀態
   *               就會讓「已連線但沒模型」這條指引永遠沒有機會被驗。
   */
  if (E2E_ENV.ollama === 'down') throw new Error('Ollama 回應 0(連線失敗)')
  if (E2E_ENV.ollama === 'no-model') return []

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
  /**
   * e2e 故障注入(與 ollamaListModels 同一組情境,理由見該處的註解)。
   *
   * 這裡的值決定 `installed`,所以**每個情境都要給出正確的答案**:
   *   down     → null(服務沒開,版本自然取不到)
   *   no-model → 版本字串 —— 因為「服務活著但沒有模型」正是 `installed: true`
   *              與 `models: []` 的組合。回 null 會讓它被說成「沒裝」,
   *              而使用者看到的兩句話是不同的:一個要安裝、一個要 pull 模型。
   */
  if (E2E_ENV.ollama === 'down') return null
  if (E2E_ENV.ollama === 'no-model') return '0.0.0-e2e'

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

export function abortOllamaChat(requestId: string): void {
  abortRequest(requestId)
}

export async function ollamaChat(req: OllamaChatRequest, settings: AppSettings): Promise<string> {
  const model = req.model || settings.ai.ollama.model
  if (!model) throw new Error('尚未選擇 Ollama 模型，請到設定頁選擇')

  const controller = trackRequest(req.requestId)
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
    // 逾時與使用者取消走同一個 AbortError 分支。對呼叫端來說是一件事:
    // 這次呼叫沒有結果了。區分它們只會讓「他按了取消」變成一種需要被
    // 特殊處理的錯誤狀態,而訊息裡說清楚就好了。
    if (controller.signal.aborted) throw new Error('已取消')
    throw err
  } finally {
    clearTimeout(timeout)
    releaseRequest(req.requestId)
  }
}
