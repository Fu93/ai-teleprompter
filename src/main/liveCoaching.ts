import { IPC, type CoachingPacePayload, type RescuePayload } from '@shared/types'
import {
  DEFAULT_CPM,
  PACE_WINDOW_MS,
  createPaceStabilizer,
  estimateCpm,
  paceEmitDecision,
  paceKey
} from './context-engine/speakingPace'
import { chatCompletion, resolveProvider } from './ai/aiProvider'
import { resolveScene, ConversationTracker, buildPanicSystemPrompt, pickFallbackTemplate } from './context-engine/scenes'
import { listAllScenes } from './packs'
import { buildPanicPrompt, parseRescueResponse, computeConfidence, structuredFallback } from './context-engine/panicAi'
import { pushTranscript, getRecentContext, clearContext } from './liveContext'
import { createTurnYieldGate } from './context-engine/turnYield'
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
import { adaptiveRescueTimeout, recordRescueSample } from './context-engine/rescueAdaptation'
import { saveSettingsThrottled } from './settings'
import { state } from './state'
import { setOverlayVisible } from './windows'
import { recordEvent } from './events'

// panic 的 provider 差異化 timeout(v3:Groq 900ms / Ollama 2500ms / 其他 1500ms)
// 在此之上再過一層自適應:實測延遲一直高於基準就放寬(只放寬、有上限),
// 見 context-engine/rescueAdaptation.ts 檔頭對「為什麼不是調觸發門檻」的說明。
function baseRescueTimeoutMs(resolved: ReturnType<typeof resolveProvider>): number {
  if (!resolved) return 1500
  if (resolved.cfg.id === 'groq') return 900
  if (resolved.cfg.isLocal) return 2500
  return 1500
}

/**
 * 目前供應商的救援延遲樣本(必要時建立)。
 *
 * 換供應商 = 重新累積:Groq 的 900ms 基準與本地 Ollama 的 2500ms 不是同一個
 * 分佈,混在一起會讓兩邊都不準。
 */
function rescueLatencySamples(providerId: string): number[] {
  const personal = state.settings.personal
  if (!personal.rescue || personal.rescue.providerId !== providerId) {
    personal.rescue = { providerId, samples: [] }
  }
  return personal.rescue.samples
}

function panicTimeoutMs(): number {
  const resolved = resolveProvider(state.settings)
  const base = baseRescueTimeoutMs(resolved)
  if (!resolved) return base
  return adaptiveRescueTimeout(base, rescueLatencySamples(resolved.cfg.id))
}

let panicInFlight = false
const conversation = new ConversationTracker(6)

// turn-yield(Phase B):對方講完問句 → 提示「該你說話了」
//
// 「評估 → 1.2s 防抖 → 送出 → 送出成功才記冷卻」整條流程都在純函式 gate 裡
// (見 context-engine/turnYield.ts 對「送達才記冷卻」的說明)。這裡只負責
// 「到底送不送得出去」的判斷 —— 那是唯一需要摸 Electron 視窗的部分。
const turnYieldGate = createTurnYieldGate({
  deliver: (payload) => sendTurnYield(payload.kind, payload.question)
})

// 即時教練:語速/填充詞/搶話/冷場/獨白(Phase B+)
const coachingState = createCoachingState()
let coachingTimer: ReturnType<typeof setInterval> | null = null
/** 會議期間各 coaching 訊號觸發次數(會後報告用;contextReset 歸零) */
const coachingCounts: Partial<Record<CoachingKind, number>> = {}

// ---- 瞬時節奏讀數(P4)----
// 與 CoachingSignal 不同:那個是**事件**(出聲、有冷卻、8 秒淡出),這個是
// **讀數**(10 秒窗、±10% 三色、不出聲)。
//
// 為什麼需要心跳:renderer 有 8 秒的過期清掃(遺失的訊息不該讓 chip 永遠
// 停在畫面上),所以一個穩定的讀數也必須每 2 秒重送一次 —— 只在變化時送
// 的話,使用者節奏穩住的那一刻 chip 就會自己消失。
//
// 為什麼窗內語音不足時要送一次 null:那是「收起 chip」的唯一訊號,
// 不送的話要等 8 秒清掃,畫面上會留著一個早已不成立的數字。
const PACE_HEARTBEAT_MS = 2_000
let paceStabilizer = createPaceStabilizer()
let lastPaceKey: string | null = null
let lastPaceSentAt = 0

function coachingOptions(): { baselineCpm: number } {
  return { baselineCpm: state.settings.personal.profile?.charsPerMin ?? 0 }
}

