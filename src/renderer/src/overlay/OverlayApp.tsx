import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlignJustify,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  FlipHorizontal2,
  Gauge,
  Hand,
  List,
  Loader2,
  Maximize2,
  MessageCircleQuestion,
  Minimize2,
  MousePointerClick,
  Pause,
  Play,
  ScanEye,
  ScanFace,
  Siren,
  Type,
  X
} from 'lucide-react'
import type { AppSettings, OverlayDisplayMode } from '@shared/types'
import type { OverlayShowPayload } from '@shared/api'
import { cn, degrade, formatDuration } from '../lib/utils'
import {
  bestMatchPosition,
  buildChunks,
  chunkAtPosition,
  normalizeForMatch,
  type FollowChunk
} from '../lib/follow'
import { AudioSegmenter } from '../lib/audio/segmenter'
import { SpringAnimator, SPRING_PRESETS } from '../lib/spring'
import { buildDisplacementMap, ensureGlassFilter } from '../lib/glassRefraction'
import { WhisperClient, type WhisperModelKey } from '../lib/audio/whisperClient'
import { PhraseVisuals } from '../lib/teleprompter/constants'
import { effectiveEngineRate } from '../lib/calibration'
import type { EngineState } from '../lib/teleprompter/engine'
import type { ScriptModel } from '../lib/teleprompter/scriptModel'
import { useTeleprompterEngine } from './useTeleprompterEngine'
import { usePanic } from './usePanic'
import { useTurnYield } from './useTurnYield'
import { useCoaching } from './useCoaching'
import { RescueCard } from './RescueCard'
import { Segmented } from '../components/Segmented'

type FollowStatus = 'idle' | 'loading' | 'listening' | 'error'

/** 進入藥丸/貼鏡模式前的視窗尺寸(morph 動畫的還原基準;module-level 供切頁保留) */
const expandedSize = { current: null as { w: number; h: number } | null }
const lensPrevSize = { current: null as { w: number | null; h: number | null } | null }

const MODES: Array<{ id: OverlayDisplayMode; label: string; icon: typeof AlignJustify }> = [
  { id: 'scroll', label: '連續捲動', icon: AlignJustify },
  { id: 'phrase', label: '逐句短語', icon: Type },
  { id: 'bullet', label: '重點要點', icon: List },
  { id: 'karaoke', label: '逐詞卡拉OK', icon: AudioLines }
]

function ToolBtn({
  onClick,
  active,
  title,
  children
}: {
  onClick: () => void
  active?: boolean
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors cursor-pointer no-drag',
        active ? 'bg-accent-500/25 text-accent-300' : 'text-white/72 hover:bg-white/10 hover:text-white'
      )}
    >
      {children}
    </button>
  )
}

// ── 模式畫面 ──

function ScrollSurface({
  model,
  settings,
  onTogglePlay,
  scrollRef,
  followChunks,
  activeChunk,
  chunkElRef,
  onWheelAdjust
}: {
  model: ScriptModel
  settings: AppSettings['overlay']
  onTogglePlay: () => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  followChunks: FollowChunk[] | null
  activeChunk: number
  chunkElRef: (i: number, el: HTMLSpanElement | null) => void
  onWheelAdjust: (deltaY: number) => void
}): JSX.Element {
  return (
    <div
      ref={scrollRef}
      className="h-full cursor-pointer overflow-y-auto px-7 py-5"
      style={{ scrollbarWidth: 'none' }}
      onClick={followChunks ? undefined : onTogglePlay}
      onWheel={(e) => onWheelAdjust(e.deltaY)}
    >
      <div
        className="font-medium text-white/100 select-none"
        style={{
          fontSize: settings.fontSize,
          lineHeight: settings.lineHeight,
          textShadow: '0 1px 6px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)',
          letterSpacing: '0.02em'
        }}
      >
        {followChunks
          ? followChunks.map((chunk, i) => {
              const isActive = i === activeChunk
              const isRead = activeChunk >= 0 && i < activeChunk
              return (
                <span
                  key={i}
                  ref={(el) => chunkElRef(i, el)}
                  className={cn(
                    'transition-colors duration-300',
                    isActive && 'rounded bg-accent-500/35',
                    isRead && 'text-white/45'
                  )}
                >
                  {chunk.text}
                  {'\n'}
                </span>
              )
            })
          : model.content}
      </div>
      <div className="h-[40vh]" />
    </div>
  )
}

function PhraseSurface({
  model,
  state,
  fontSize
}: {
  model: ScriptModel
  state: EngineState
  fontSize: number
}): JSX.Element {
  const phrases = model.phrases[state.sentenceIndex] ?? []
  const nextSentence = model.sentences[state.sentenceIndex + 1] ?? null
  // 預讀:當前步驟將在 500ms 內結束時,先亮起下一短語
  const readAhead =
    state.status === 'playing' &&
    state.stepDurationMs - state.stepElapsedMs <= PhraseVisuals.UPCOMING_PHRASE_ADVANCE_MS

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-4">
      {/* 行寬鎖 30-35 字(W3C 中文排版甜蜜點),一眼掃完不動頭 */}
      <div
        className="flex max-w-[32em] flex-wrap gap-x-3 gap-y-1 font-semibold select-none"
        style={{ fontSize, lineHeight: PhraseVisuals.LINE_HEIGHT }}
      >
        {phrases.map((p, i) => {
          const isActive = i === state.phraseIndex
          const isNext = readAhead && i === state.phraseIndex + 1
          const opacity = isActive
            ? PhraseVisuals.ACTIVE_PHRASE_OPACITY
            : isNext
              ? PhraseVisuals.UPCOMING_PHRASE_OPACITY
              : i < state.phraseIndex
                ? PhraseVisuals.PREV_LINE_OPACITY
                : PhraseVisuals.NEXT_LINE_OPACITY
          return (
            <span
              key={i}
              className="transition-opacity duration-150"
              style={{
                opacity,
                color: isActive ? '#fff' : isNext ? 'var(--color-accent-300)' : undefined,
                textShadow: '0 1px 3px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.5)'
              }}
            >
              {p.text}
            </span>
          )
        })}
      </div>
      {nextSentence && (
        <div
          className="mt-3 truncate border-t border-white/5 pt-2 text-white/52 select-none"
          style={{ fontSize: Math.max(14, fontSize * 0.55) }}
        >
          下一句:{nextSentence}
        </div>
      )}
    </div>
  )
}

