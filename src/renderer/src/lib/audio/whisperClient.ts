// WhisperClient：以 Promise + 事件包裝 whisper worker
export type WhisperDevice = 'webgpu' | 'wasm'

export interface WhisperDownloadProgress {
  status: string
  file?: string
  progress?: number // 0-100
  loaded?: number
  total?: number
}

export const WHISPER_MODELS = {
  tiny: { id: 'onnx-community/whisper-tiny', label: 'tiny（最快，~75MB）' },
  base: { id: 'onnx-community/whisper-base', label: 'base（均衡，~145MB）' },
  small: { id: 'onnx-community/whisper-small', label: 'small（最準，~500MB）' }
} as const

export type WhisperModelKey = keyof typeof WHISPER_MODELS

type OutMsg =
  | { type: 'ready'; device: WhisperDevice }
  | { type: 'progress'; payload: WhisperDownloadProgress }
  | { type: 'status'; message: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number | null; message: string }

export class WhisperClient {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()
  private loadPromise: Promise<WhisperDevice> | null = null
  private loadedKey = ''
  private chain: Promise<unknown> = Promise.resolve()
  /** dispose 時觸發在飛 load() 的 reject(executor 外無法直接 reject 已建立的 promise) */
  private rejectActiveLoad: ((e: Error) => void) | null = null
  /**
   * 目前這輪 load() 的世代序號。worker 端也用同一個概念(見 whisper.worker.ts)。
   *
   * 為什麼需要:換模型時舊的 onMsg 仍在 worker 上,晚到的 `ready` 會讓已被
   * 換掉的那輪 resolve —— 而它的訊息描述的是**舊模型**。沒有世代檢查時,
   * 「設成 small、實際仍用 base」會發生,而且沒有任何錯誤訊息。
   */
  private loadGeneration = 0

