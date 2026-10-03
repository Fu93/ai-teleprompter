import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

// 模型一律從 HuggingFace Hub 下載並快取在瀏覽器 Cache API（同 origin 共享）
env.allowLocalModels = false

let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let currentKey = ''
/**
 * 最新一次 load 的世代序號(由 client 端帶進來)。
 *
 * 為什麼需要:message handler 是 async,而 load() 裡有真正的 await
 * (pipeline 下載 + dispose)。兩個 load 訊息進來時會**交錯** —— 實測:
 * small 先載完、base 後到,結果 worker 裡留下的是 base。
 *
 * 症狀是這個專案最難察覺的那一類:使用者設了 small、UI 也顯示切換成功,
 * 實際轉錄仍用 base,而且沒有任何錯誤訊息。所以這裡在落地的每一個點都檢查世代。
 */
let currentGeneration = 0

type Device = 'webgpu' | 'wasm'

interface LoadMsg {
  type: 'load'
  modelId: string
  /** 由 WhisperClient 指派;用來丟棄晚到的舊請求 */
  generation: number
  device?: Device
}
interface TranscribeMsg {
  type: 'transcribe'
  id: number
  audio: Float32Array
  language?: string
}
type InMsg = LoadMsg | TranscribeMsg

async function load(modelId: string, preferGpu: boolean, generation: number): Promise<Device | null> {
  const key = `${modelId}::${preferGpu ? 'webgpu' : 'wasm'}`
  if (transcriber && currentKey === key) return preferGpu ? 'webgpu' : 'wasm'

  if (transcriber) {
    await transcriber.dispose()
    transcriber = null
    currentKey = ''
  }

  // 在每個 await 之後都要重新確認自己仍是最新的一輪:dispose 與 pipeline()
  // 都是真的非同步點,交錯就發生在這裡。
  const stale = (): boolean => generation !== currentGeneration

  const tryDevice = async (device: Device): Promise<AutomaticSpeechRecognitionPipeline> =>
    pipeline('automatic-speech-recognition', modelId, {
      device,
      dtype:
        device === 'webgpu'
          ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
          : 'q8',
      progress_callback: (p: unknown) => self.postMessage({ type: 'progress', payload: p })
    })

  if (preferGpu) {
    try {
      const next = await tryDevice('webgpu')
      // 晚到的舊輪:丟棄剛載好的 pipeline(它會佔幾百 MB),並且**不碰**
      // transcriber / currentKey —— 那些屬於更新的一輪。
      if (stale()) {
        void next.dispose()
        return null
      }
      transcriber = next
      currentKey = key
      return 'webgpu'
    } catch (err) {
      // 這一輪已經過期,fallback 下去只會與新一輪爭 transcriber
      if (stale()) return null
      self.postMessage({
        type: 'status',
        message: `WebGPU 初始化失敗，改用 CPU（${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}）`
      })
    }
  }
  const next = await tryDevice('wasm')
  if (stale()) {
    void next.dispose()
    return null
  }
  transcriber = next
  currentKey = `${modelId}::wasm`
  return 'wasm'
}

self.addEventListener('message', async (e: MessageEvent<InMsg>) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      currentGeneration = msg.generation
      const device = await load(msg.modelId, msg.device !== 'wasm', msg.generation)
      // null = 這一輪已被更新的一輪取代。它**不該**發 ready:
      // client 端已經把舊輪 reject 掉了,發 ready 只會讓已終結的 promise 再動一次。
      if (device !== null) self.postMessage({ type: 'ready', device })
      return
    }
    if (msg.type === 'transcribe') {
      if (!transcriber) throw new Error('模型尚未載入')
      const out = await transcriber(msg.audio, {
        language: !msg.language || msg.language === 'auto' ? undefined : msg.language,
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5
      })
      const text = Array.isArray(out) ? out[0]?.text ?? '' : (out as { text: string }).text
      self.postMessage({ type: 'result', id: msg.id, text: text.trim() })
      return
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: 'id' in msg ? msg.id : null,
      message: err instanceof Error ? err.message : String(err)
    })
  }
})