function BulletSurface({
  model,
  state,
  fontSize
}: {
  model: ScriptModel
  state: EngineState
  fontSize: number
}): JSX.Element {
  const bullet = model.bullets[state.bulletIndex]

  if (!bullet) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-white/52 select-none">
        此講稿無法切出重點
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-4 select-none">
      <div
        className="font-semibold text-white"
        style={{ fontSize: fontSize * 1.05, lineHeight: 1.35, textShadow: '0 1px 6px rgba(0,0,0,0.85)' }}
      >
        {bullet.title}
      </div>
      {bullet.subPoints.length > 0 && (
        <ul className="mt-2 space-y-1 text-white/72" style={{ fontSize: Math.max(14, fontSize * 0.58) }}>
          {bullet.subPoints.map((sp, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-accent-400">•</span>
              <span>{sp}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 font-mono text-[10px] text-white/52">
        {state.bulletIndex + 1} / {model.bullets.length} ・ ← → 切換
      </div>
    </div>
  )
}

/**
 * 貼鏡模式表面(v3 TeleprompterGazeSurface 的幾何錨定 lite 版):
 * 當前行鎖定在鏡頭下方 ~2° 視角的 camera band,下面依 0.62/0.38 淡出預讀。
 * 文字距鏡頭 <5cm 時眼球偏轉角極小,錄出來就像直視鏡頭。
 */
function LensSurface({
  model,
  state,
  displayMode
}: {
  model: ScriptModel
  state: EngineState
  displayMode: OverlayDisplayMode
}): JSX.Element {
  if (displayMode === 'bullet') {
    const bullet = model.bullets[state.bulletIndex]
    const next = model.bullets[state.bulletIndex + 1]
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-1.5 select-none">
        <div className="font-semibold leading-snug text-white/72 reading-shadow" style={{ fontSize: 19 }}>
          {bullet?.title ?? '—'}
        </div>
        {bullet && bullet.subPoints.length > 0 && (
          <div className="mt-0.5 truncate text-[11px] text-white/72" style={{ opacity: 0.8 }}>
            {bullet.subPoints[0]}
          </div>
        )}
        <div className="mt-auto truncate pb-1.5 text-[11px] text-white/72" style={{ opacity: 0.62 }}>
          下一點:{next?.title ?? '(結束)'}
        </div>
      </div>
    )
  }

  if (displayMode === 'karaoke') {
    const words = model.karaokeWordChunks[state.karaokeChunkIndex] ?? []
    const nextChunk = model.karaokeChunks[state.karaokeChunkIndex + 1]
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-1.5 select-none">
        <div className="flex flex-wrap gap-x-1.5 font-semibold leading-snug reading-shadow" style={{ fontSize: 19 }}>
          {words.map((w, i) => (
            <span
              key={i}
              style={{
                color:
                  i === state.karaokeWordIndex
                    ? '#fff'
                    : i < state.karaokeWordIndex
                      ? 'var(--color-accent-300)'
                      : 'var(--color-ink-400)'
              }}
            >
              {w}
            </span>
          ))}
        </div>
        <div className="mt-auto truncate pb-1.5 text-[11px] text-white/72" style={{ opacity: 0.62 }}>
          下一詞組:{nextChunk ?? '(結束)'}
        </div>
      </div>
    )
  }

  // phrase / scroll:句子 band + 短語高亮
  const phrases = model.phrases[state.sentenceIndex] ?? []
  const nextSentence = model.sentences[state.sentenceIndex + 1] ?? null
  const upcoming = model.sentences[state.sentenceIndex + 2] ?? null
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pt-1.5 select-none">
      <div className="flex flex-wrap gap-x-2 font-medium leading-snug reading-shadow" style={{ fontSize: 19 }}>
        {phrases.map((p, i) => (
          <span
            key={i}
            style={{
              color: i === state.phraseIndex ? '#fff' : undefined,
              opacity:
                i === state.phraseIndex
                  ? 1
                  : i === state.phraseIndex + 1
                    ? 0.62
                    : i < state.phraseIndex
                      ? 0.22
                      : 0.38
            }}
          >
            {p.text}
          </span>
        ))}
      </div>
      <div className="mt-auto space-y-0.5 pb-1.5">
        <div className="truncate text-[12px] text-white/72" style={{ opacity: 0.62 }}>
          下一句:{nextSentence ?? '—'}
        </div>
        {upcoming && (
          <div className="truncate text-[11px] text-white/72" style={{ opacity: 0.38 }}>
            再下一句:{upcoming}
          </div>
        )}
      </div>
    </div>
  )
}

function KaraokeSurface({
  model,
  state,
  fontSize
}: {
  model: ScriptModel
  state: EngineState
  fontSize: number
}): JSX.Element {  const words = model.karaokeWordChunks[state.karaokeChunkIndex] ?? []
  const totalChunks = model.karaokeChunks.length

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-4 select-none">
      <div
        className="flex flex-wrap gap-x-2 gap-y-0.5 font-semibold"
        style={{ fontSize, lineHeight: PhraseVisuals.LINE_HEIGHT }}
      >
        {words.map((w, i) => {
          const done = i < state.karaokeWordIndex
          const active = i === state.karaokeWordIndex
          return (
            <span
              key={i}
              className="transition-colors duration-100"
              style={{
                color: active ? '#fff' : done ? 'var(--color-accent-300)' : 'var(--color-ink-600)',
                textShadow: active
                  ? '0 0 12px rgba(143,140,250,0.55), 0 1px 6px rgba(0,0,0,0.85)'
                  : undefined
              }}
            >
              {w}
            </span>
          )
        })}
      </div>
      <div className="mt-2 font-mono text-[10px] text-white/52">
        {Math.min(state.karaokeChunkIndex + 1, totalChunks)} / {totalChunks}
      </div>
    </div>
  )
}