  onProgress: ((p: WhisperDownloadProgress) => void) | null = null
  onStatus: ((message: string) => void) | null = null
  onReady: ((device: WhisperDevice) => void) | null = null

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent<OutMsg>) => this.handle(e.data))
    worker.addEventListener('error', (e) => {
      if (e instanceof ErrorEvent) e.preventDefault()
      // terminate() 後舊 worker 仍可能送出排隊中的 error event；不可讓它
      // 清掉新 worker 的 pending jobs 或 reject 新一輪模型載入。
      if (this.worker !== worker) return
      const err = new Error(e.message || 'Whisper worker 錯誤')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      // worker error 不會發出 { type: 'error' } message;若不 reject 在飛的
      // load(),呼叫端會永久卡在 await,且後續 load() 還可能重用已壞的 worker。
      this.rejectActiveLoad?.(err)
      this.rejectActiveLoad = null
      this.loadPromise = null
      this.loadedKey = ''
      if (this.worker === worker) {
        this.worker = null
        worker.terminate()
      }
      this.onStatus?.(err.message)
    })
    this.worker = worker
    return worker
  }

  private handle(msg: OutMsg): void {
    switch (msg.type) {
      case 'progress':
        this.onProgress?.(msg.payload)
        break
      case 'status':
        this.onStatus?.(msg.message)
        break
      case 'ready':
        this.onReady?.(msg.device)
        break
      case 'result': {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        p?.resolve(msg.text)
        break
      }
      case 'error': {
        const err = new Error(msg.message)
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          p.reject(err)
        } else {
          // 全域錯誤(載入失敗等)不屬於任何一筆轉錄
          this.onStatus?.(msg.message)
        }
        break
      }
    }
  }

  /** 載入模型（重複呼叫同一模型不會重載） */
  async load(modelKey: WhisperModelKey, preferGpu = true): Promise<WhisperDevice> {
    const modelId = WHISPER_MODELS[modelKey].id
    const key = `${modelKey}:${preferGpu}`
    if (this.loadPromise && this.loadedKey === key) return this.loadPromise
    const worker = this.ensureWorker()

    // **換模型必須先讓舊的那輪落地,再覆寫指標。**
    //
    // 原本的順序是先覆寫 `this.loadPromise` 與 `this.rejectActiveLoad`,於是舊輪的
    // rejecter 從此不可達:第一個 promise 既不 resolve 也不 reject,`await
    // client.load()` 的呼叫端(開始聆聽 / 語音跟讀 / 個人化校準)會**永遠卡在
    // 那一行** —— 按鈕停住、沒有錯誤訊息,與 dispose 那條已修的缺陷同一個形狀,
    // 但成因不同,所以 dispose 的測試抓不到它。
    this.abandonActiveLoad(
      new Error(`語音模型切換中:${this.loadedKey || '(尚未載入)'} → ${key},先前的載入已中止`)
    )

    const generation = ++this.loadGeneration
    this.loadedKey = key
    this.loadPromise = new Promise<WhisperDevice>((resolve, reject) => {
      // dispose() 與換模型都經此 rejecter 讓在飛的 load() 落地
      const settleFailure = (e: Error): void => {
        worker.removeEventListener('message', onMsg)
        // 只在「仍是本世代」時清指標,否則會把**新**那輪的狀態清掉
        if (this.loadGeneration === generation) {
          this.rejectActiveLoad = null
          this.loadPromise = null
          this.loadedKey = ''
        }
        reject(e)
      }
      this.rejectActiveLoad = settleFailure
      const onMsg = (e: MessageEvent<OutMsg>): void => {
        // 晚到的舊世代訊息:已被換掉,丟棄。否則它會讓已 reject 的 promise
        // 再次 resolve(無作用),更糟的是 worker 端會以舊模型為準。
        if (this.loadGeneration !== generation) return
        if (e.data.type === 'ready') {
          worker.removeEventListener('message', onMsg)
          this.rejectActiveLoad = null
          resolve(e.data.device)
        } else if (e.data.type === 'error' && e.data.id == null) {
          settleFailure(new Error(e.data.message))
        }
      }
      worker.addEventListener('message', onMsg)
      worker.postMessage({ type: 'load', modelId, generation, device: preferGpu ? 'webgpu' : 'wasm' } satisfies {
        type: 'load'
        modelId: string
        generation: number
        device?: WhisperDevice
      })
    })
    return this.loadPromise
  }

  /**
   * 讓在飛的 load() 落地(轉成 rejected),而不是被下一次 load() 覆蓋成懸空。
   *
   * 與 dispose 共用同一條路徑:兩者的差別只在錯誤訊息 —— dispose 是使用者主動
   * 離開,換模型是使用者改了設定。兩者對呼叫端的意義相同:你等的這次載入
   * 不會發生了,請依錯誤訊息處理。
   */
  private abandonActiveLoad(err: Error): void {
    const reject = this.rejectActiveLoad
    if (!reject) return
    this.rejectActiveLoad = null
    reject(err)
  }

  transcribe(audio: Float32Array, language: string): Promise<string> {
    // 序列化：worker 上的 pipeline 不可重入，逐段排隊執行
    const run = this.chain.then(() => this.transcribeOnce(audio, language))
    this.chain = run.catch(() => undefined)
    return run
  }

  private transcribeOnce(audio: Float32Array, language: string): Promise<string> {
    if (!this.worker || !this.loadPromise) return Promise.reject(new Error('模型尚未載入'))
    const id = this.nextId++
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // 轉移 buffer 所有權以省記憶體
      this.worker!.postMessage({ type: 'transcribe', id, audio, language }, [audio.buffer])
    })
  }

  isLoaded(): boolean {
    // loadPromise 在 load 失敗時會被清成 null;worker 存在但 promise 沒了 = 載入中斷,視為未載入
    return this.loadPromise !== null && this.worker !== null
  }

  dispose(): void {
    // 先 reject 所有等待中的轉錄(離頁時 transcribe() 呼叫端還在 await;
    // 只 clear 不 reject 會讓那些 Promise 永遠懸掛,catch 不會跑到)
    const err = new Error('Whisper 已釋放(頁面離開或模型切換)')
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    // 在飛的 load() 同樣要落地:await client.load() 的呼叫端(開始聆聽/跟讀/校準)
    // 否則隨 dispose 永遠懸掛。世代也要推進 —— 讓 worker 晚到的訊息被丟棄。
    this.loadGeneration += 1
    this.abandonActiveLoad(err)
    this.loadPromise = null
    this.loadedKey = ''
    this.worker?.terminate()
    this.worker = null
  }
}
