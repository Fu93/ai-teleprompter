import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  CameraOff,
  Check,
  ChevronRight,
  Download,
  Eye,
  Loader2,
  Mic,
  Ruler,
  Square,
  Volume2
} from 'lucide-react'
import type { PersonalProfile } from '@shared/types'
import { useSettings } from '../lib/store'
import { describeError } from '../lib/describeError'
import { cn } from '../lib/utils'
import {
  CAMERA_FIRST_FRAME_TIMEOUT_MS,
  DEFAULT_HFOV_DEG,
  MAX_IPD_MM,
  MIN_IPD_MM,
  clampFontSize,
  clampIpdMm,
  countReadableChars,
  estimateDistanceCm,
  fontSizeFromDistance,
  isCameraDeliveringFrames,
  isPlausibleRate,
  speedFromRate,
  visualAngleDeg
} from '../lib/calibration'
import { Ema, detectIris, getFaceLandmarker } from '../lib/faceLandmarker'

import { WhisperClient, type WhisperModelKey } from '../lib/audio/whisperClient'
import { toast } from '../lib/toast'
import { encodeWav } from '../lib/audio/wav'
import { registerAuditControl } from '../lib/auditBridge'
import { useEscape } from '../lib/useEscape'

const CALIBRATION_PASSAGE =
  '大家好，很高興今天有機會在這裡分享。接下來我想談三個重點，第一是我們目前的進度，第二是過程中遇到的挑戰，第三是接下來的計畫。這段文字是用來測量你的自然說話速度，請用平常講話的節奏把它完整唸完，不用刻意加快或放慢。'

/**
 * 取消一個「計時器持有在 ref 裡」的逾時。
 *
 * 為什麼是**模組層級**而不是元件內的一個函式或 useCallback:
 * `react-hooks/exhaustive-deps` 會把元件內宣告的函式視為「只有當它的整條
 * 呼叫鏈都是穩定的時候才算穩定」。原本 stopCamera 與 loop 都只呼叫彼此與
 * setState/ref,所以它們被判定穩定、不進依賴列;一旦它們開始呼叫一個**元件內**
 * 宣告的新函式,那條鏈就不再可證明穩定,於是 exhaustive-deps 會要求把
 * stopCamera / loop 放進 `[]` 的依賴列 —— 而那會讓相機在每次 render 都關掉。
 *
 * 把這個函式放在模組層級就不會進入那條鏈的「穩定性」計算,也不需要任何
 * 依賴(它只操作傳進來的 ref)。這不是為了躲 lint:那個 warning 一旦接受,
 * 真正的後果是相機被反覆關掉。
 */
function clearTimerRef(ref: { current: ReturnType<typeof setTimeout> | null }): void {
  if (ref.current !== null) {
    clearTimeout(ref.current)
    ref.current = null
  }
}

type Step = 0 | 1 | 2

