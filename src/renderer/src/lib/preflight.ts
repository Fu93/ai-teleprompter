/**
 * preflight.ts — 第一次使用之前,先講清楚這台電腦還差什麼。
 *
 * 為什麼需要:
 *   這個 App 的兩件事需要外部東西才能運作 —— AI 需要一個本機模型(Ollama)或
 *   雲端 API,語音辨識需要一個 Whisper 模型。而 `ollama pull qwen2.5:7b` 這句話
 *   **只出現在失敗之後**(`describeError.ts` 的錯誤翻譯、設定頁的連線測試結果)。
 *   這是個桌面 App:非技術的使用者第一次點「開始練習」,看到的是一句要他在
 *   終端機裡打的指令 —— 然後他就再也不會打開這個程式了。
 *   產品死在第一次使用,而且死得沒有任何錯誤訊息。
 *
 * 三個刻意的決定:
 *
 * 1. **不擋路。** 這不是入口的強制精靈,而是一張卡片 + 總覽頁的一行提示。
 *    使用者可能只想看設定、只想調浮層外觀、或只想讀舊的會議紀錄;
 *    擋在入口的精靈會讓他永遠進不去,連「看看這東西長什麼樣」都做不到。
 *    真正的殺手是「進不去」,不是「沒提醒」。
 *
 * 2. **每一項都要有下一步,而且那個下一步要能直接用。**
 *    特別是 `ollama pull …`:使用者要在**自己的終端機**打,所以要給可點的複製鈕,
 *    讓他複製而不是手抄。手抄 40 個字元打錯一個就是又一轮除錯。
 *
 * 3. **分「擋路」與「不擋路」兩級。**
 *    沒有任何 AI 模型 = 練習/摘要/教練全部不能用,那是擋路級;
 *    Whisper 還沒下載只是第一次錄音時要等,那是「要有心理準備」級。
 *    把兩者混成一個紅色警告,會讓只有其中一個問題的人以為整個程式壞了。
 */
import { create } from 'zustand'
import { WHISPER_MODELS } from './audio/whisperClient'
import type { WhisperModelKey } from './audio/whisperClient'
import type { AppSettings } from '@shared/types'
// 下載網址的唯一出處在 shared/errorCodes.ts(與「無法連線到 Ollama」那則
// actionable 提示共用)。原本這裡自己定義一份,兩份可以各自漂移 —— 而漂移之後
// 使用者按的兩個「下載」會通往不同地方。
import { OLLAMA_DOWNLOAD_URL } from '@shared/errorCodes'

export type PreflightSeverity = 'blocking' | 'notice' | 'ready'

export interface PreflightItem {
  id: string
  severity: PreflightSeverity
  /** 標題:使用者一眼知道缺什麼 */
  title: string
  /** 怎麼做。要具體到可以照著做,不是「請檢查設定」。 */
  how: string
  /** 要複製到終端機的指令(有的話)。使用者要自己打,程式替他不了。 */
  command?: string
  /** 點下去要做什麼 */
  action?:
    | { kind: 'goto'; page: 'settings' | 'record' | 'practice'; note?: string }
    | { kind: 'copy'; text: string }
    | { kind: 'external'; url: string }
}

export interface PreflightResult {
  items: PreflightItem[]
  /** 有擋路級的問題嗎?擋路 = 這台電腦上有一整個功能完全不能用 */
  blocking: boolean
  /** 三種狀態都要能被量到:全好 / 只有提示 / 有擋路 */
  severity: PreflightSeverity
}

/** 預設建議的模型。與 describeError.ts / Practice.tsx / SettingsPage 用的是同一個。 */
export const SUGGESTED_OLLAMA_MODEL = 'qwen2.5:7b'
// re-export 保留原本的 import 點不動(components/PreflightCard.tsx 與
// lib/preflight.ts 的測試都從這裡取)。單一出處在 shared/errorCodes.ts。
export { OLLAMA_DOWNLOAD_URL }

export interface PreflightInput {
  settings: AppSettings | null
  /** ollamaListModels 的結果;null = 還沒查或查不到(不是「沒有模型」) */
  ollamaModels: string[] | null
  /** ollama 有沒有連上。false 與「連上了但沒模型」是完全不同的兩件事 */
  ollamaReachable: boolean
  /** 雲端 STT 有沒有填金鑰 */
  cloudSttKeyPresent: boolean
  /** 雲端 AI 有沒有填金鑰 */
  cloudAiKeyPresent: boolean
}

// ===== audit-only:讓測試能製造「有模型」與「沒裝 Ollama」兩種狀態 =====
// 為什麼放在這裡而不是去改寫 window.api.ollamaListModels:
//   contextBridge 凍結的 api 物件是**不可賦值**的。在 ESM(永遠是嚴格模式)裡
//   賦值會丟 TypeError,而那發生在 main.tsx 的模組層級 —— 於是整個入口檔中止,
//   頁面全白,連側欄都沒有。實測踩過:那時所有 audit 控制項都沒註冊成功。
//   而且「在測試裡改寫一個凍結的依賴」本來就不是能長久的做法。
//
// 做成 zustand store 而不是模組變數:測試改變狀態之後,卡片必須**立刻**重畫。
// 用模組變數時,effect 只會在 settings 改變時重跑,於是「改完沒反應」會被誤讀成
// 「卡片壞了」,然後為了讓測試過而把元件改壞。
const useAuditOllama = create<AuditOllamaState>(() => ({ active: false, models: [], down: false }))

