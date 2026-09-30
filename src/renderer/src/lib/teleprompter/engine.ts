/**
 * engine.ts — 提詞定時引擎(以 flowprompt-v3 unifiedTimingEngine 為藍本的 TS 重寫)
 *
 * 設計:單一時間基準 + 四模式共用一套狀態機。
 * - 純 TypeScript 類別,不依賴 React / DOM(時鐘由外部 tick(now) 注入,可完整單測)
 * - tick() 回傳變更等級,RAF 層只在不斷變更(discrete)或節流後(continuous)觸發 re-render
 * - scroll 模式的連續位移由 UI 層直接寫入 DOM,不經過 React
 *
 * 時間語意(沿用 v3):
 * - phrase:每短語時長 = (詞數 / 120wpm) × 60000 / rate,下限 MIN_PHRASE_DURATION_MS;
 *   句末短語額外乘 (1.4 + rate×0.08) 的停頓係數,讓換句呼吸感隨語速保留
 * - karaoke:每詞 280ms / rate
 * - bullet:不自動推進(手動 / 未來 VAD 觸發),沿用 v3 設計
 * - scroll:連續像素捲動,速度為 px/秒(沿用本專案既有語意)
 */

import { PhraseVisuals } from './constants'
import type { OverlayDisplayMode } from '@shared/types'
import type { ScriptModel } from './scriptModel'

export type EngineStatus = 'idle' | 'playing' | 'paused' | 'completed'

/** tick() 的變更等級:none=無變化 / continuous=只有連續量變化 / discrete=離散狀態變化 */
export type TickChange = 'none' | 'continuous' | 'discrete'

export interface EngineState {
  status: EngineStatus
  sentenceIndex: number
  phraseIndex: number
  karaokeChunkIndex: number
  karaokeWordIndex: number
  bulletIndex: number
  scrollPos: number
  elapsedMs: number
  /** 當前步驟預計時長(phrase/karaoke);UI 用於預讀高亮 */
  stepDurationMs: number
  /** 當前步驟已經過時間 */
  stepElapsedMs: number
}

export interface EngineOptions {
  /** phrase/karaoke 速度倍率,1 = 120 WPM */
  rate: number
  /** scroll 模式捲動速度(px/秒) */
  scrollSpeed: number
  /** scroll 模式:內容總高(px) */
  totalH?: number
  /** scroll 模式:視窗內可視高(px) */
  wrapH?: number
  /** 單次 tick 的 dt 上限(防切窗/休眠後跳幀);測試可調大 */
  maxTickDtMs?: number
}

const MAX_WPM = PhraseVisuals.DEFAULT_WPM
const MIN_PHRASE_MS = PhraseVisuals.MIN_PHRASE_DURATION_MS
/** 單次 tick 的預設最大 dt,避免切窗/休眠回來後一次跳一大段 */
const DEFAULT_MAX_TICK_DT_MS = 250
/** karaoke 每詞基準間隔(120wpm 以上語感,rate=1 時) */
const KARAOKE_WORD_INTERVAL_MS = 280
/** scroll 模式底部的額外緩衝(px),讓最後一行滾出可視區 */
const SCROLL_TAIL_PADDING_PX = 40

export class TeleprompterEngine {
  displayMode: OverlayDisplayMode

  readonly model: ScriptModel
  private opts: EngineOptions

  private status: EngineStatus = 'idle'
  private sentenceIndex = 0
  private phraseIndex = 0
  private karaokeChunkIndex = 0
  private karaokeWordIndex = 0
  private bulletIndex = 0
  private scrollPos = 0
  private elapsedMs = 0
  private stepElapsedMs = 0
  private stepDurationMs = 0
  private lastTickAt: number | null = null

  constructor(model: ScriptModel, opts: EngineOptions, displayMode: OverlayDisplayMode = 'scroll') {
    this.model = model
    this.opts = opts
    this.displayMode = displayMode
    this.stepDurationMs = this.computeStepDuration()
  }

  // ── 控制 ──

