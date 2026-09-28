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
import { cn } from '../lib/utils'
import {
  DEFAULT_HFOV_DEG,
  clampFontSize,
  countReadableChars,
  estimateDistanceCm,
  fontSizeFromDistance,
  isPlausibleRate,
  speedFromRate,
  visualAngleDeg
} from '../lib/calibration'
import { Ema, detectIris, getFaceLandmarker } from '../lib/faceLandmarker'
import { AudioSegmenter } from '../lib/audio/segmenter'
import { WhisperClient, type WhisperModelKey } from '../lib/audio/whisperClient'
import { toast } from '../lib/toast'
import { encodeWav } from '../lib/audio/wav'

const CALIBRATION_PASSAGE =
  '大家好，很高興今天有機會在這裡分享。接下來我想談三個重點，第一是我們目前的進度，第二是過程中遇到的挑戰，第三是接下來的計畫。這段文字是用來測量你的自然說話速度，請用平常講話的節奏把它完整唸完，不用刻意加快或放慢。'

type Step = 0 | 1 | 2

export default function Calibration({ onDone }: { onDone: () => void }): JSX.Element {
  const { settings, update } = useSettings()
  const [step, setStep] = useState<Step>(0)

  // Step 1: IPD + 視距
  const [ipdMm, setIpdMm] = useState(63)
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

  // Step 2: 語速
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const [transcribing, setTranscribing] = useState(false)
  const [modelProgress, setModelProgress] = useState<number | null>(null)
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
      stopCamera()
      stopAudioPipeline()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- Step 1: 攝影機 ----------
  const startCamera = useCallback(async (): Promise<void> => {
    setCameraError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false
      })
      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        await video.play()
      }
      setCameraOn(true)
      await getFaceLandmarker() // 預熱模型
      loop()
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : String(err))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopCamera = (): void => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCameraOn(false)
  }

  const loop = (): void => {
    let lastUiUpdate = 0
    const tick = (): void => {
      rafRef.current = requestAnimationFrame(tick)
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) return
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
        const h = det.frameHeight
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
  const startAudioPipeline = async (): Promise<void> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
    })
    micStreamRef.current = stream
    const ctx = new AudioContext({ sampleRate: 16000 })
    await ctx.resume()
    audioCtxRef.current = ctx
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(4096, 1, 1)
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
    try {
      if (!whisperRef.current) whisperRef.current = new WhisperClient()
      const client = whisperRef.current
      client.onProgress = (p) => {
        if (p.status === 'progress') setModelProgress(p.progress ?? 0)
      }
      if (settings?.stt.engine === 'local') {
        if (!client.isLoaded()) {
          setTranscribing(true)
          setModelProgress(0)
          await client.load(modelKey)
        }
      }
      chunksRef.current = []
      recStartRef.current = Date.now()
      setRecSecs(0)
      await startAudioPipeline()
      setRecording(true)
      setTranscribing(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setTranscribing(false)
    }
  }

  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setRecSecs((Date.now() - recStartRef.current) / 1000), 300)
    return () => clearInterval(t)
  }, [recording])

  const stopReading = async (): Promise<void> => {
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
      const chars = countReadableChars(transcript)
      const cpm = Math.round((chars / secs) * 60)
      if (chars < 20) throw new Error(`只聽到 ${chars} 個字，請確認麥克風與音量後再試一次`)
      setRateResult({ charsPerMin: cpm, chars, secs: Math.round(secs) })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTranscribing(false)
      setModelProgress(null)
    }
  }

  // ---------- Step 3: 套用 ----------
  const baseDistance = effectiveDistance ?? distanceCm ?? 60
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
    await update({
      personal: { profile },
      overlay: { fontSize: baseFontSize, speed: derivedSpeed }
    })
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
              min={50}
              max={80}
              value={ipdMm}
              onChange={(e) => setIpdMm(Number(e.target.value) || 63)}
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
                  onClick={() => setStep(1)}
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
                type="number"
                min={25}
                max={150}
                placeholder="例如 60"
                value={manualDistance ?? ''}
                onChange={(e) => setManualDistance(Number(e.target.value) || null)}
                className="input w-28"
              />
              <span className="text-xs text-ink-400">cm</span>
              <button className="btn-outline ml-auto text-xs" disabled={manualDistance == null} onClick={() => setStep(1)}>
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
            <button className="btn-outline text-xs" disabled={rateResult == null} onClick={() => setStep(2)}>
              下一步 <ChevronRight size={13} />
            </button>
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
        <button className="btn-ghost mt-4 text-xs" onClick={() => setStep((s) => (s - 1) as Step)}>
          回上一步
        </button>
      )}
    </div>
  )
}