interface AuditOllamaState {
  active: boolean
  models: string[]
  down: boolean
}

/** arg 為 undefined = 恢復真的去查;null = 明確表示「連不上」;陣列 = 假裝有那些模型 */
export function setAuditOllama(models: string[] | null | undefined, down?: boolean): void {
  if (models === undefined && down === undefined) {
    useAuditOllama.setState({ active: false, models: [], down: false })
    return
  }
  useAuditOllama.setState({
    active: true,
    models: models ?? [],
    down: down === true
  })
}

export function useOllamaAuditOverride(): Readonly<AuditOllamaState> {
  return useAuditOllama()
}

export interface OllamaProbe {
  installed: boolean
  models: string[] | null
}

export async function probeOllama(baseUrl: string): Promise<OllamaProbe> {
  const a = useAuditOllama.getState()
  if (a.active) {
    return { installed: !a.down, models: a.down ? null : a.models }
  }
  try {
    const r = await window.api.ollamaListModels(baseUrl)
    return { installed: r.installed, models: r.models }
  } catch {
    return { installed: false, models: null }
  }
}

export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const { settings, ollamaModels, ollamaReachable, cloudSttKeyPresent, cloudAiKeyPresent } = input
  const items: PreflightItem[] = []

  if (!settings) {
    // 設定還沒載完 —— 這不是問題,是「還不知道」。寧可少講一句,
    // 也不要在一個什麼都還沒載入的畫面上宣布「你少了三樣東西」。
    return { items, blocking: false, severity: 'ready' }
  }

  // ---- 1. AI 模型 ----
  if (settings.ai.provider === 'ollama') {
    if (!ollamaReachable) {
      items.push({
        id: 'ai-ollama-down',
        severity: 'blocking',
        title: 'AI 助理需要 Ollama,但現在連不上',
        how: `先安裝並啟動 Ollama（${OLLAMA_DOWNLOAD_URL}）。啟動之後回到這裡,這張卡片會自己消失。`,
        action: { kind: 'external', url: OLLAMA_DOWNLOAD_URL }
      })
    } else if (ollamaModels !== null && ollamaModels.length === 0) {
      // 這是 App 死在第一次使用的那一步:使用者已經裝好 Ollama 了,
      // 但沒有任何模型,於是他必須自己去終端機打一行字。
      items.push({
        id: 'ai-ollama-no-model',
        severity: 'blocking',
        title: 'Ollama 裝好了,但還沒有任何模型',
        how: `在你的終端機（PowerShell 或命令提示字元）貼上這一行,按 Enter,等它跑完。模型大約 4.7GB,視網速需要幾分鐘。\n\n設定頁的「測試連線」按下去是空的,也代表這一步還沒做。`,
        command: `ollama pull ${SUGGESTED_OLLAMA_MODEL}`,
        action: { kind: 'goto', page: 'settings' }
      })
    }
  } else if (!cloudAiKeyPresent) {
    items.push({
      id: 'ai-cloud-no-key',
      severity: 'blocking',
      title: 'AI 助理選了雲端 API,但還沒有填 API Key',
      how: '到設定 → AI 助理填入 API Key 與模型名稱,按「測試連線」確認可以連上。',
      action: { kind: 'goto', page: 'settings' }
    })
  }

  // ---- 2. 語音辨識 ----
  if (settings.stt.engine === 'local') {
    const model = WHISPER_MODELS[settings.stt.localModel as WhisperModelKey] ?? WHISPER_MODELS.base
    items.push({
      id: 'stt-local-download',
      // 這是「notice」不是「blocking」:它只會在**第一次錄音**時擋住,
      // 而且會顯示下載進度。把一個只影響第一次的等待升級成紅色阻擋級,
      // 會讓人誤以為程式壞了。
      severity: 'notice',
      title: '第一次錄音時會下載語音辨識模型',
      how: `目前選的是 ${model.label}。模型會在第一次錄音時自動下載並快取,之後離線也能用。下載時錄音會暫停 —— 這是正常的。\n\n想換更小的模型可以到設定 → 語音辨識改,tiny 約 75MB。`,
      action: { kind: 'goto', page: 'settings' }
    })
  } else if (!cloudSttKeyPresent) {
    items.push({
      id: 'stt-cloud-no-key',
      severity: 'blocking',
      title: '語音辨識選了雲端,但還沒有填 API Key',
      how: '到設定 → 語音辨識填入 API Key。提醒:雲端辨識會把音訊送到那個服務。',
      action: { kind: 'goto', page: 'settings' }
    })
  }

  const blocking = items.some((i) => i.severity === 'blocking')
  const severity: PreflightSeverity = blocking
    ? 'blocking'
    : items.length > 0
      ? 'notice'
      : 'ready'
  return { items, blocking, severity }
}