  play(): void {
    if (this.displayMode === 'bullet') return // bullet 為手動模式,不自動播放
    if (this.status === 'completed') {
      this.resetPositions()
    }
    this.status = 'playing'
    this.lastTickAt = null
  }

  pause(): void {
    if (this.status === 'playing') {
      this.status = 'paused'
      this.lastTickAt = null
    }
  }

  toggle(): void {
    if (this.status === 'playing') this.pause()
    else this.play()
  }

  restart(): void {
    this.resetPositions()
    if (this.displayMode === 'bullet') {
      this.status = 'idle'
      return
    }
    this.status = 'playing'
    this.lastTickAt = null
  }

  /** bullet 模式手動前進 */
  manualNext(): void {
    const max = Math.max(0, this.model.bullets.length - 1)
    if (this.bulletIndex < max) {
      this.bulletIndex++
      this.status = this.bulletIndex >= max ? 'completed' : this.status === 'completed' ? 'paused' : this.status
    }
  }

  /** bullet 模式手動後退 */
  manualPrev(): void {
    if (this.bulletIndex > 0) {
      this.bulletIndex--
      if (this.status === 'completed') this.status = 'paused'
    }
  }

  setOptions(patch: Partial<EngineOptions>): void {
    this.opts = { ...this.opts, ...patch }
    this.stepDurationMs = this.computeStepDuration()
  }

  /** 切換顯示模式:重置該模式的游標,保留累計時間;bullet 模式一律暫停 */
  setDisplayMode(mode: OverlayDisplayMode): void {
    if (mode === this.displayMode) return
    this.displayMode = mode
    this.sentenceIndex = 0
    this.phraseIndex = 0
    this.karaokeChunkIndex = 0
    this.karaokeWordIndex = 0
    this.bulletIndex = 0
    this.scrollPos = 0
    this.stepElapsedMs = 0
    this.lastTickAt = null
    if (mode === 'bullet') {
      if (this.status === 'playing') this.status = 'paused'
    } else if (this.status === 'completed') {
      this.status = 'paused'
    }
    this.stepDurationMs = this.computeStepDuration()
  }

  // ── 時間推進 ──

  /**
   * 推進引擎到 now(-performance.now() 時間軸)。
   * 呼叫端以 RAF 每幀呼叫一次;回傳本幀的變更等級。
   */
  tick(now: number): TickChange {
    if (this.status !== 'playing') return 'none'

    if (this.lastTickAt === null) {
      this.lastTickAt = now
      return 'none'
    }

    const maxDt = this.opts.maxTickDtMs ?? DEFAULT_MAX_TICK_DT_MS
    const dt = Math.min(maxDt, Math.max(0, now - this.lastTickAt))
    this.lastTickAt = now
    if (dt === 0) return 'none'

    this.elapsedMs += dt
    this.stepElapsedMs += dt

    switch (this.displayMode) {
      case 'phrase':
        return this.tickPhrase()
      case 'karaoke':
        return this.tickKaraoke()
      case 'scroll':
        return this.tickScroll(dt)
      case 'bullet':
        return 'none'
    }
  }

  private tickPhrase(): TickChange {
    if (this.stepElapsedMs >= this.stepDurationMs) {
      if (this.advancePhrase()) {
        this.stepElapsedMs = 0
        this.stepDurationMs = this.computeStepDuration()
        return 'discrete'
      }
      this.status = 'completed'
      return 'discrete'
    }
    return 'continuous'
  }

  private tickKaraoke(): TickChange {
    if (this.stepElapsedMs >= this.stepDurationMs) {
      if (this.advanceKaraoke()) {
        this.stepElapsedMs = 0
        this.stepDurationMs = this.computeStepDuration()
        return 'discrete'
      }
      this.status = 'completed'
      return 'discrete'
    }
    return 'continuous'
  }

