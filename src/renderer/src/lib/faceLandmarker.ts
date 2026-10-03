// MediaPipe FaceLandmarker 封裝：本地 wasm + 本地模型，離線可用
// 用途：量測兩瞳孔（虹膜中心）的像素距離，供校準精靈推算觀看距離
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision'

// 虹膜中心 landmark index（478 點模型，含 refinement）
const LEFT_IRIS_CENTER = 468 // 受測者左眼
const RIGHT_IRIS_CENTER = 473

let landmarkerPromise: Promise<FaceLandmarker> | null = null

/**
 * mediapipe 資源的載入來源。
 *
 * dev:走 dev server 的 http(`/mediapipe/wasm`),fetch 對 http 沒有任何限制。
 * 打包:頁面以 file:// 載入,而 Chromium 拒絕 file: scheme 的 fetch —— 原本
 * 的相對路徑在安裝版直接失敗(dev 測得到、打包沒人驗過)。改由 main 端註冊的
 * privileged scheme 提供同一批本地檔案(app://bundle,見 src/main/appProtocol.ts),
 * 語意不變:本地資源、離線可用,只不過協定從 file 換成了能被 fetch 的 app。
 */
function localBase(): string {
  if (import.meta.env.DEV) {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/?$/, '/')
    return `${base}mediapipe`
  }
  return 'app://bundle/mediapipe'
}

function wasmBase(): string {
  return `${localBase()}/wasm`
}

function modelUrl(): string {
  return `${localBase()}/models/face_landmarker.task`
}

export async function getFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async (): Promise<FaceLandmarker> => {
      const fileset = await FilesetResolver.forVisionTasks(wasmBase())
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: modelUrl(),
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false
      })
    })()
    landmarkerPromise.catch(() => {
      landmarkerPromise = null // 允許重試
    })
  }
  return landmarkerPromise
}

export interface IrisDetection {
  /** 兩虹膜中心在影像寬度上的正規化距離 [0,1] */
  normalizedIpd: number
  /** 像素座標（供 UI 標記），座標已按影像實際解析度換算 */
  left: { x: number; y: number }
  right: { x: number; y: number }
  frameWidth: number
  frameHeight: number
}

/** 對 video 當前幀偵測；找不到臉回傳 null */
export function detectIris(landmarker: FaceLandmarker, video: HTMLVideoElement): IrisDetection | null {
  if (video.readyState < 2) return null
  const now = performance.now()
  const result = landmarker.detectForVideo(video, now)
  const faces = result.faceLandmarks ?? []
  if (faces.length === 0) return null
  const lm = faces[0]
  const a = lm[LEFT_IRIS_CENTER]
  const b = lm[RIGHT_IRIS_CENTER]
  if (!a || !b) return null
  const frameWidth = video.videoWidth
  const frameHeight = video.videoHeight
  const dx = (a.x - b.x) * frameWidth
  const dy = (a.y - b.y) * frameHeight
  const pixelIpd = Math.hypot(dx, dy)
  if (pixelIpd <= 0) return null
  return {
    normalizedIpd: pixelIpd / frameWidth,
    left: { x: a.x * frameWidth, y: a.y * frameHeight },
    right: { x: b.x * frameWidth, y: b.y * frameHeight },
    frameWidth,
    frameHeight
  }
}

/** 指數移動平均：讓距離讀值穩定不跳動 */
export class Ema {
  private value: number | null = null
  constructor(private readonly alpha: number) {}
  push(x: number): number {
    this.value = this.value == null ? x : this.alpha * x + (1 - this.alpha) * this.value
    return this.value
  }
  get(): number | null {
    return this.value
  }
}
