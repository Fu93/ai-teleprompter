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

  onProgress: ((p: WhisperDownloadProgress) => void) | null = null
  onStatus: ((message: string) => void) | null = null
  onReady: ((device: WhisperDevice) => void) | null = null

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent<OutMsg>) => this.handle(e.data))
    worker.addEventListener('error', (e) => {
      const err = new Error(e.message || 'Whisper worker 錯誤')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.loadPromise = null
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
    this.loadedKey = key
    this.loadPromise = new Promise<WhisperDevice>((resolve, reject) => {
      // dispose() 經此 rejecter 讓在飛的 load() 落地(否則 await 呼叫端永遠懸掛)
      this.rejectActiveLoad = (e) => {
        worker.removeEventListener('message', onMsg)
        reject(e)
      }
      const onMsg = (e: MessageEvent<OutMsg>): void => {
        if (e.data.type === 'ready') {
          worker.removeEventListener('message', onMsg)
          this.rejectActiveLoad = null
          resolve(e.data.device)
        } else if (e.data.type === 'error' && e.data.id == null) {
          worker.removeEventListener('message', onMsg)
          this.rejectActiveLoad = null
          this.loadPromise = null
          reject(new Error(e.data.message))
        }
      }
      worker.addEventListener('message', onMsg)
      worker.postMessage({ type: 'load', modelId, device: preferGpu ? 'webgpu' : 'wasm' } satisfies {
        type: 'load'
        modelId: string
        device?: WhisperDevice
      })
    })
    return this.loadPromise
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
    // 否則隨 dispose 永遠懸掛
    this.rejectActiveLoad?.(err)
    this.rejectActiveLoad = null
    this.loadPromise = null
    this.loadedKey = ''
    this.worker?.terminate()
    this.worker = null
  }
}