  private tickScroll(dt: number): TickChange {
    // 尚未量測捲動容器時不推進、也不完成。
    //
    // 為什麼需要這道防線:藥丸(收合)與貼鏡形態沒有捲動容器,量測管線拿不到
    // scrollHeight,opts 裡的 totalH/wrapH 一直是 undefined,而 maxScroll() 對
    // 未量測的退化值是 40px(只看 SCROLL_TAIL_PADDING_PX)。
    // 使用者視角試用發現的實際症狀:收合成藥丸後在主視窗換一份講稿,藥丸的狀態點
    // 600ms 就從「播放中」跳成「已播畢」,進度細線只閃一下就永遠消失;接著把藥丸
    // 展開,講稿仍停在頂端、狀態仍是 completed —— 提詞機看起來完全壞掉,而畫面上
    // 沒有任何錯誤訊息告訴使用者發生什麼事。
    //
    // 展開後會重新量測(measureKey 帶上形態,見 useTeleprompterEngine),那時再從
    // 頭捲;收合期間時鐘照常累計(elapsedMs 在 tick() 就加了),不是整段靜止。
    if (this.opts.totalH === undefined || this.opts.wrapH === undefined) return 'continuous'

    const maxScroll = this.maxScroll()
    const next = this.scrollPos + (this.opts.scrollSpeed * dt) / 1000
    if (next >= maxScroll) {
      this.scrollPos = maxScroll
      this.status = 'completed'
      return 'discrete'
    }
    this.scrollPos = next
    return 'continuous'
  }

  // ── 推進原語 ──

  /** 前進到下一短語/下一句;回傳 false 表示已到終點 */
  private advancePhrase(): boolean {
    if (this.model.phrases.length === 0) return false

    const sentencePhrases = this.model.phrases[this.sentenceIndex] ?? []
    if (this.phraseIndex < sentencePhrases.length - 1) {
      this.phraseIndex++
      return true
    }

    if (this.sentenceIndex >= this.model.sentences.length - 1) return false

    this.sentenceIndex++
    this.phraseIndex = 0
    return true
  }

  private advanceKaraoke(): boolean {
    const wordChunks = this.model.karaokeWordChunks
    if (wordChunks.length === 0) return false

    const chunkIndex = Math.min(this.karaokeChunkIndex, wordChunks.length - 1)
    const words = wordChunks[chunkIndex] ?? []

    if (this.karaokeWordIndex < words.length - 1) {
      this.karaokeWordIndex++
      return true
    }
    if (chunkIndex < wordChunks.length - 1) {
      this.karaokeChunkIndex = chunkIndex + 1
      this.karaokeWordIndex = 0
      return true
    }
    return false
  }

  private resetPositions(): void {
    this.sentenceIndex = 0
    this.phraseIndex = 0
    this.karaokeChunkIndex = 0
    this.karaokeWordIndex = 0
    this.bulletIndex = 0
    this.scrollPos = 0
    this.elapsedMs = 0
    this.stepElapsedMs = 0
    this.stepDurationMs = this.computeStepDuration()
  }

  // ── 時長計算(v3 公式)──

  private clampRate(): number {
    return Math.max(0.3, Math.min(this.opts.rate || 1, 8))
  }

  private computeStepDuration(): number {
    switch (this.displayMode) {
      case 'phrase': {
        const sentencePhrases = this.model.phrases[this.sentenceIndex] ?? []
        const phrase = sentencePhrases[this.phraseIndex]
        const wordCount = phrase?.words.length || 3
        const base = ((wordCount / MAX_WPM) * 60 * 1000) / this.clampRate()
        const isLastPhraseInSentence = this.phraseIndex >= sentencePhrases.length - 1
        if (isLastPhraseInSentence) {
          const pauseMultiplier = 1.4 + this.clampRate() * 0.08
          return Math.max(MIN_PHRASE_MS, base * pauseMultiplier)
        }
        return Math.max(MIN_PHRASE_MS, base)
      }
      case 'karaoke':
        return KARAOKE_WORD_INTERVAL_MS / this.clampRate()
      case 'scroll':
        return 16.67 // 每幀連續推進
      case 'bullet':
        return Infinity
    }
  }

  private maxScroll(): number {
    const totalH = this.opts.totalH ?? 0
    const wrapH = this.opts.wrapH ?? 0
    return Math.max(0, totalH - wrapH + SCROLL_TAIL_PADDING_PX)
  }