/** 開始/停止冷場週期檢查(2s); coaching 關閉時停掉 */
function syncCoachingTimer(): void {
  const want = state.settings.overlay.coaching
  if (want && coachingTimer === null) {
    coachingTimer = setInterval(() => {
      const now = Date.now()
      const signal = checkDeadAir(coachingState, now, coachingOptions())
      if (signal) deliverCoaching(signal)
      // 讀數的「窗內語音不足 → 收起」由這條心跳送達:沒有它,停止說話後
      // chip 只能靠 renderer 的 8 秒清掃消失。
      emitPace(now)
    }, 2_000)
  } else if (!want && coachingTimer !== null) {
    clearInterval(coachingTimer)
    coachingTimer = null
  }
}

/** 瞬時節奏讀數:算、節流、送。 */
function emitPace(now: number): void {
  if (!state.settings.overlay.coaching) return
  const rawBaseline = coachingOptions().baselineCpm
  const baseline = rawBaseline > 0 ? rawBaseline : DEFAULT_CPM
  const { cpm, verdict } = paceStabilizer.push(
    estimateCpm(coachingState.me, now, PACE_WINDOW_MS),
    baseline
  )
  // 「要不要送」是純函數(見 speakingPace.ts 的 paceEmitDecision):
  // 鍵變了送、收起的訊號只送一次、穩定時靠心跳撐著。
  const key = paceKey(cpm, verdict)
  if (
    !paceEmitDecision({
      key,
      prevKey: lastPaceKey,
      cpmIsNull: cpm === null,
      now,
      lastSentAt: lastPaceSentAt,
      heartbeatMs: PACE_HEARTBEAT_MS
    })
  ) {
    return
  }
  lastPaceKey = key
  lastPaceSentAt = now
  if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return
  const payload: CoachingPacePayload = { cpm, verdict, baseline, at: now }
  state.overlayWindow.webContents.send(IPC.CoachingPace, payload)
}

function deliverCoaching(signal: EngineSignal): void {
  coachingCounts[signal.kind] = (coachingCounts[signal.kind] ?? 0) + 1
  if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return
  /**
   * `coaching_fired` —— 宣告了,但沒有任何呼叫端。
   *
   * 放在 `isDestroyed()` 那道檢查**之後**:浮層不在時不記事件。
   * 理由是這兩件事對使用者來說不一樣 ——
   *   浮層不在 → 使用者當下根本看不到提示(問題在浮層沒開)
   *   浮層在   → 使用者看到了卻覺得它吵(問題在教練規則)
   * 記在一起就分不出來了。而 recordEvent 本身有 5 秒 rate limit,
   * 冷場訊號每 2 秒一次,沒有那個抑制會把報告洗掉。
   */
  recordEvent({
    name: 'coaching_fired',
    fields: { kind: signal.kind, total: coachingCounts[signal.kind] ?? 0 }
  })
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
  // 讀數跟著每一段落更新;節流與心跳在 emitPace 內。
  emitPace(now)
}

function onThemSegmentForCoaching(text: string): void {
  if (!state.settings.overlay.coaching) return
  onThemSegment(coachingState, text, Date.now(), coachingOptions())
}

function deliverRescue(payload: RescuePayload): void {
  // panic 是使用者當下的求助動作,救援卡必須真的看得見:
  // 視窗不存在 → 建立並顯示;視窗在但隱藏(使用者收掉了浮層,卻仍按 Alt+P)→
  // 顯示它。原寫法只在「不存在」時顯示 —— 隱藏時救援被送進看不見的視窗,
  // 使用者按了救援、畫面毫無反應。除錯路徑(ipc.ts DebugEmitSignal)早有同一道
  // 處理,真實的熱鍵路徑反而漏了。
  // 附帶的正確副作用:setOverlayVisible(true) 會解除滑鼠穿透 ——
  // 穿透中的浮層連救援卡的關閉鈕都點不到。
  if (!state.overlayWindow || state.overlayWindow.isDestroyed() || !state.overlayWindow.isVisible()) {
    setOverlayVisible(true)
  }
  state.overlayWindow?.webContents.send(IPC.PanicRescue, payload)
}

/** 送出 turn-yield 訊號。**回傳是否真的送達** —— 送不到就不能記冷卻,
 *  否則使用者那句問話會被「從來沒顯示過的提示」擋掉 25 秒。 */
