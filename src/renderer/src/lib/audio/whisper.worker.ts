import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

// 模型一律從 HuggingFace Hub 下載並快取在瀏覽器 Cache API（同 origin 共享）
env.allowLocalModels = false

let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let currentKey = ''

type Device = 'webgpu' | 'wasm'

interface LoadMsg {
  type: 'load'
  modelId: string
  device?: Device
}
interface TranscribeMsg {
  type: 'transcribe'
  id: number
  audio: Float32Array
  language?: string
}
type InMsg = LoadMsg | TranscribeMsg

async function load(modelId: string, preferGpu: boolean): Promise<Device> {
  const key = `${modelId}::${preferGpu ? 'webgpu' : 'wasm'}`
  if (transcriber && currentKey === key) return preferGpu ? 'webgpu' : 'wasm'

  if (transcriber) {
    await transcriber.dispose()
    transcriber = null
    currentKey = ''
  }

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
      transcriber = await tryDevice('webgpu')
      currentKey = key
      return 'webgpu'
    } catch (err) {
      self.postMessage({
        type: 'status',
        message: `WebGPU 初始化失敗，改用 CPU（${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}）`
      })
    }
  }
  transcriber = await tryDevice('wasm')
  currentKey = `${modelId}::wasm`
  return 'wasm'
}

self.addEventListener('message', async (e: MessageEvent<InMsg>) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      const device = await load(msg.modelId, msg.device !== 'wasm')
      self.postMessage({ type: 'ready', device })
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
