// 能量 VAD + 音訊分段器：把 MediaStream 切成一段段語音（Float32 @ 16kHz）
// 不依賴第三方 VAD 模型，在 mic 與系統音訊 loopback 上都能用。

export interface AudioSegmentMetadata {
  /** 有聲 frame 數，不包含前置、尾端或段內靜音 */
  speechDurationSec: number
  /** 音訊 buffer 起點到第一個有聲 frame 的偏移 */
  leadingSilenceSec: number
  /** 最後一個有聲 frame 到音訊 buffer 終點的偏移 */
  trailingSilenceSec: number
}

export interface SegmenterOptions {
  onSegment: (audio: Float32Array, sampleRate: number, metadata: AudioSegmentMetadata) => void
  onLevel?: (rms: number) => void // 0~1，供 UI 顯示音量
  sampleRate?: number
  /** RMS 高於此視為語音（0~1） */
  threshold?: number
  /** 最短語音長度（ms），低於此丟棄 */
  minSpeechMs?: number
  /** 靜音多久後結束一段（ms） */
  minSilenceMs?: number
  /** 語音開始前回補（ms），避免吃掉第一個字 */
  prerollMs?: number
}

export class AudioSegmenter {
  private ctx: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null

  private readonly sampleRate: number
  private readonly threshold: number
  private readonly minSpeechSamples: number
  private readonly minSilenceSamples: number
  private readonly prerollSamples: number

  private inSpeech = false
  private current: Float32Array[] = []
  private currentLen = 0
  private speechSamples = 0
  private leadingSilenceSamples = 0
  private silenceRun = 0
  private preroll: Float32Array[] = []
  private prerollLen = 0
  private stopped = false

  private readonly onSegment: SegmenterOptions['onSegment']
  private readonly onLevel?: SegmenterOptions['onLevel']

  constructor(opts: SegmenterOptions) {
    this.sampleRate = opts.sampleRate ?? 16000
    this.threshold = opts.threshold ?? 0.011
    this.minSpeechSamples = Math.floor(((opts.minSpeechMs ?? 260) / 1000) * this.sampleRate)
    this.minSilenceSamples = Math.floor(((opts.minSilenceMs ?? 750) / 1000) * this.sampleRate)
    this.prerollSamples = Math.floor(((opts.prerollMs ?? 240) / 1000) * this.sampleRate)
    this.onSegment = opts.onSegment
    this.onLevel = opts.onLevel
  }

  async start(stream: MediaStream): Promise<void> {
    this.ctx = new AudioContext({ sampleRate: this.sampleRate })
    await this.ctx.resume()
    this.source = this.ctx.createMediaStreamSource(stream)
    // ScriptProcessor 雖被標記 deprecated，但在 Chromium 內穩定可用且免 worklet 檔案
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (e) => this.handleFrame(e.inputBuffer.getChannelData(0))
    this.source.connect(this.processor)
    this.processor.connect(this.ctx.destination) // 需連到 destination 才會驅動（靜音處理見下）
  }

  private handleFrame(frame: Float32Array): void {
    if (this.stopped) return
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / frame.length)
    this.onLevel?.(Math.min(1, rms * 6))

    const isSpeech = rms > this.threshold

    if (isSpeech) {
      if (!this.inSpeech) {
        this.inSpeech = true
        this.current = [...this.preroll]
        this.currentLen = this.prerollLen
        this.leadingSilenceSamples = this.prerollLen
        this.preroll = []
        this.prerollLen = 0
      }
      this.silenceRun = 0
      this.current.push(frame.slice())
      this.currentLen += frame.length
      this.speechSamples += frame.length
    } else if (this.inSpeech) {
      this.silenceRun += frame.length
      this.current.push(frame.slice())
      this.currentLen += frame.length
      if (this.silenceRun >= this.minSilenceSamples) {
        this.finishSegment()
      }
    } else {
      // 靜音中：維護有界 preroll 環。先累加長度再裁切；舊實作沒有更新
      // prerollLen，導致持續靜音時每個 AudioFrame 永久留在陣列並耗盡記憶體。
      this.preroll.push(frame.slice())
      this.prerollLen += frame.length
      while (this.prerollLen > this.prerollSamples && this.preroll.length > 0) {
        const first = this.preroll[0]
        const drop = Math.min(first.length, this.prerollLen - this.prerollSamples)
        if (drop >= first.length) {
          this.preroll.shift()
          this.prerollLen -= first.length
        } else {
          this.preroll[0] = first.subarray(drop)
          this.prerollLen -= drop
        }
      }
    }
  }

  private finishSegment(): void {
    this.inSpeech = false
    const trailingSilenceSamples = this.silenceRun
    this.silenceRun = 0
    const total = this.currentLen
    // 判斷最短語音只計高於 VAD 門檻的 samples；尾端靜音與 preroll 不能
    // 把短促噪音墊成「有效語音」。
    if (this.speechSamples >= this.minSpeechSamples && total > 0) {
      const merged = new Float32Array(total)
      let off = 0
      for (const chunk of this.current) {
        merged.set(chunk, off)
        off += chunk.length
      }
      this.onSegment(merged, this.sampleRate, {
        speechDurationSec: this.speechSamples / this.sampleRate,
        leadingSilenceSec: this.leadingSilenceSamples / this.sampleRate,
        trailingSilenceSec: trailingSilenceSamples / this.sampleRate
      })
    }
    this.current = []
    this.currentLen = 0
    this.speechSamples = 0
    this.leadingSilenceSamples = 0
  }

  /** 強制結束當前段（停止前呼叫） */
  flush(): void {
    if (this.inSpeech) this.finishSegment()
  }

  stop(flush = true): void {
    this.stopped = true
    if (flush) {
      this.flush()
    } else {
      // 離頁、重設或啟動失敗時放棄未完成片段，避免取消操作又送出轉錄。
      this.inSpeech = false
      this.current = []
      this.currentLen = 0
      this.speechSamples = 0
      this.leadingSilenceSamples = 0
      this.silenceRun = 0
      this.preroll = []
      this.prerollLen = 0
    }
    this.processor?.disconnect()
    this.source?.disconnect()
    void this.ctx?.close()
    this.processor = null
    this.source = null
    this.ctx = null
  }
}