export default function Calibration({ onDone }: { onDone: () => void }): JSX.Element {
  const { settings, update } = useSettings()
  const [step, setStep] = useState<Step>(0)

  /**
   * 稽核用:直接指定步驟。
   *
   * 為什麼不能只靠腳本點「下一步」:step 0 的前進按鈕要有相機或手動距離才會渲染,
   * step 1 的前進按鈕要等麥克風量出語速 —— 稽核環境兩者都沒有。
   * 上一輪的腳本用文字 regex 找不到就靜默 no-op,於是 step1/step2 兩張截圖
   * 與原始頁面 sha256 完全相同,而報告看起來「全清」。
   */
  useEffect(() =>
    registerAuditControl('calibration.step', (arg) => {
      const v = Number(arg)
      if (v !== 0 && v !== 1 && v !== 2) return false
      setStep(v as Step)
      return true
    }), [])

  /**
   * 稽核用:強制進入 step 0 / step 1 裡「會改變版面」的狀態。
   *
   * `calibration.step` 只能換步驟,但步驟內的狀態從來沒被量過:
   *   - cameraError:沒有攝影機的使用者會看到的那行提示
   *   - modelProgress:首次使用時的下載進度條
   *   - rateResult:語速結果卡(含「數值少見,建議再測一次」分支)
   *
   * 這三個的觸發條件分別是 getUserMedia 失敗、Whisper 進度回呼、
   * 麥克風量測 —— headless 一個都走不到。沒量過的結果是:
   * 語速結果卡上那句「建議再測一次」從來沒有被任何規則掃到過。
   */
  useEffect(
    () =>
      registerAuditControl('calibration.branchState', (arg) => {
        const want = typeof arg === 'string' ? arg : 'camera-error'
        if (want === 'camera-error') {
          setCameraError('NotFoundError: Requested device not found')
          return true
        }
        if (want === 'model-progress') {
          setModelProgress(37)
          return true
        }
        if (want === 'rate-implausible') {
          setRateResult({ charsPerMin: 12, chars: 7, secs: 35 })
          return true
        }
        if (want === 'rate-plausible') {
          setRateResult({ charsPerMin: 268, chars: 224, secs: 50 })
          return true
        }
        return false
      }),
    []
  )

  // Step 1: IPD + 視距
  const [ipdMm, setIpdMm] = useState(63)
  /** 輸入中的草稿:null = 未在編輯(顯示已夾限的 ipdMm)。
   *  為什麼需要:原寫法 `Number(e.target.value) || 63` 會在清空的瞬間把欄位彈回 63,
   *  使用者永遠沒辦法「刪掉重打」;且 631 這種超出 min/max 的值會原樣進入距離估算
   *  (type=number 的 min/max 屬性擋不住鍵盤輸入)。輸入中不強迫值,blur 時才夾限提交。 */
  const [ipdDraft, setIpdDraft] = useState<string | null>(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [distanceCm, setDistanceCm] = useState<number | null>(null)
  const [stable, setStable] = useState(false)
  const [manualDistance, setManualDistance] = useState<number | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef(0)
  const emaRef = useRef(new Ema(0.12))
  const historyRef = useRef<number[]>([])
  /**
   * 每一次 startCamera 的世代編號。取消(或離頁)之後,晚到的 await 必須自己發現
   * 「我已經不是當前的這一代」—— 否則在 `await getFaceLandmarker()` 預熱期間按 Esc
   * 會留下一個永遠沒有 stream 的 rAF 迴圈(每秒 60 次 detectIris 掃一個空的 video),
   * 指示燈雖滅但 CPU 一路燒到離頁。與 Record/Practice 的 startAttemptRef 同一套。
   */
  const camAttemptRef = useRef(0)
  const confirmedDistanceRef = useRef<number | null>(null)

  // Step 2: 語速
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const [transcribing, setTranscribing] = useState(false)
  const [modelProgress, setModelProgress] = useState<number | null>(null)
  const readingAttemptRef = useRef(0)
  const [rateResult, setRateResult] = useState<{ charsPerMin: number; chars: number; secs: number } | null>(null)
  const [level, setLevel] = useState(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const recStartRef = useRef(0)
  const whisperRef = useRef<WhisperClient | null>(null)

  // Step 3: 套用
  const [fontSizeAdj, setFontSizeAdj] = useState(0)

  const modelKey = (settings?.stt.localModel ?? 'base') as WhisperModelKey

  useEffect(() => {
    return () => {
      readingAttemptRef.current += 1
      stopCamera()
      clearTimerRef(firstFrameTimerRef)
      stopAudioPipeline()
      // Whisper worker 帶著數百 MB 模型,離頁一併釋放(Cache API 快取仍在,重進免重新下載)
      whisperRef.current?.dispose()
      whisperRef.current = null
    }
    // (這裡原本有一行 eslint-disable-next-line react-hooks/exhaustive-deps。
    //  有了 lint 之後才發現它是多餘的:這個 effect 只讀 refs,而 refs 不進依賴列。
    //  留著它會讓人以為這裡有什麼沒交代清楚的依賴問題。)
  }, [])

  // ---------- Step 1: 攝影機 ----------
  /**
   * 「開了相機卻永遠等不到第一格」的逾時計時器。
   *
   * 為什麼需要:**不是每一種失敗都會讓 `getUserMedia` 丟錯。
   * 「驅動被別的程式占住、USB hub 掉電、驅動卡住」這三種會**成功**拿到
   * stream,然後永遠送不出第一格影像。沒有逾時的話使用者的體驗是:
   *
   *   按「開啟攝影機偵測」→ 預覽全黑 + 燈亮著 + 按鈕寫「等待距離穩定…」→
   *   永遠是那一句。
   *
   * 那比直接報錯還糟:報錯至少會告訴他「換手動輸入」,而這個畫面只告訴他
   * 「再等一下」—— 而他等不到。
   *
   * 逾時長度(CAMERA_FIRST_FRAME_TIMEOUT_MS)與「什麼算真的有影」
   * (isCameraDeliveringFrames)都在 lib/calibration.ts,因為那兩件事是這個
   * 計時器最該被驗的行為,而它們得能在沒有相機的機器上被測。
   */
  const firstFrameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const startCamera = useCallback(async (): Promise<void> => {
    clearTimerRef(firstFrameTimerRef)
    setCameraError(null)
    historyRef.current = []
    emaRef.current = new Ema(0.12)
    setDistanceCm(null)
    setStable(false)
    const attempt = ++camAttemptRef.current
    const isCurrent = (): boolean => attempt === camAttemptRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false
      })
      if (!isCurrent()) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        await video.play()
      } else {
        throw new Error('攝影機預覽尚未就緒，請再試一次')
      }
      if (!isCurrent()) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      setCameraOn(true)

      // 拿到 stream 不代表真的有影像會來。從這裡開始計時:逾時且還沒有
      // 任何一格,就當作「相機開得起來但不送影」—— 這是 getUserMedia 丟錯
      // 抓不到的那一類失敗。
      firstFrameTimerRef.current = setTimeout(() => {
        firstFrameTimerRef.current = null
        // 世代檢查:逾時期間使用者可能已經重按一次或離頁,那時這次的計時器
        // 不該再去拆掉別人剛建立的相機。
        if (!isCurrent()) return
        const v = videoRef.current
        if (v && isCameraDeliveringFrames(v)) return // 影來了,只是慢
        stopCamera()
        setCameraError('攝影機開啟了,但完全沒有畫面。可能被其他程式占用。')
      }, CAMERA_FIRST_FRAME_TIMEOUT_MS)

      await getFaceLandmarker() // 預熱模型
      // 預熱是最久的一段 await:使用者很可能就在這裡按 Esc 或直接切到下一步
      if (!isCurrent()) return
      loop(attempt)
    } catch (err) {
      clearTimerRef(firstFrameTimerRef)
      if (!isCurrent()) {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        if (videoRef.current) videoRef.current.srcObject = null
        return
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
      setCameraOn(false)
      setCameraError(describeError(err))
    }
    // (這裡原本有一行 eslint-disable-next-line react-hooks/exhaustive-deps。
    //  有了 lint 之後才發現它是多餘的:這個 effect 只讀 refs,而 refs 不進依賴列。
    //  留著它會讓人以為這裡有什麼沒交代清楚的依賴問題。)
  }, [])

  const stopCamera = (preserveMeasurement = false): void => {
    camAttemptRef.current += 1 // 讓所有在飛的 await 與 rAF 迴圈自我作廢
    clearTimerRef(firstFrameTimerRef) // 否則逾時會在相機已經關掉後才炸,然後報一個已經過時的錯
    cancelAnimationFrame(rafRef.current)
    if (videoRef.current) videoRef.current.srcObject = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (!preserveMeasurement) {
      historyRef.current = []
      emaRef.current = new Ema(0.12)
      setDistanceCm(null)
      setStable(false)
    }
    setCameraOn(false)
  }

  /**
   * 步驟切換的唯一入口。
   *
   * 為什麼不是各自 setStep:離開步驟 0 時必須關掉相機。原本兩顆「下一步」按鈕
   * (相機距離確認、手動距離繼續)都只呼叫 setStep(1),於是相機、rAF 迴圈與
   * 攝影機指示燈會一路亮到步驟 2 結束或離頁 —— 沒有人在步驟 1/2 看得到它,
   * 使用者只知道「鏡頭燈一直亮著」。
   */
  const cancelReading = (): void => {
    readingAttemptRef.current += 1
    stopAudioPipeline()
    void whisperRef.current?.dispose()
    whisperRef.current = null
    chunksRef.current = []
    setRecording(false)
    setTranscribing(false)
    setModelProgress(null)
  }

  const goToStep = (next: Step): void => {
    if (step === 0 && next !== 0) {
      confirmedDistanceRef.current = manualDistance ?? (stable ? distanceCm : null)
      if (camAttemptRef.current > 0) stopCamera(true)
    }
    if (step === 1 && next !== 1) cancelReading()
    setStep(next)
  }

  /**
   * Esc 的行為必須跟著「這個步驟看得到什麼」:
   *   步驟 0 有相機 → 關相機(佔用裝置 + 亮燈的狀態要有鍵盤退出路徑)
   *   步驟 1 有錄音 → 停止朗讀(不然麥克風與指示燈留著)
   *   步驟 2 沒有佔用裝置 → 不攔 Esc
   * 原本寫成 `if (cameraOn) stopCamera(); else if (recording) stopReading()`,
   * 而相機在進入步驟 1 後仍是開的,所以在錄音中按 Esc 會去關一個「這一頁根本
   * 看不到的」相機,錄音照跑、畫面毫無變化 —— 使用者只會覺得 Esc 壞了。
   */
  useEscape(() => {
    if (step === 0) {
      if (cameraOn) stopCamera()
    } else if (step === 1 && recording) {
      void stopReading()
    }
  }, step === 0 ? cameraOn : step === 1 && recording)

  const loop = (attempt: number): void => {
    let lastUiUpdate = 0
    const tick = (): void => {
      if (attempt !== camAttemptRef.current) return
      rafRef.current = requestAnimationFrame(tick)
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) return
      // 第一格真的到了 → 逾時沒有存在的理由了,收回它。
      // 放在這裡而不是「play() 之後」:play() 回傳只代表開始請求播放,
      // readyState >= 2 才代表真的有影(frame 2 = 有當前影格)。
      if (firstFrameTimerRef.current !== null && isCameraDeliveringFrames(video)) {
        clearTimerRef(firstFrameTimerRef)
      }
      const landmarkerReady = getFaceLandmarker()
      void landmarkerReady.then((lm) => {
        const det = detectIris(lm, video)
        const ctx = canvas.getContext('2d')
        if (ctx) {
          canvas.width = det?.frameWidth ?? video.videoWidth
          canvas.height = det?.frameHeight ?? video.videoHeight
          ctx.clearRect(0, 0, canvas.width, canvas.height)
        }
        if (!det || !ctx) {
          if (!det) {
            historyRef.current = []
            setStable(false)
          }
          return
        }
        // 標記（顯示有鏡像：x 翻轉）
        const w = det.frameWidth
        ctx.fillStyle = '#8f8cfa'
        for (const p of [det.left, det.right]) {
          ctx.beginPath()
          ctx.arc(w - p.x, p.y, Math.max(4, w * 0.012), 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.strokeStyle = '#2dd4a7'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(w - det.left.x, det.left.y)
        ctx.lineTo(w - det.right.x, det.right.y)
        ctx.stroke()

        // 距離估計（EMA + 穩定度）
        const d = estimateDistanceCm({
          normalizedIpd: det.normalizedIpd,
          frameWidthPx: det.frameWidth,
          ipdMm: ipdRef.current,
          hfovDeg: DEFAULT_HFOV_DEG
        })
        const smoothed = emaRef.current.push(d)
        const now = performance.now()
        if (now - lastUiUpdate > 200) {
          lastUiUpdate = now
          setDistanceCm(smoothed)
          const hist = historyRef.current
          hist.push(smoothed)
          if (hist.length > 25) hist.shift()
          const stableNow =
            hist.length >= 20 && Math.max(...hist) - Math.min(...hist) < 3 && smoothed > 20 && smoothed < 130
          setStable(stableNow)
        }
      })
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  const ipdRef = useRef(63)
  ipdRef.current = ipdMm

  const effectiveDistance = manualDistance ?? (stable ? distanceCm : null)

  // ---------- Step 2: 語速 ----------
  const startAudioPipeline = async (attempt: number): Promise<void> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
    })
    if (attempt !== readingAttemptRef.current) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    micStreamRef.current = stream
    const ctx = new AudioContext({ sampleRate: 16000 })
    audioCtxRef.current = ctx
    let processor: ScriptProcessorNode | null = null
    try {
      await ctx.resume()
      if (attempt !== readingAttemptRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        await ctx.close().catch(() => undefined)
        if (audioCtxRef.current === ctx) audioCtxRef.current = null
        if (micStreamRef.current === stream) micStreamRef.current = null
        return
      }
      const source = ctx.createMediaStreamSource(stream)
      processor = ctx.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (e) => {
        const buf = e.inputBuffer.getChannelData(0)
        chunksRef.current.push(buf.slice())
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 6))
      }
      source.connect(processor)
      processor.connect(ctx.destination)
      processorRef.current = processor
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      processor?.disconnect()
      if (processorRef.current === processor) processorRef.current = null
      await ctx.close().catch(() => undefined)
      if (audioCtxRef.current === ctx) audioCtxRef.current = null
      if (micStreamRef.current === stream) micStreamRef.current = null
      throw err
    }
  }

  const stopAudioPipeline = (): void => {
    processorRef.current?.disconnect()
    void audioCtxRef.current?.close()
    processorRef.current = null
    audioCtxRef.current = null
    // 麥克風 track 也要收:「唸完了」之後指示燈持續亮著就是這漏的
    // (與 Record/Practice 的同族修法一致)
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    setLevel(0)
  }

  const startReading = async (): Promise<void> => {
    // 雲端引擎未設定就 fail-fast:原本要等使用者唸完整段、錄音結束後逐段失敗才知道
    // (與 Record/Practice 同一修法)
    if (settings?.stt.engine === 'cloud' && (!settings.stt.cloud.baseUrl || !settings.stt.cloud.model)) {
      toast.error('請先在設定頁填入雲端語音 API 的 Base URL 與模型')
      return
    }
    // 進場先置位:按鈕 disabled={transcribing} 由此關閉模型載入/麥克風的連點競態窗
    // (原本只在「本地模型需要載入」分支才置位,雲端/已載入路徑整段 await 期間可再按)
    const attempt = ++readingAttemptRef.current
    setTranscribing(true)
    try {
      if (!whisperRef.current) whisperRef.current = new WhisperClient()
      const client = whisperRef.current
      client.onProgress = (p) => {
        if (attempt === readingAttemptRef.current && p.status === 'progress') {
          setModelProgress(p.progress ?? 0)
        }
      }
      if (settings?.stt.engine === 'local') {
        if (!client.isLoaded()) {
          setModelProgress(0)
          await client.load(modelKey)
        }
      }
      if (attempt !== readingAttemptRef.current) return
      chunksRef.current = []
      recStartRef.current = Date.now()
      setRecSecs(0)
      await startAudioPipeline(attempt)
      if (attempt === readingAttemptRef.current && micStreamRef.current) setRecording(true)
    } catch (err) {
      if (attempt === readingAttemptRef.current) {
        stopAudioPipeline()
        chunksRef.current = []
        setRecording(false)
        toast.error(describeError(err))
      }
    } finally {
      if (attempt === readingAttemptRef.current) setTranscribing(false)
    }
  }

  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setRecSecs((Date.now() - recStartRef.current) / 1000), 300)
    return () => clearInterval(t)
  }, [recording])

  const stopReading = async (): Promise<void> => {
    if (transcribing || !recording) return
    const attempt = readingAttemptRef.current
    stopAudioPipeline()
    setRecording(false)
    setTranscribing(true)
    try {
      const secs = (Date.now() - recStartRef.current) / 1000
      const total = chunksRef.current.reduce((a, b) => a + b.length, 0)
      if (secs < 5 || total === 0) throw new Error('朗讀時間太短，請至少唸 5 秒')
      const audio = new Float32Array(total)
      let off = 0
      for (const c of chunksRef.current) {
        audio.set(c, off)
        off += c.length
      }
      chunksRef.current = []

      let transcript = ''
      if (settings && settings.stt.engine === 'local') {
        transcript = await whisperRef.current!.transcribe(audio, settings.stt.language)
      } else if (settings) {
        const { baseUrl, apiKey, model } = settings.stt.cloud
        if (!baseUrl || !model) throw new Error('請先在設定頁設定雲端語音 API')
        const res = await window.api.cloudTranscribe({
          baseUrl,
          apiKey,
          model,
          audio: encodeWav(audio, 16000),
          language: settings.stt.language
        })
        if (!res.ok) throw new Error(res.error ?? '辨識失敗')
        transcript = res.text ?? ''
      }
      if (attempt !== readingAttemptRef.current) return
      const chars = countReadableChars(transcript)
      const cpm = Math.round((chars / secs) * 60)
      if (chars < 20) throw new Error(`只聽到 ${chars} 個字，請確認麥克風與音量後再試一次`)
      setRateResult({ charsPerMin: cpm, chars, secs: Math.round(secs) })
    } catch (err) {
      if (attempt === readingAttemptRef.current) {
        // 雲端引擎的失敗多半是連不上/金鑰;本地引擎的失敗多半是模型或音量,
        // 兩種要給的下一步完全不同。
        toast.error(
          describeError(err, settings?.stt.engine === 'cloud' ? { provider: 'cloud-api' } : undefined)
        )
      }
    } finally {
      if (attempt === readingAttemptRef.current) {
        setTranscribing(false)
        setModelProgress(null)
      }
    }
  }

  // ---------- Step 3: 套用 ----------
  const baseDistance = effectiveDistance ?? confirmedDistanceRef.current ?? distanceCm ?? 60
  const baseFontSize = clampFontSize(fontSizeFromDistance(baseDistance) + fontSizeAdj)
  const cpm = rateResult?.charsPerMin ?? settings?.personal.profile?.charsPerMin ?? 240
  const derivedSpeed = speedFromRate(cpm, baseFontSize)

  const finish = async (): Promise<void> => {
    if (!settings) return
    const profile: PersonalProfile = {
      calibratedAt: Date.now(),
      ipdMm,
      viewingDistanceCm: Math.round(baseDistance),
      hfovDeg: manualDistance == null ? DEFAULT_HFOV_DEG : 0, // 手動距離時不依賴 FOV 假設
      charsPerMin: cpm,
      sampleSeconds: rateResult?.secs ?? 0,
      sampleChars: rateResult?.chars ?? 0,
      derivedFontSize: baseFontSize,
      derivedSpeed
    }
    try {
      await update({
        personal: { profile },
        overlay: { fontSize: baseFontSize, speed: derivedSpeed }
      })
    } catch (err) {
      // 寫入失敗(磁碟滿等)要有聲:留在原頁讓使用者重試,而不是靜默留在 step 2
      toast.error(`個人化設定儲存失敗。${describeError(err)}`)
      return
    }
    onDone()
  }

  const steps = ['眼距校準', '語速量測', '套用個人化']

  return (
    <div className="mx-auto max-w-2xl px-8 py-8">
      <h1 className="mb-1 text-xl font-bold">個人化校準</h1>
      <p className="mb-6 text-xs text-ink-400">
        兩個小測驗量出你的眼距與語速，自動產出最適合你的提詞字級與滾動速度。
      </p>

      {/* 步驟指示 */}
      <div className="mb-6 flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s} className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium',
                i < step
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : i === step
                    ? 'bg-accent-500 text-white'
                    : 'bg-ink-800 text-ink-400'
              )}
            >
              {i < step ? <Check size={13} /> : i + 1}
            </div>
            <span className={cn('text-xs', i === step ? 'text-ink-100' : 'text-ink-400')}>{s}</span>
            {i < steps.length - 1 && <div className="h-px flex-1 bg-ink-800" />}
          </div>
        ))}
      </div>

      {/* ============ Step 0: 眼距 ============ */}
      {step === 0 && (
        <div className="card space-y-4 p-6">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Eye size={15} className="text-accent-400" /> 你的瞳距（IPD）
          </div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              aria-label="瞳距(IPD),單位毫米"
              min={MIN_IPD_MM}
              max={MAX_IPD_MM}
              value={ipdDraft ?? String(ipdMm)}
              onChange={(e) => setIpdDraft(e.target.value)}
              onKeyDown={(e) => {
                // type=number 按 Enter 不會 blur;不 blur 草稿就不會提交,
                // 距離估算與 step 3 存檔用的仍是舊 ipdMm,畫面卻顯示新草稿。
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              onBlur={() => {
                if (ipdDraft == null) return
                setIpdMm(clampIpdMm(Number(ipdDraft)))
                setIpdDraft(null)
              }}
              className="input w-24"
            />
            <span className="text-xs text-ink-400">mm（成人平均 63；眼鏡行或鏡子量測最準）</span>
          </div>

          <div className="rounded-xl border border-ink-800 bg-ink-950/60 p-3">
            <div className="relative mx-auto aspect-4/3 w-full max-w-sm overflow-hidden rounded-lg bg-black">
              <video
                ref={videoRef}
                muted
                playsInline
                className="h-full w-full scale-x-[-1] object-cover"
              />
              <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
              {!cameraOn && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
                  <CameraOff size={22} className="text-ink-400" />
                  <div className="text-xs text-ink-400">開啟攝影機，面向鏡頭保持自然坐姿</div>
                </div>
              )}
              {cameraOn && stable && (
                <div className="absolute left-2 top-2 rounded-md bg-emerald-500/20 px-2 py-1 text-[11px] text-emerald-300">
                  距離穩定：{distanceCm?.toFixed(0)} cm
                </div>
              )}
              {cameraOn && !stable && distanceCm != null && (
                <div className="absolute left-2 top-2 rounded-md bg-ink-800/80 px-2 py-1 text-[11px] text-ink-300">
                  量測中… {distanceCm.toFixed(0)} cm（保持不動）
                </div>
              )}
            </div>
            <div className="mt-3 flex justify-center gap-2">
              {!cameraOn ? (
                <button className="btn-primary text-xs" onClick={startCamera}>
                  <Camera size={13} /> 開啟攝影機偵測
                </button>
              ) : (
                <button
                  className="btn-primary text-xs"
                  disabled={!stable}
                  onClick={() => goToStep(1)}
                >
                  {stable ? (
                    <>
                      <Check size={13} /> 距離 {distanceCm?.toFixed(0)} cm，確認
                    </>
                  ) : (
                    '等待距離穩定…'
                  )}
                </button>
              )}
            </div>
          </div>

          {cameraError && (
            <div className="text-xs text-amber-450">
              攝影機不可用（{cameraError}）。可改用下方手動輸入。
            </div>
          )}

          <div className="border-t border-ink-800 pt-4">
            <div className="label">沒有攝影機？直接填你平常的觀看距離</div>
            <div className="flex items-center gap-2">
              <input
                aria-label="沒有攝影機？直接填你平常的觀看距離" type="number"
                min={25}
                max={150}
                placeholder="例如 60"
                value={manualDistance ?? ''}
                onChange={(e) => setManualDistance(Number(e.target.value) || null)}
                className="input w-28"
              />
              <span className="text-xs text-ink-400">cm</span>
              <button className="btn-outline ml-auto whitespace-nowrap text-xs" disabled={manualDistance == null} onClick={() => goToStep(1)}>
                <Ruler size={13} /> 用手動距離繼續
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Step 1: 語速 ============ */}
      {step === 1 && (
        <div className="card space-y-4 p-6">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Volume2 size={15} className="text-accent-400" /> 用自然語速朗讀下面這段文字
          </div>
          <div className="rounded-xl bg-ink-850 p-5 text-lg leading-loose">{CALIBRATION_PASSAGE}</div>

          {recording && (
            <div className="flex items-center gap-3 text-sm text-rose-450">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-450" />
              錄音中 {recSecs.toFixed(0)} 秒
              <div className="h-1.5 w-28 overflow-hidden rounded-full bg-ink-800">
                <div className="h-full bg-rose-450 transition-[width] duration-100" style={{ width: `${level * 100}%` }} />
              </div>
            </div>
          )}
          {modelProgress != null && (
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-xs text-ink-300">
                <Download size={12} /> 下載語音模型 {modelProgress.toFixed(0)}%（只需一次）
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
                <div className="h-full bg-accent-500 transition-[width]" style={{ width: `${modelProgress}%` }} />
              </div>
            </div>
          )}
          {transcribing && modelProgress == null && (
            <div className="flex items-center gap-2 text-xs text-ink-300">
              <Loader2 size={13} className="animate-spin" /> 辨識中…
            </div>
          )}
          {rateResult && (
            <div
              className={cn(
                'rounded-lg border px-4 py-3 text-sm',
                isPlausibleRate(rateResult.charsPerMin)
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-450/30 bg-amber-450/10 text-amber-450'
              )}
            >
              你的語速：<b>{rateResult.charsPerMin} 字/分</b>
              <span className="ml-2 text-xs text-ink-400">
                （{rateResult.secs} 秒 · {rateResult.chars} 字）
                {!isPlausibleRate(rateResult.charsPerMin) && ' — 數值少見，建議再測一次'}
              </span>
            </div>
          )}

          <div className="flex gap-2">
            {!recording ? (
              <button className="btn-primary flex-1" onClick={startReading} disabled={transcribing}>
                <Mic size={14} /> {rateResult ? '再測一次' : '開始朗讀'}
              </button>
            ) : (
              <button className="btn-primary flex-1" onClick={stopReading}>
                <Square size={14} /> 唸完了
              </button>
            )}
            {rateResult == null ? (
              // 沒有麥克風(或權限被拒)的人拿不到量測,唯一的路被 disabled 堵死
              // 就永遠卡在這一步;已校準過、只想重校眼距的人同樣被逼著重新朗讀。
              // finish() 本來就有 cpm 備援(先前校準值或預設 240),所以這裡直接放行。
              <button className="btn-outline text-xs" onClick={() => goToStep(2)}>
                跳過語速量測 <ChevronRight size={13} />
              </button>
            ) : (
              <button className="btn-outline text-xs" onClick={() => goToStep(2)}>
                下一步 <ChevronRight size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ============ Step 2: 套用 ============ */}
      {step === 2 && (
        <div className="card space-y-5 p-6">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Check size={15} className="text-emerald-400" /> 個人化參數預覽
          </div>

          {/* 縮小版提詞預覽 */}
          <div className="overflow-hidden rounded-xl border border-white/10" style={{ background: 'rgba(9,11,18,0.95)' }}>
            <div className="border-b border-white/10 px-4 py-2 text-[11px] text-ink-400">
              浮層預覽 · 視距 {baseDistance.toFixed(0)}cm · 視角 {visualAngleDeg(baseDistance, baseFontSize).toFixed(2)}° ·{' '}
              {cpm} 字/分
            </div>
            <div className="px-5 py-4">
              <div
                // 量測鉤子:字級微調的探針要讀的是**這一段預覽文字的** computed font-size。
                // 沒有這個屬性時,探針只能從「文字包含這句話的元素」裡挑 ——
                // 而最外層的容器也包含它,於是量到的是繼承來的 16px,
                // 兩顆真的有效的按鈕被記成「按了沒效果」。
                data-effect-id="font-preview"
                className="font-medium leading-relaxed text-white"
                style={{ fontSize: Math.min(28, baseFontSize * 0.6), lineHeight: 1.5 }}
              >
                各位好，今天我想跟大家分享三個重點，第一是我們的進度。
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-ink-850 p-4">
              <div className="text-[11px] text-ink-400">自動字級</div>
              <div className="mt-1 text-2xl font-bold text-accent-300">{baseFontSize}px</div>
              <div className="mt-1 text-[11px] text-ink-400">由 {baseDistance.toFixed(0)}cm 視距推導</div>
            </div>
            <div className="rounded-lg bg-ink-850 p-4">
              <div className="text-[11px] text-ink-400">自動滾動速度</div>
              <div className="mt-1 text-2xl font-bold text-accent-300">{derivedSpeed}px/s</div>
              <div className="mt-1 text-[11px] text-ink-400">由 {cpm} 字/分 語速推導</div>
            </div>
          </div>

          <div>
            <div className="label">字級微調（視覺感受優先）</div>
            <div className="flex items-center gap-3">
              <button className="btn-outline h-8 w-10" onClick={() => setFontSizeAdj((a) => a - 2)}>
                −
              </button>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800">
                <div
                  className="h-full bg-accent-500"
                  style={{ width: `${((baseFontSize - 16) / (72 - 16)) * 100}%` }}
                />
              </div>
              <button className="btn-outline h-8 w-10" onClick={() => setFontSizeAdj((a) => a + 2)}>
                +
              </button>
            </div>
          </div>

          <button className="btn-primary w-full" onClick={finish}>
            <Check size={14} /> 套用個人化設定
          </button>
          <div className="text-center text-[11px] text-ink-400">
            之後仍可在浮層工具列隨時微調；重新校準會覆蓋。
          </div>
        </div>
      )}

      {step > 0 && (
        <button className="btn-ghost mt-4 text-xs" onClick={() => goToStep((step - 1) as Step)}>
          回上一步
        </button>
      )}
    </div>
  )
}