export default function OverlayApp(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [payload, setPayload] = useState<OverlayShowPayload>({})

  // 語音跟讀(scroll 模式)
  const [followStatus, setFollowStatus] = useState<FollowStatus>('idle')
  const [followMsg, setFollowMsg] = useState('')
  const [lastHeard, setLastHeard] = useState('')
  const [activeChunk, setActiveChunk] = useState(-1)
  const [followProgress, setFollowProgress] = useState(0)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  const whisperRef = useRef<WhisperClient | null>(null)
  const segmenterRef = useRef<AudioSegmenter | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const followRef = useRef<{ chunks: FollowChunk[]; norm: string; pos: number }>({
    chunks: [],
    norm: '',
    pos: 0
  })
  const chunkElsRef = useRef<Map<number, HTMLSpanElement>>(new Map())
  // 跟隨模式的手動滾輪偏移:使用者滾動後,自動對位仍以此偏移為基準(不回彈)
  const followOffsetRef = useRef(0)

  // ---- 初始化 ----
  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    void window.api.getSettings().then(setSettings)
    void window.api.overlayGetLastPayload().then(setPayload)
    const offScript = window.api.onOverlayLoadScript((p) => {
      setPayload(p)
      setActiveChunk(-1)
      setFollowProgress(0)
      // 主視窗「開始提詞」的期待是「打開就開始講」:自動播放。
      // 手動播放永遠可用(空白鍵/工具列/Alt+K),所以自動播放失敗也不會卡住使用者。
      controlsRef.current?.play()
    })
    const offSettings = window.api.onSettingsChanged(setSettings)
    return () => {
      offScript()
      offSettings()
    }
  }, [])

  useEffect(() => {
    return () => {
      // 視窗關閉時清理音訊
      segmenterRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      whisperRef.current?.dispose()
    }
  }, [])

  const content = payload.content ?? ''

  // 講稿內容變化 → 重建跟讀索引,並把捲動位置歸零
  // (引擎內部 scrollPos 會重置,但 scroll 模式每幀直寫 DOM,暫停時不會再推,殘影會留在畫面上)
  useEffect(() => {
    followRef.current = {
      chunks: buildChunks(content),
      norm: normalizeForMatch(content),
      pos: 0
    }
    setActiveChunk(-1)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [content])

  // ---- 四模式定時引擎 ----
  const o = settings?.overlay
  const displayMode = o?.displayMode ?? 'scroll'
  // 個人化語速基準：已校準時 1×＝使用者自己的語速（引擎固定 120 WPM 基準，換算為有效倍率）
  const personalBaseline = settings?.personal.profile?.charsPerMin ?? PhraseVisuals.DEFAULT_WPM
  const { state, model, remainingMs, progress, controls } = useTeleprompterEngine({
    content,
    displayMode,
    rate: effectiveEngineRate(o?.rate ?? 1, settings?.personal.profile?.charsPerMin, PhraseVisuals.DEFAULT_WPM),
    scrollSpeed: o?.speed ?? 60,
    scrollElRef: scrollRef,
    measureKey: `${o?.fontSize ?? 30}|${o?.lineHeight ?? 1.5}`
  })

  // ---- Panic 救援(Alt+P 或工具列按鈕;出卡時暫停提詞)----
  const pauseForRescue = useCallback((): void => {
    controls.pause()
  }, [controls])
  const { phase: panicPhase, rescue, errorMsg, trigger: triggerPanic, dismiss: dismissRescue } = usePanic(
    () => content,
    pauseForRescue
  )

  // ---- turn-yield 提示(Phase B):對方講完問句/長段 → 該你說話了 ----
  // Record 頁的系統音訊轉錄經 context:push-transcript 進 main,main 偵測後廣播。
  const { hint: turnYieldHint, notifyMeSpeaking: notifyTurnYield } = useTurnYield(
    o?.turnYield ?? true
  )
  const turnYieldText =
    turnYieldHint === null
      ? ''
      : turnYieldHint.kind === 'turn'
        ? '該你說話了 — 對方在等你回答'
        : '對方已停頓 — 該接話了'

  // ---- 即時教練(Phase B+):語速過快/填充詞/損話/冷場/獨白過長 ----
  const { hint: coachingHint } = useCoaching(o?.coaching ?? true)

  // ---- 視窗尺寸同步 ----
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onResize = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void window.api.overlaySetSize(window.innerWidth, window.innerHeight)
      }, 400)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (timer) clearTimeout(timer)
    }
  }, [])

  const patchOverlay = useCallback(
    async (patch: Partial<AppSettings['overlay']>): Promise<void> => {
      await window.api.setSettings({ overlay: patch })
    },
    []
  )

  const setMode = useCallback(
    (mode: OverlayDisplayMode): void => {
      if (mode !== 'scroll' && followStatus !== 'idle') stopFollowRef.current()
      void patchOverlay({ displayMode: mode })
    },
    [patchOverlay, followStatus]
  )

  // ---- 語音跟讀(scroll 模式限定)----
  const scrollToChunk = useCallback((idx: number): void => {
    const el = scrollRef.current
    const target = chunkElsRef.current.get(idx)
    if (!el || !target) return
    const top = target.offsetTop - el.clientHeight * 0.33 + followOffsetRef.current
    el.scrollTo({ top: Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight)), behavior: 'smooth' })
    const maxScroll = el.scrollHeight - el.clientHeight
    if (maxScroll > 0) setFollowProgress(Math.min(1, el.scrollTop / maxScroll))
  }, [])

  const handleFollowTranscript = useCallback(
    (text: string): void => {
      // 餵給 main 的 liveContext:panic 觸發時才有語音上下文可用
      void window.api.pushTranscript({ text, speaker: 'me' })
      // 我方開口 → 即時收掉「該你說話了」提示(你已在回話)。
      // 硬編碼中文填充詞是刻意的:STT 對極短音沒有把握,即便只聽到
      // 「嗯」也不該讓「該你了」繼續掛著——誤收一次的代價遠低於漏收。
      const isMeSpeech = text.trim().length >= 2 || /[嗯呃誒]/.test(text)
      if (isMeSpeech) notifyTurnYield()
      const f = followRef.current
      const spoken = normalizeForMatch(text)
      if (spoken.length < 4) return
      // 兩段式:先在當前位置附近找;失敗時放寬向後視窗 — 偵測「重複唸上一段」自動跳回關鍵詞
      let end = bestMatchPosition(f.norm, spoken, f.pos)
      if (end < 0) {
        end = bestMatchPosition(f.norm, spoken, f.pos, { backward: 160 })
      }
      if (end >= 0) {
        f.pos = end
        const idx = chunkAtPosition(f.chunks, Math.max(0, end - 1))
        setActiveChunk(idx)
        scrollToChunk(idx)
        setLastHeard(text.slice(0, 60))
      }
    },
    [scrollToChunk, notifyTurnYield]
  )

  // 跟隨中滾輪微調:調整偏移而非直接捲動,下次自動對位仍尊重使用者的視線位置
  const adjustFollowOffset = useCallback(
    (deltaY: number): void => {
      if (followStatus !== 'listening') return
      followOffsetRef.current = Math.max(-3000, Math.min(3000, followOffsetRef.current + deltaY))
    },
    [followStatus]
  )

  const startFollow = useCallback(async (): Promise<void> => {
    if (!settings) return
    // 跟讀時暫停自動捲動,讓位給語音對齊
    controls.pause()
    followOffsetRef.current = 0
    setFollowMsg('')
    setFollowStatus('loading')
    try {
      if (!whisperRef.current) whisperRef.current = new WhisperClient()
      const client = whisperRef.current
      client.onProgress = (p) => {
        if (p.status === 'progress') setFollowMsg(`載入模型 ${p.progress?.toFixed(0) ?? 0}%`)
      }
      client.onStatus = (m) => setFollowMsg(m)
      await client.load((settings.stt.localModel ?? 'base') as WhisperModelKey)

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      streamRef.current = stream
      segmenterRef.current = new AudioSegmenter({
        onSegment: (audio, sr) => {
          void client
            .transcribe(audio, settings.stt.language)
            .then(handleFollowTranscript)
            .catch(() => undefined)
        },
        threshold: 0.01
      })
      await segmenterRef.current.start(stream)
      setFollowStatus('listening')
      setFollowMsg('')
    } catch (err) {
      setFollowStatus('error')
      setFollowMsg(err instanceof Error ? err.message : String(err))
    }
  }, [settings, handleFollowTranscript, controls])

  const stopFollow = useCallback((): void => {
    segmenterRef.current?.stop()
    segmenterRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    followOffsetRef.current = 0
    setFollowStatus('idle')
    setFollowMsg('')
    setActiveChunk(-1)
  }, [])

  // setMode 需要引用最新的 stopFollow(避免 effect 依賴膨脹)
  const stopFollowRef = useRef(stopFollow)
  stopFollowRef.current = stopFollow

  const toggleFollow = useCallback((): void => {
    if (followStatus === 'idle' || followStatus === 'error') {
      void startFollow()
    } else {
      stopFollow()
    }
  }, [followStatus, startFollow, stopFollow])

  const setMirror = useCallback((): void => {
    void patchOverlay({ mirror: !settings!.overlay.mirror })
  }, [patchOverlay, settings])

  // ---- 鍵盤控制(浮層聚焦時)----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (displayMode === 'bullet') {
        if (e.key === 'ArrowRight') controls.next()
        if (e.key === 'ArrowLeft') controls.prev()
      } else if (e.key === ' ') {
        e.preventDefault()
        controls.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controls, displayMode])

  // 貼鏡模式提示(每次開啟顯示 6 秒)
  const [lensHint, setLensHint] = useState(false)
  const lensOn = o?.lensMode ?? false
  useEffect(() => {
    if (!lensOn) return
    setLensHint(true)
    const t = setTimeout(() => setLensHint(false), 6000)
    return () => clearTimeout(t)
  }, [lensOn])

  // ── Liquid Glass 真折射(P2-13):位移圖隨視窗尺寸重建,filter 注入 DOM ──
  // CSS 端 @supports 讓不支援 SVG backdrop-filter 的引擎自動退回一般 blur。
  const [refractOk, setRefractOk] = useState(false)
  const [winSize, setWinSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    // 偵測:Chromium 才允許 url() 於 backdrop-filter;以 CSS.supports 探測
    setRefractOk(
      typeof CSS !== 'undefined' &&
        (CSS.supports('backdrop-filter', 'url(#x)') || CSS.supports('-webkit-backdrop-filter', 'url(#x)'))
    )
  }, [])
  useEffect(() => {
    if (!refractOk || !o?.glass) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const rebuild = (): void => {
      const w = Math.max(1, window.innerWidth)
      const h = Math.max(1, window.innerHeight)
      const map = buildDisplacementMap(w, h, 18, 14, 12)
      ensureGlassFilter('liquid-glass', map, 2)
      setWinSize({ w, h })
    }
    rebuild()
    // morph 動畫期間每幀都 resize,debounce 300ms 後重建
    const onResize = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(rebuild, 300)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (timer) clearTimeout(timer)
    }
  }, [refractOk, o?.glass, winSize.w === 0])

  // pill 隨游標 specular(P2-13):滑鼠移動更新 --spec-x/--spec-y(ref 套在 pill 外殼)
  const specRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = specRef.current
    if (!el) return
    const onMove = (e: MouseEvent): void => {
      const rect = el.getBoundingClientRect()
      el.style.setProperty('--spec-x', `${((e.clientX - rect.left) / rect.width) * 100}%`)
      el.style.setProperty('--spec-y', `${((e.clientY - rect.top) / rect.height) * 100}%`)
      el.style.setProperty('--spec-o', '1')
    }
    const onLeave = (): void => el.style.setProperty('--spec-o', '0')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseout', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseout', onLeave)
    }
  }, [])

  // ---- 全域熱鍵事件(main 廣播):播放/暫停 + 語速步進 ----
  // 浮層可被滑鼠穿透或失焦,鍵盤控制只剩全域熱鍵這條路
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  useEffect(() => {
    const offPlay = window.api.onOverlayPlayPause(() => {
      controlsRef.current.toggle()
    })
    const offStep = window.api.onOverlaySpeedStep((dir) => {
      if (!settingsRef.current) return
      const cur = settingsRef.current.overlay.rate
      const next = Math.min(3, Math.max(0.5, Math.round((cur + dir * 0.1) * 10) / 10))
      if (next !== cur) void window.api.setSettings({ overlay: { rate: next } })
    })
    return () => {
      offPlay()
      offStep()
    }
  }, [])

  // ── 藥丸/貼鏡 morph:彈簧驅動視窗尺寸(開合分離阻尼)──
  // rAF 彈簧積分器:展開用 open(ζ≈0.8 帶彈)、收合用 close(臨界阻尼零彈跳);
  // 每幀 overlaySetSizeLive(不落盤),收斂時 onSettle 才以 overlaySetSize 定案(寫入設定)。
  // 注意:hooks 必須在下方 early return 之前,否則 settings 載入前後 hook 數不一致(React #310)。
  const sizeSpringRef = useRef<SpringAnimator | null>(null)
  /** morph 定案後的「原始展開尺寸」;進入貼鏡/藥丸前的還原基準 */
  const settledSizeRef = useRef<{ w: number; h: number } | null>(null)

  const stopSizeSpring = useCallback((): void => {
    sizeSpringRef.current?.stop()
    sizeSpringRef.current = null
  }, [])

  useEffect(
    () => () => stopSizeSpring(),
    [stopSizeSpring]
  )

  /** 以彈簧把視窗從目前尺寸 morph 到 (toW,toH);isOpening 決定阻尼(open 有彈/close 無彈)。
   *  settleSize = 收斂時寫入設定的最終尺寸(通常等於 toW/toH) */
  const morphSize = useCallback(
    (toW: number, toH: number, isOpening: boolean, settleSize: { w: number; h: number }): void => {
      const startW = window.innerWidth
      const startH = window.innerHeight
      // 目標就是目前尺寸:直接定案,不播動畫
      if (startW === toW && startH === toH) {
        settledSizeRef.current = settleSize
        void window.api.overlaySetSize(toW, toH)
        return
      }
      settledSizeRef.current = null
      stopSizeSpring()
      const animator = new SpringAnimator(
        0,
        1,
        isOpening ? SPRING_PRESETS.open : SPRING_PRESETS.close,
        () => {},
        () => {
          settledSizeRef.current = settleSize
          void window.api.overlaySetSize(settleSize.w, settleSize.h)
        }
      )
      sizeSpringRef.current = animator
      const wSpan = toW - startW
      const hSpan = toH - startH
      let lastAt: number | null = null
      const tick = (now: number): void => {
        if (sizeSpringRef.current !== animator) return // 已被新的 morph 取代
        const dt = lastAt === null ? 16.7 : Math.min(64, now - lastAt)
        lastAt = now
        animator.advance(dt)
        const p = animator.value
        void window.api.overlaySetSizeLive(Math.round(startW + wSpan * p), Math.round(startH + hSpan * p))
        if (animator.settled) {
          sizeSpringRef.current = null // onSettle 已在 advance() 內定案
        } else {
          requestAnimationFrame(tick)
        }
      }
      requestAnimationFrame(tick)
    },
    [stopSizeSpring]
  )

  if (!o || !state) {
    return <div className="h-full" />
  }

  const playing = state.status === 'playing'
  const elapsedSec = state.elapsedMs / 1000
  const isBullet = displayMode === 'bullet'
  const isTimedMode = displayMode === 'phrase' || displayMode === 'karaoke'
  const following = followStatus === 'listening' || followStatus === 'loading'
  const followChunks = followStatus === 'listening' ? followRef.current.chunks : null
  const shownProgress = followChunks ? followProgress : progress

  // ── 藥丸模式:縮小視窗成一行玻璃藥丸,展開還原原尺寸 ──
  const enterCompact = (): void => {
    // 原始展開尺寸:從「最後定案的展開尺寸」取;直接從貼鏡進來時用 lensPrevSize,
    // 都沒有才用設定值(morph 途中 o.width/height 尚未定案,不可用)
    const prevLens = lensPrevSize.current
    const fromLens = prevLens && prevLens.w !== null && prevLens.h !== null ? { w: prevLens.w, h: prevLens.h } : null
    const expanded = settledSizeRef.current ?? fromLens ?? { w: o.width, h: o.height }
    expandedSize.current = expanded
    void patchOverlay({ compact: true })
    morphSize(460, 56, false, expanded)
  }
  const exitCompact = (): void => {
    const size = expandedSize.current ?? settledSizeRef.current ?? { w: 720, h: 260 }
    void patchOverlay({ compact: false })
    morphSize(size.w, size.h, true, size)
  }

  // ── 貼鏡模式:窄條視窗貼近攝影機,當前行鎖定鏡頭下方 ~2° 視角 ──
  const enterLens = (): void => {
    const expanded =
      settledSizeRef.current ??
      (o.compact ? expandedSize.current : null) ??
      { w: o.width, h: o.height }
    lensPrevSize.current = expanded
    void patchOverlay({ lensMode: true, compact: false })
    morphSize(420, 170, false, expanded)
  }
  const exitLens = (): void => {
    const prev = lensPrevSize.current
    // prev.w === null 表示進貼鏡前本來就是藥丸:還原回藥丸而非強制展開
    const size = prev && prev.w !== null && prev.h !== null ? { w: prev.w, h: prev.h } : null
    if (!size) {
      void patchOverlay({ lensMode: false, compact: true })
      morphSize(460, 56, true, { w: 720, h: 260 })
      return
    }
    void patchOverlay({ lensMode: false })
    morphSize(size.w, size.h, true, size)
  }

  if (o.compact) {
    // 漸進揭露:pill 顯示「下一個關鍵詞」(各模式游標的下一單元開頭);
    // 精度降級取代截斷:寬度不足時降為前 4 字,永不出現「…」
    let nextKeyword = ''
    if (displayMode === 'phrase' || displayMode === 'scroll') {
      const phrases = model.phrases[state.sentenceIndex] ?? []
      const next = phrases[state.phraseIndex + 1] ?? (model.sentences[state.sentenceIndex + 1] ?? '')
      nextKeyword = degrade(typeof next === 'string' ? next : next.text, 6)
    } else if (displayMode === 'karaoke') {
      nextKeyword = degrade(model.karaokeChunks[state.karaokeChunkIndex + 1] ?? '', 6)
    } else if (displayMode === 'bullet') {
      nextKeyword = degrade(model.bullets[state.bulletIndex + 1]?.title ?? '', 6)
    }
    return (
      <div
        ref={specRef}
        className={cn(
          'glass-pill content-morph-in glass-specular flex h-full cursor-default select-none items-center gap-3 rounded-full px-4',
          refractOk && o.glass && 'glass-refract'
        )}
        title="雙擊展開"
        onDoubleClick={exitCompact}
      >
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            o.clickThrough ? 'bg-amber-450' : playing ? 'bg-emerald-500' : 'bg-ink-600'
          )}
        />
        <span className="max-w-[110px] truncate text-xs font-medium text-white/100">
          {degrade(payload.title || '提詞浮層', 8)}
        </span>
        <div className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent-400 to-accent-600 transition-[width] duration-300"
            style={{ width: `${shownProgress * 100}%` }}
          />
        </div>
        {turnYieldHint && (
          <span
            title={turnYieldText}
            className="flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full bg-sky-500/20 px-2 text-[10px] font-medium text-sky-300"
          >
            <MessageCircleQuestion size={11} /> 該你了
          </span>
        )}
        {coachingHint && (
          <span
            title={coachingHint.message}
            className="flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/20 px-2 text-[10px] font-medium text-amber-300"
          >
            <Gauge size={11} /> 教練
          </span>
        )}
        {nextKeyword && (
          <span className="text-[11px] text-accent-300" title={`下一個:${nextKeyword}`}>
            {nextKeyword}
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-white/72">{formatDuration(elapsedSec)}</span>
        {panicPhase !== 'idle' ? (
          <button
            onClick={dismissRescue}
            title="救援顯示中 — 點擊關閉"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-rose-500/25 text-rose-400"
          >
            <Siren size={13} />
          </button>
        ) : (
          <button
            onClick={triggerPanic}
            title="Panic 救援(Alt+P)"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/72 hover:bg-white/10 hover:text-white/100"
          >
            <Siren size={13} />
          </button>
        )}
        <button
          onClick={playing ? controls.pause : controls.play}
          title={playing ? '暫停' : '播放'}
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/72 hover:bg-white/10 hover:text-white/100"
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button
          onClick={exitCompact}
          title="展開完整面板(或雙擊藥丸)"
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/72 hover:bg-white/10 hover:text-white/100"
        >
          <Maximize2 size={12} />
        </button>
        {turnYieldHint && (
          <span
            title={turnYieldText}
            className="flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full bg-sky-500/20 px-2 text-[10px] font-medium text-sky-300"
          >
            <MessageCircleQuestion size={11} /> 該你了
          </span>
        )}
      </div>
    )
  }

  // ── 貼鏡模式渲染:精簡工具列 + camera band ──
  if (o.lensMode) {
    return (
      <div
        className="glass-overlay relative flex h-full flex-col overflow-hidden rounded-2xl"
        style={{ background: `rgba(12, 14, 20, ${Math.max(0.25, Math.min(0.9, o.opacity))})` }}
      >
        <div
          className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 px-2"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <span
            className={cn('h-1.5 w-1.5 rounded-full', playing ? 'bg-emerald-500' : 'bg-ink-600')}
          />
          <span className="flex-1" />
          <div
            className="flex items-center gap-0.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <ToolBtn title="退出貼鏡模式" active onClick={exitLens}>
              <ScanFace size={13} />
            </ToolBtn>
            <ToolBtn title="Panic 救援(Alt+P)" active={panicPhase !== 'idle'} onClick={triggerPanic}>
              <Siren size={13} />
            </ToolBtn>
            <ToolBtn title={playing ? '暫停' : '播放'} active={playing} onClick={controls.toggle}>
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </ToolBtn>
            <ToolBtn title="隱藏(Ctrl+Alt+T 可再開)" onClick={() => void window.api.overlayHide()}>
              <X size={13} />
            </ToolBtn>
          </div>
        </div>
        <LensSurface model={model} state={state} displayMode={displayMode} />
        {/* 角落吸附:貼到螢幕上緣,離鏡頭軸線最近 */}
        <div
          className="absolute inset-x-0 top-9 z-10 flex justify-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {(
            [
              { id: 'tl', label: '↖ 左上' },
              { id: 'tc', label: '↑ 上中' },
              { id: 'tr', label: '↗ 右上' }
            ] as const
          ).map((c) => (
            <button
              key={c.id}
              onClick={() => void window.api.snapOverlayCorner(c.id)}
              className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-white/72 transition-colors hover:bg-white/15 hover:text-white/72 cursor-pointer"
            >
              {c.label}
            </button>
          ))}
        </div>
        {lensHint && (
          <div className="pointer-events-none absolute inset-x-3 bottom-1.5 z-10 rounded-full bg-black/60 px-3 py-1 text-center text-[10px] text-white/72">
            把這條貼到攝影機 5cm 內 — 眼神會自然對準鏡頭,錄起來不像看稿
          </div>
        )}
        {turnYieldHint && (
          <div className="pointer-events-none absolute inset-x-3 bottom-8 z-10 flex items-center justify-center gap-1.5 rounded-full bg-sky-500/20 px-3 py-1 text-[10px] font-medium text-sky-300">
            <MessageCircleQuestion size={11} /> {turnYieldText}
          </div>
        )}
        {panicPhase !== 'idle' && (
          <RescueCard phase={panicPhase} rescue={rescue} errorMsg={errorMsg} onDismiss={dismissRescue} />
        )}
      </div>
    )
  }

  return (
    <div
      className="glass-overlay relative flex h-full flex-col overflow-hidden rounded-2xl"
      style={{ background: `rgba(12, 14, 20, ${Math.max(0.25, Math.min(0.9, o.opacity))})` }}
    >
      {/* 工具列(可拖曳視窗)*/}
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 px-2.5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="mr-1 flex items-center gap-1.5">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              o.clickThrough
                ? 'bg-amber-450'
                : followStatus === 'listening'
                  ? 'animate-pulse bg-emerald-500'
                  : playing
                    ? 'bg-emerald-500'
                    : 'bg-ink-600'
            )}
          />
          <span className="max-w-[130px] truncate text-xs font-medium text-white/72">
            {payload.title || '提詞浮層'}
          </span>
        </div>

        {/* 顯示模式切換(iOS 分段控件)*/}
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Segmented
            options={MODES.map((m) => ({ id: m.id, label: '', icon: <m.icon size={13} />, title: `模式:${m.label}` }))}
            value={displayMode}
            onChange={setMode}
          />
        </div>

        <div className="flex-1" />

        <div
          className="flex items-center gap-0.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <span className="mr-1.5 select-none font-mono text-[10px] text-white/52">
            {formatDuration(elapsedSec)}
            {remainingMs !== null && ` / -${formatDuration(remainingMs / 1000)}`}
          </span>

          {/* turn-yield 開關(即時回饋用)*/}
          <ToolBtn
            title={o.turnYield ? '關閉「該你說話了」提示' : '開啟「該你說話了」提示:對方講完問句時提醒你接話'}
            active={o.turnYield}
            onClick={() => void patchOverlay({ turnYield: !o.turnYield })}
          >
            <Hand size={13} />
          </ToolBtn>

          {/* 即時教練開關 */}
          <ToolBtn
            title={o.coaching ? '即時教練開啟中(語速/填充詞/冷場)— 點擊關閉' : '開啟即時教練:語速過快、填充詞、冷場時提醒你'}
            active={o.coaching}
            onClick={() => void patchOverlay({ coaching: !o.coaching })}
          >
            <Gauge size={13} />
          </ToolBtn>

          {/* Panic 救援:被問倒時即時給答案(Alt+P)*/}
          <ToolBtn
            title="Panic 救援:即時回答要點(Alt+P)"
            active={panicPhase !== 'idle'}
            onClick={triggerPanic}
          >
            <Siren size={13} className={panicPhase === 'thinking' ? 'animate-pulse' : undefined} />
          </ToolBtn>

          {/* 收合成藥丸 */}
          <ToolBtn title="收合成藥丸(低存在感)" onClick={enterCompact}>
            <Minimize2 size={13} />
          </ToolBtn>

          {/* 貼鏡模式 */}
          <ToolBtn
            title="貼鏡模式:貼近攝影機 5cm 內,眼神自然對準鏡頭(建議搭配逐句短語)"
            active={o.lensMode}
            onClick={enterLens}
          >
            <ScanFace size={13} />
          </ToolBtn>

          {/* 語音跟讀(scroll 模式限定):唸到哪、捲到哪 */}
          {displayMode === 'scroll' && (
            <ToolBtn
              title="語音跟讀:唸到哪、捲到哪(需麥克風)"
              active={following}
              onClick={toggleFollow}
            >
              {followStatus === 'loading' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <AudioLines size={13} />
              )}
            </ToolBtn>
          )}

          {/* 播放控制(bullet 為手動模式,改顯示前後切換)*/}
          {isBullet ? (
            <>
              <ToolBtn title="上一個重點(←)" onClick={controls.prev}>
                <ChevronLeft size={13} />
              </ToolBtn>
              <ToolBtn title="下一個重點(→)" onClick={controls.next}>
                <ChevronRight size={13} />
              </ToolBtn>
            </>
          ) : (
            <>
              <ToolBtn
                title={playing ? '暫停(空白鍵)' : '播放(空白鍵)'}
                active={playing}
                onClick={controls.toggle}
              >
                {playing ? <Pause size={13} /> : <Play size={13} />}
              </ToolBtn>
              <ToolBtn title="回到開頭" onClick={controls.restart}>
                <span className="text-[11px] font-bold">↺</span>
              </ToolBtn>
            </>
          )}

          {/* 速度控制:timed 模式調倍率,scroll 模式調 px/s */}
          {isTimedMode ? (
            <>
              <ToolBtn
                title={personalBaseline !== PhraseVisuals.DEFAULT_WPM ? `語速 -（1×＝你的個人語速 ${personalBaseline} 字/分）` : '語速 -'}
                onClick={() =>
                  void patchOverlay({ rate: Math.max(0.5, Math.round((o.rate - 0.1) * 10) / 10) })
                }
              >
                <ChevronLeft size={13} />
              </ToolBtn>
              <span className="w-9 select-none text-center font-mono text-[10px] text-white/52">
                {(o.rate ?? 1).toFixed(1)}×
              </span>
              <ToolBtn
                title={personalBaseline !== PhraseVisuals.DEFAULT_WPM ? `語速 +（1×＝你的個人語速 ${personalBaseline} 字/分）` : '語速 +'}
                onClick={() =>
                  void patchOverlay({ rate: Math.min(3, Math.round((o.rate + 0.1) * 10) / 10) })
                }
              >
                <ChevronRight size={13} />
              </ToolBtn>
            </>
          ) : !isBullet ? (
            <>
              <ToolBtn title="速度 -" onClick={() => void patchOverlay({ speed: Math.max(10, o.speed - 10) })}>
                <ChevronLeft size={13} />
              </ToolBtn>
              <span className="w-9 select-none text-center font-mono text-[10px] text-white/52">{o.speed}</span>
              <ToolBtn title="速度 +" onClick={() => void patchOverlay({ speed: Math.min(600, o.speed + 10) })}>
                <ChevronRight size={13} />
              </ToolBtn>
            </>
          ) : null}

          <ToolBtn
            title="字體縮小"
            onClick={() => void patchOverlay({ fontSize: Math.max(16, o.fontSize - 2) })}
          >
            <span className="text-[11px] font-bold">A-</span>
          </ToolBtn>
          <ToolBtn
            title="字體放大"
            onClick={() => void patchOverlay({ fontSize: Math.min(72, o.fontSize + 2) })}
          >
            <span className="text-[13px] font-bold">A+</span>
          </ToolBtn>
          <ToolBtn title="鏡像(提詞器反射罩用)" active={o.mirror} onClick={setMirror}>
            <FlipHorizontal2 size={13} />
          </ToolBtn>
          <ToolBtn
            title={o.captureProtected ? '螢幕擷取隱形:開(分享畫面看不到此視窗)' : '螢幕擷取隱形:關'}
            active={o.captureProtected}
            onClick={() => void window.api.overlaySetCaptureProtection(!o.captureProtected)}
          >
            <ScanEye size={13} />
          </ToolBtn>
          <ToolBtn
            title={o.clickThrough ? '滑鼠穿透:開(點擊會穿過視窗,到主視窗或熱鍵關閉)' : '滑鼠穿透:關'}
            active={o.clickThrough}
            onClick={() => void window.api.overlaySetClickThrough(!o.clickThrough)}
          >
            <MousePointerClick size={13} />
          </ToolBtn>
          <ToolBtn title="關閉(Ctrl+Alt+T 可再開)" onClick={() => void window.api.overlayHide()}>
            <X size={13} />
          </ToolBtn>
        </div>
      </div>

      {/* 正文(四模式)*/}
      {content ? (
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          style={{ transform: o.mirror ? 'scaleX(-1)' : undefined }}
        >
          {displayMode === 'scroll' && (
            <ScrollSurface
              model={model}
              settings={o}
              onTogglePlay={controls.toggle}
              scrollRef={scrollRef}
              followChunks={followChunks}
              activeChunk={activeChunk}
              chunkElRef={(i, el) => {
                if (el) chunkElsRef.current.set(i, el)
                else chunkElsRef.current.delete(i)
              }}
              onWheelAdjust={adjustFollowOffset}
            />
          )}
          {displayMode === 'phrase' && <PhraseSurface model={model} state={state} fontSize={o.fontSize} />}
          {displayMode === 'bullet' && <BulletSurface model={model} state={state} fontSize={o.fontSize} />}
          {displayMode === 'karaoke' && <KaraokeSurface model={model} state={state} fontSize={o.fontSize} />}

          {/* 跟讀狀態條 */}
          {followStatus !== 'idle' && (
            <div className="pointer-events-none absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-[10px] text-white/72">
              {followStatus === 'loading' && <Loader2 size={10} className="animate-spin" />}
              {followStatus === 'listening' && <AudioLines size={10} className="text-emerald-400" />}
              <span className="max-w-[280px] truncate">
                {followMsg ||
                  (followStatus === 'listening'
                    ? lastHeard || '聆聽中…'
                    : followStatus === 'error'
                      ? '跟讀啟動失敗'
                      : '')}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-white/52">
          尚未載入講稿
          <br />
          到主視窗「提詞講稿」頁按「開始提詞」
        </div>
      )}

      {/* 即時回饋提示條(turn-yield 藍 / coaching 琥珀;堆疊避免同時觸發時互相遮擋)*/}
      {(turnYieldHint || coachingHint) && (
        <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex flex-col items-center gap-2">
          {turnYieldHint && (
            <div className="flex items-center justify-center gap-2 rounded-full bg-sky-500/25 px-4 py-2 text-xs font-medium text-sky-200 shadow-lg">
              <MessageCircleQuestion size={14} className="shrink-0" />
              {turnYieldText}
            </div>
          )}
          {coachingHint && (
            <div className="flex items-center justify-center gap-2 rounded-full bg-amber-500/25 px-4 py-2 text-xs font-medium text-amber-200 shadow-lg">
              <Gauge size={14} className="shrink-0" />
              {coachingHint.message}
            </div>
          )}
        </div>
      )}

      {/* Panic 救援卡(thinking / rescue)*/}
      {panicPhase !== 'idle' && (
        <RescueCard phase={panicPhase} rescue={rescue} errorMsg={errorMsg} onDismiss={dismissRescue} />
      )}

      {/* 進度條 */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-[3px] bg-white/5">
        <div
          className="h-full bg-gradient-to-r from-accent-400 to-accent-600 transition-[width] duration-150"
          style={{ width: `${shownProgress * 100}%` }}
        />
      </div>
    </div>
  )
}