function sendTurnYield(kind: 'turn' | 'peer_silence', question: boolean): boolean {
  if (!state.settings.overlay.turnYield) return false
  if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return false
  // **浮層必須真的在畫面上。** 隱藏不等於銷毀:setOverlayVisible(false) 走的是
  // win.hide(),視窗與 renderer 都活著,useTurnYield 照樣 setHint() —— 然後
  // useTurnYield.ts 的 HINT_DISPLAY_MS(6 秒)在沒人看的狀態裡走完。
  //
  // 所以「視窗存在」是**不足以**當作送達證據的:webContents.send() 不會回報
  // 有沒有 listener,而隱藏時就算 listener 在、訊號也進了 DOM,使用者依然看不到。
  // 症狀與「浮層不存在」完全一樣(那句話不見了,而且 25 秒內不會再提示),
  // 卻是常見得多的一種:使用者按熱鍵把浮層收掉是「我不提詞」的正常動作。
  //
  // 與 main 端其他環境訊號路徑同形(見 ipc.ts 的 playPause / speedUp / speedDown):
  // 「未顯示時忽略」。差別在這裡有冷卻,所以「忽略」必須真的回報沒送到。
  if (!state.overlayWindow.isVisible()) return false
  // 另一個可能也量過了:**頁面還沒 mount、useTurnYield 還沒 ipcRenderer.on**
  // 的那個時間窗(preload 的 onTurnYield 是在 useEffect 裡才註冊)。
  //
  // 實測(e2e 探針,3 輪):先把浮層顯示出來(isVisible() = true,排除「隱藏」這個
  // 變因),**不等任何東西**立刻推逐字稿 —— 3/3 都出現提示,耗时約 1.2 秒,
  // 正好等於 1.2s 防抖。也就是說**浮層一可見,listener 就已經在了**。
  //
  // 為什麼會這樣:浮層在 app.whenReady() 就建立,而 React mount 早於第一次
  // 能推逐字稿的時機(使用者還得進 Record、開麥克風、說話)。
  //
  // 所以這裡**不再需要一個猜測性的 isLoading() 檢查**,也不需要 renderer
  // 回報 ready 的握手段 —— 兩者都是為了蓋一個量不到的空窗,而量不到的空窗
  // 不值得蓋。寫在這裡是為了讓下一個人不必重新推一遍。
  state.overlayWindow.webContents.send(IPC.TurnYieldSignal, { kind, question, at: Date.now() })
  return true
}

/** 會話邊界:清空語音上下文與即時回饋狀態(Record 起停、新場次呼叫) */
function resetSessionContext(): void {
  clearContext()
  conversation.turns.length = 0
  turnYieldGate.reset()
  resetCoachingState(coachingState)
  for (const k of Object.keys(coachingCounts) as CoachingKind[]) {
    delete coachingCounts[k]
  }
  // 上一場的讀數不得跨場殘留:新場次的第一句話不該接著舊場的節奏。
  paceStabilizer = createPaceStabilizer()
  lastPaceKey = null
  lastPaceSentAt = 0
  if (state.settings.overlay.coaching && state.overlayWindow && !state.overlayWindow.isDestroyed()) {
    state.overlayWindow.webContents.send(IPC.CoachingPace, {
      cpm: null,
      verdict: null,
      baseline: DEFAULT_CPM,
      at: Date.now()
    } satisfies CoachingPacePayload)
  }
}

/** 對方新段落 → 問句/長段評估;防抖與冷卻記帳都在純函式 gate 內。 */
function evaluateTurnYieldForSegment(text: string): void {
  if (!state.settings.overlay.turnYield) return // 關閉時不評估也不記冷卻
  turnYieldGate.push(text)
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

    const rescueStartedAt = Date.now()
    const result = await chatCompletion(
      state.settings,
      [
        { role: 'system', content: buildPanicSystemPrompt(scene, conversation) },
        { role: 'user', content: buildPanicPrompt(mode, context) }
      ],
      { maxTokens: 120, temperature: 0.7, timeoutMs: panicTimeoutMs() }
    )

    // 只有真的收到回應才記樣本。超時的那一次量到的是**預算本身**,
    // 不是 provider 的延遲 —— 記進去會讓預算自己把自己撐大。
    if (result.ok) {
      const providerId = resolveProvider(state.settings)?.cfg.id
      if (providerId) {
        recordRescueSample(
          rescueLatencySamples(providerId),
          result.meta?.latencyMs ?? Date.now() - rescueStartedAt
        )
        saveSettingsThrottled(state.settings)
      }
    }

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
    turnYieldGate.cancel()
    onMeSegmentForCoaching(text)
  }
  return true
}

export function getCoachingCounts(): Partial<Record<CoachingKind, number>> {
  return coachingCounts
}

export { syncCoachingTimer, handlePanic, resetSessionContext }