  // ── 查詢 ──

  /**
   * scroll 模式的捲動範圍是否已知(容器量測過)。
   * 藥丸/貼鏡形態沒有捲動容器,所以這裡會是 false —— 呼叫端據此決定
   * 「現在能不能顯示一條有意義的進度」,而不是畫一條永遠 0% 的線。
   */
  get measured(): boolean {
    return this.opts.totalH !== undefined && this.opts.wrapH !== undefined
  }

  getState(): EngineState {
    return {
      status: this.status,
      sentenceIndex: this.sentenceIndex,
      phraseIndex: this.phraseIndex,
      karaokeChunkIndex: this.karaokeChunkIndex,
      karaokeWordIndex: this.karaokeWordIndex,
      bulletIndex: this.bulletIndex,
      scrollPos: this.scrollPos,
      elapsedMs: this.elapsedMs,
      stepDurationMs: this.stepDurationMs,
      stepElapsedMs: this.stepElapsedMs
    }
  }

  /** 估計剩餘時間(ms);bullet 模式為手動推進,回傳 null */
  getRemainingMs(): number | null {
    switch (this.displayMode) {
      case 'phrase': {
        let total = 0
        const rate = this.clampRate()
        for (let s = this.sentenceIndex; s < this.model.phrases.length; s++) {
          const sentencePhrases = this.model.phrases[s] ?? []
          const startP = s === this.sentenceIndex ? this.phraseIndex : 0
          for (let p = startP; p < sentencePhrases.length; p++) {
            const wordCount = sentencePhrases[p]?.words.length || 3
            const base = ((wordCount / MAX_WPM) * 60 * 1000) / rate
            const isLast = p >= sentencePhrases.length - 1
            total += Math.max(MIN_PHRASE_MS, isLast ? base * (1.4 + rate * 0.08) : base)
          }
        }
        return Math.max(0, total - this.stepElapsedMs)
      }
      case 'karaoke': {
        const interval = KARAOKE_WORD_INTERVAL_MS / this.clampRate()
        let words = 0
        const wordChunks = this.model.karaokeWordChunks
        for (let c = this.karaokeChunkIndex; c < wordChunks.length; c++) {
          words += (wordChunks[c] ?? []).length
        }
        words -= this.karaokeWordIndex
        return Math.max(0, words * interval - this.stepElapsedMs)
      }
      case 'scroll': {
        const remain = this.maxScroll() - this.scrollPos
        if (this.opts.scrollSpeed <= 0) return null
        return Math.max(0, (remain / this.opts.scrollSpeed) * 1000)
      }
      case 'bullet':
        return null
    }
  }

  get progress(): number {
    if (this.displayMode === 'scroll') {
      const max = this.maxScroll()
      return max > 0 ? Math.min(1, this.scrollPos / max) : 0
    }
    if (this.displayMode === 'phrase') {
      const totalSentences = this.model.sentences.length
      if (totalSentences === 0) return 0
      const perSentence = 1 / totalSentences
      const sentencePhrases = this.model.phrases[this.sentenceIndex] ?? []
      const phraseFrac =
        sentencePhrases.length > 0
          ? Math.min(1, (this.phraseIndex + 1) / sentencePhrases.length)
          : 1
      return Math.min(1, this.sentenceIndex * perSentence + phraseFrac * perSentence)
    }
    if (this.displayMode === 'karaoke') {
      const totalWords = this.model.karaokeWordChunks.reduce((a, c) => a + c.length, 0)
      if (totalWords === 0) return 0
      let done = 0
      for (let c = 0; c < this.karaokeChunkIndex; c++) done += (this.model.karaokeWordChunks[c] ?? []).length
      done += this.karaokeWordIndex + 1
      return Math.min(1, done / totalWords)
    }
    // bullet
    const max = Math.max(0, this.model.bullets.length - 1)
    return max > 0 ? Math.min(1, this.bulletIndex / max) : 0
  }
}
