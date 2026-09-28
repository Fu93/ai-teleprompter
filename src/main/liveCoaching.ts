import { IPC, type RescuePayload } from '@shared/types'
import { chatCompletion, resolveProvider } from './ai/aiProvider'
import { getScene, resolveScene, ConversationTracker, buildPanicSystemPrompt, pickFallbackTemplate } from './context-engine/scenes'
import { listAllScenes } from './packs'
import { buildPanicPrompt, parseRescueResponse, computeConfidence, structuredFallback } from './context-engine/panicAi'
import { pushTranscript, getRecentContext, clearContext } from './liveContext'
import {
  createTurnYieldState,
  evaluateTurnYield,
  recordTurnYield,
  resetTurnYieldState
} from './context-engine/turnYield'
import {
  checkDeadAir,
  checkInterrupt,
  createCoachingState,
  onMeSegment,
  onThemSegment,
  resetCoachingState,
  type CoachingKind,
  type CoachingSignal as EngineSignal
} from './context-engine/coachingRules'
import { state } from './state'
import { setOverlayVisible } from './windows'

// panic 的 provider 差異化 timeout(v3:Groq 900ms / Ollama 2500ms / 其他 1500ms)
function panicTimeoutMs(): number {
  const resolved = resolveProvider(state.settings)
  if (!resolved) return 1500
  if (resolved.cfg.id === 'groq') return 900
  if (resolved.cfg.isLocal) return 2500
  return 1500
}

let panicInFlight = false
const conversation = new ConversationTracker(6)

// turn-yield(Phase B):對方講完問句 → 提示「該你說話了」
const turnYieldState = createTurnYieldState()
let turnYieldTimer: ReturnType<typeof setTimeout> | null = null
let turnYieldPending: { kind: 'turn' | 'peer_silence'; question: boolean } | null = null

// 即時教練:語速/填充詞/搶話/冷場/獨白(Phase B+)
const coachingState = createCoachingState()
let coachingTimer: ReturnType<typeof setInterval> | null = null
/** 會議期間各 coaching 訊號觸發次數(會後報告用;contextReset 歸零) */
const coachingCounts: Partial<Record<CoachingKind, number>> = {}

function coachingOptions(): { baselineCpm: number } {
  return { baselineCpm: state.settings.personal.profile?.charsPerMin ?? 0 }
}

/** 開始/停止冷場週期檢查(2s); coaching 關閉時停掉 */
function syncCoachingTimer(): void {
  const want = state.settings.overlay.coaching
  if (want && coachingTimer === null) {
    coachingTimer = setInterval(() => {
      const signal = checkDeadAir(coachingState, Date.now(), coachingOptions())
      if (signal) deliverCoaching(signal)
    }, 2_000)
  } else if (!want && coachingTimer !== null) {
    clearInterval(coachingTimer)
    coachingTimer = null
  }
}

function deliverCoaching(signal: EngineSignal): void {
  coachingCounts[signal.kind] = (coachingCounts[signal.kind] ?? 0) + 1
  if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return
  state.overlayWindow.webContents.send(IPC.CoachingSignal, {
    kind: signal.kind,
    message: signal.message,
    at: Date.now()
  })
}

function onMeSegmentForCoaching(text: string): void {
  if (!state.settings.overlay.coaching) return
  const now = Date.now()
  // 搶話判定要先於段統計(需要「對方剛講完」的時間戳)
  const interrupt = checkInterrupt(coachingState, now, coachingOptions())
  if (interrupt) deliverCoaching(interrupt)
  const signal = onMeSegment(coachingState, text, now, coachingOptions())
  if (signal) deliverCoaching(signal)
}

function onThemSegmentForCoaching(text: string): void {
  if (!state.settings.overlay.coaching) return
  onThemSegment(coachingState, text, Date.now(), coachingOptions())
}

function deliverRescue(payload: RescuePayload): void {
  if (!state.overlayWindow || state.overlayWindow.isDestroyed()) setOverlayVisible(true)
  state.overlayWindow?.webContents.send(IPC.PanicRescue, payload)
}

function sendTurnYield(kind: 'turn' | 'peer_silence', question: boolean): void {
  if (!state.settings.overlay.turnYield) return
  if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return
  state.overlayWindow.webContents.send(IPC.TurnYieldSignal, { kind, question, at: Date.now() })
}

function cancelTurnYield(): void {
  turnYieldPending = null
  if (turnYieldTimer) {
    clearTimeout(turnYieldTimer)
    turnYieldTimer = null
  }
}

/** 會話邊界:清空語音上下文與即時回饋狀態(Record 起停、新場次呼叫) */
function resetSessionContext(): void {
  clearContext()
  conversation.turns.length = 0
  resetTurnYieldState(turnYieldState)
  cancelTurnYield()
  resetCoachingState(coachingState)
  for (const k of Object.keys(coachingCounts) as CoachingKind[]) {
    delete coachingCounts[k]
  }
}

