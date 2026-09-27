import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlignJustify,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  FlipHorizontal2,
  List,
  Loader2,
  MousePointerClick,
  Pause,
  Play,
  ScanEye,
  Siren,
  Type,
  X
} from 'lucide-react'
import type { AppSettings, OverlayDisplayMode } from '@shared/types'
import type { OverlayShowPayload } from '@shared/api'
import { cn, formatDuration } from '../lib/utils'
import {
  bestMatchPosition,
  buildChunks,
  chunkAtPosition,
  normalizeForMatch,
  type FollowChunk
} from '../lib/follow'
import { AudioSegmenter } from '../lib/audio/segmenter'
import { WhisperClient, type WhisperModelKey } from '../lib/audio/whisperClient'
import { PhraseVisuals } from '../lib/teleprompter/constants'
import type { EngineState } from '../lib/teleprompter/engine'
import type { ScriptModel } from '../lib/teleprompter/scriptModel'
import { useTeleprompterEngine } from './useTeleprompterEngine'
import { usePanic } from './usePanic'
import { RescueCard } from './RescueCard'

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
        active ? 'bg-accent-500/25 text-accent-300' : 'text-ink-300 hover:bg-white/10 hover:text-white'
      )}
    >
      {children}
    </button>
  )
}

type FollowStatus = 'idle' | 'loading' | 'listening' | 'error'

// ── 模式畫面 ──

function ScrollSurface({
  model,
  settings,
  onTogglePlay,
  scrollRef,
  followChunks,
  activeChunk,
  chunkElRef
}: {
  model: ScriptModel
  settings: AppSettings['overlay']
  onTogglePlay: () => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  followChunks: FollowChunk[] | null
  activeChunk: number
  chunkElRef: (i: number, el: HTMLSpanElement | null) => void
}): JSX.Element {
  return (
    <div
      ref={scrollRef}
      className="h-full cursor-pointer overflow-y-auto px-7 py-5"
      style={{ scrollbarWidth: 'none' }}
      onClick={followChunks ? undefined : onTogglePlay}
    >
      <div
        className="font-medium text-white select-none"
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
      <div
        className="flex flex-wrap gap-x-3 gap-y-1 font-medium select-none"
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
                textShadow: '0 1px 6px rgba(0,0,0,0.85)'
              }}
            >
              {p.text}
            </span>
          )
        })}
      </div>
      {nextSentence && (
        <div
          className="mt-3 truncate border-t border-white/5 pt-2 text-ink-400 select-none"
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
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-400 select-none">
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
        <ul className="mt-2 space-y-1 text-ink-200" style={{ fontSize: Math.max(14, fontSize * 0.58) }}>
          {bullet.subPoints.map((sp, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-accent-400">•</span>
              <span>{sp}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 font-mono text-[10px] text-ink-400">
        {state.bulletIndex + 1} / {model.bullets.length} ・ ← → 切換
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
}): JSX.Element {
  const words = model.karaokeWordChunks[state.karaokeChunkIndex] ?? []
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
      <div className="mt-2 font-mono text-[10px] text-ink-400">
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

  // 講稿內容變化 → 重建跟讀索引
  useEffect(() => {
    followRef.current = {
      chunks: buildChunks(content),
      norm: normalizeForMatch(content),
      pos: 0
    }
    setActiveChunk(-1)
  }, [content])

  // ---- 四模式定時引擎 ----
  const o = settings?.overlay
  const displayMode = o?.displayMode ?? 'scroll'
  const { state, model, remainingMs, progress, controls } = useTeleprompterEngine({
    content,
    displayMode,
    rate: o?.rate ?? 1,
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
    const top = target.offsetTop - el.clientHeight * 0.33
    el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    const maxScroll = el.scrollHeight - el.clientHeight
    if (maxScroll > 0) setFollowProgress(Math.min(1, top / maxScroll))
  }, [])

  const handleFollowTranscript = useCallback(
    (text: string): void => {
      // 餵給 main 的 liveContext:panic 觸發時才有語音上下文可用
      void window.api.pushTranscript({ text, speaker: 'me' })
      const f = followRef.current
      const spoken = normalizeForMatch(text)
      if (spoken.length < 4) return
      const end = bestMatchPosition(f.norm, spoken, f.pos)
      if (end >= 0) {
        f.pos = end
        const idx = chunkAtPosition(f.chunks, Math.max(0, end - 1))
        setActiveChunk(idx)
        scrollToChunk(idx)
        setLastHeard(text.slice(0, 60))
      }
    },
    [scrollToChunk]
  )

  const startFollow = useCallback(async (): Promise<void> => {
    if (!settings) return
    // 跟讀時暫停自動捲動,讓位給語音對齊
    controls.pause()
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

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden rounded-xl border shadow-2xl backdrop-blur-md"
      style={{
        background: `rgba(9, 11, 18, ${o.opacity})`,
        borderColor: 'rgba(255,255,255,0.09)'
      }}
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
          <span className="max-w-[130px] truncate text-xs font-medium text-ink-200">
            {payload.title || '提詞浮層'}
          </span>
        </div>

        {/* 顯示模式切換 */}
        <div
          className="ml-0.5 flex items-center gap-0.5 rounded-lg bg-white/5 p-0.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {MODES.map((m) => (
            <ToolBtn
              key={m.id}
              title={`模式:${m.label}`}
              active={displayMode === m.id}
              onClick={() => setMode(m.id)}
            >
              <m.icon size={12} />
            </ToolBtn>
          ))}
        </div>

        <div className="flex-1" />

        <div
          className="flex items-center gap-0.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <span className="mr-1.5 select-none font-mono text-[10px] text-ink-400">
            {formatDuration(elapsedSec)}
            {remainingMs !== null && ` / -${formatDuration(remainingMs / 1000)}`}
          </span>

          {/* Panic 救援:被問倒時即時給答案(Alt+P)*/}
          <ToolBtn
            title="Panic 救援:即時回答要點(Alt+P)"
            active={panicPhase !== 'idle'}
            onClick={triggerPanic}
          >
            <Siren size={13} className={panicPhase === 'thinking' ? 'animate-pulse' : undefined} />
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
                title="語速 -"
                onClick={() =>
                  void patchOverlay({ rate: Math.max(0.5, Math.round((o.rate - 0.1) * 10) / 10) })
                }
              >
                <ChevronLeft size={13} />
              </ToolBtn>
              <span className="w-9 select-none text-center font-mono text-[10px] text-ink-400">
                {(o.rate ?? 1).toFixed(1)}×
              </span>
              <ToolBtn
                title="語速 +"
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
              <span className="w-9 select-none text-center font-mono text-[10px] text-ink-400">{o.speed}</span>
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
            />
          )}
          {displayMode === 'phrase' && <PhraseSurface model={model} state={state} fontSize={o.fontSize} />}
          {displayMode === 'bullet' && <BulletSurface model={model} state={state} fontSize={o.fontSize} />}
          {displayMode === 'karaoke' && <KaraokeSurface model={model} state={state} fontSize={o.fontSize} />}

          {/* 跟讀狀態條 */}
          {followStatus !== 'idle' && (
            <div className="pointer-events-none absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-[10px] text-ink-200">
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
        <div className="flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-ink-400">
          尚未載入講稿
          <br />
          到主視窗「提詞講稿」頁按「開始提詞」
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