/** 對方新段落 → 問句/長段評估;1.2s 防抖後提示浮層(等可能接續的後半句)。
 *  turn 問句優先於 peer_silence(長段)——被問倒比「對方停頓」更值得提示 */
function evaluateTurnYieldForSegment(text: string): void {
  if (!state.settings.overlay.turnYield) return // 關閉時不評估也不記冷卻
  const now = Date.now()
  const result = evaluateTurnYield(turnYieldState, text, now)
  if (!result) return
  recordTurnYield(turnYieldState, result, now)
  // turn 優先:已有 pending 時只升級不降級(peer_silence 不覆蓋 turn)
  if (turnYieldPending?.kind === 'turn' && result.kind === 'peer_silence') return
  turnYieldPending = { kind: result.kind, question: result.question }
  if (turnYieldTimer) clearTimeout(turnYieldTimer)
  turnYieldTimer = setTimeout(() => {
    turnYieldTimer = null
    if (!turnYieldPending) return
    sendTurnYield(turnYieldPending.kind, turnYieldPending.question)
    turnYieldPending = null
  }, 1200)
}

async function handlePanic(): Promise<void> {
  if (panicInFlight) return
  panicInFlight = true
  // 場景解析含場景包(選場景包場景後救援模板才會真的用到它);未知 key 仍退回內建 fallback。
  // 純函數放 try 外讓 catch 專注 AI 鏈路
  const scene = resolveScene(state.settings.scenario.activeScene, listAllScenes())
  const mode = state.settings.scenario.panicMode
  try {
    // AI 關閉:直接場景模板,不出 AI 卡
    if (!state.settings.scenario.aiModeEnabled) {
      deliverRescue({
        sentence: pickFallbackTemplate(scene, conversation),
        points: scene.label,
        confidence: 0.2,
        source: 'template',
        scene: scene.key
      })
      return
    }

    deliverRescue({ sentence: '', points: '', confidence: 0, source: 'template' }) // thinking 前哨(清舊卡)
    state.overlayWindow?.webContents.send(IPC.PanicThinking)

    // 上下文:最近的轉錄;若尚無語音,退而求其次用目前講稿結尾
    let context = getRecentContext()
    if (context.startsWith('(no recent speech')) {
      const script = (state.lastOverlayPayload.content ?? '').trim()
      if (script) context = script.slice(-600)
    }

    const result = await chatCompletion(
      state.settings,
      [
        { role: 'system', content: buildPanicSystemPrompt(scene, conversation) },
        { role: 'user', content: buildPanicPrompt(mode, context) }
      ],
      { maxTokens: 120, temperature: 0.7, timeoutMs: panicTimeoutMs() }
    )

    const parsed = result.ok && result.text ? parseRescueResponse(result.text) : null
    if (!parsed) {
      state.overlayWindow?.webContents.send(IPC.PanicError, result.error ?? 'AI 回應無法解析,已用模板救援')
      deliverRescue(structuredFallback(mode))
      return
    }

    deliverRescue({
      sentence: parsed.sentence,
      points: parsed.points,
      confidence: computeConfidence(parsed.confidence, context, parsed.sentence, parsed.points),
      source: 'ai',
      scene: scene.key
    })
  } catch (err) {
    // AI 層正常會把錯誤轉成 result.ok=false;這裡是 provider 層拋例外的最後防線。
    // 沒有它 panicInFlight 會卡在 true,panic 從此無反應。
    state.overlayWindow?.webContents.send(IPC.PanicError, err instanceof Error ? err.message : String(err))
    deliverRescue(structuredFallback(mode))
  } finally {
    panicInFlight = false
  }
}

/** Record/浮層轉錄段落的統一入口:餵 liveContext + conversation,依說話者分流
 *  turn-yield 與即時教練(原 ContextPushTranscript handler 本體) */
export function pushLiveTranscript(text: string, speaker: 'me' | 'them' | 'unknown'): boolean {
  pushTranscript(text, speaker)
  if (speaker === 'them') {
    conversation.add('them', text)
    evaluateTurnYieldForSegment(text)
    onThemSegmentForCoaching(text)
  } else if (speaker === 'me') {
    conversation.add('self', text)
    // 我方發言:取消未發出的提示(你已在回話;顯示中的提示由 UI 層收掉)
    cancelTurnYield()
    onMeSegmentForCoaching(text)
  }
  return true
}

export function getCoachingCounts(): Partial<Record<CoachingKind, number>> {
  return coachingCounts
}

export { syncCoachingTimer, handlePanic, resetSessionContext }
