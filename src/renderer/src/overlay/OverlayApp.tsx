import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  FlipHorizontal2,
  Gauge,
  Hand,
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
  X
} from 'lucide-react'
import type { AppSettings, OverlayDisplayMode } from '@shared/types'
import type { OverlayShowPayload } from '@shared/api'
import { cn, degrade, formatDuration } from '../lib/utils'
import { PhraseVisuals } from '../lib/teleprompter/constants'
import { effectiveEngineRate } from '../lib/calibration'
import { useTeleprompterEngine } from './useTeleprompterEngine'
import { usePanic } from './usePanic'
import { useTurnYield } from './useTurnYield'
import { useCoaching } from './useCoaching'
import { useFollowMode } from './useFollowMode'
import { useLiveEvents } from './useLiveEvents'
import { useMorph } from './useMorph'
import { useGlassRefraction } from './useGlassRefraction'
import { RescueCard } from './RescueCard'
import { Segmented } from '../components/Segmented'
import {
  BulletSurface,
  KaraokeSurface,
  LensSurface,
  MODES,
  PhraseSurface,
  ScrollSurface,
  ToolBtn
} from './Surfaces'

export default function OverlayApp(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [payload, setPayload] = useState<OverlayShowPayload>({})

  // 換稿自動播放旗標:實際 play 延到 content 變化後的 effect(引擎已重建),
  // 立即 play 會落在舊引擎上、隨即被新引擎實例替換吃掉
  const autoPlayRef = useRef(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  // ---- 初始化 ----
  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    void window.api.getSettings().then(setSettings)
    void window.api.overlayGetLastPayload().then(setPayload)
    const offScript = window.api.onOverlayLoadScript((p) => {
      setPayload(p)
      follow.resetProgress()
      // 主視窗「開始提詞」= 打開就開始講;實際 play 在 content 變化後的 effect
      autoPlayRef.current = true
    })
    const offSettings = window.api.onSettingsChanged(setSettings)
    return () => {
      offScript()
      offSettings()
    }
  }, [])

  const content = payload.content ?? ''

  // ---- 四模式定時引擎 ----
  const o = settings?.overlay
  // 熱鍵提示動態化:自訂熱鍵後工具列文案不再過期(與側欄熱鍵提示同一教訓,這裡是同族漏網)
  const panicKey = settings?.hotkeys.panicRescue ?? 'Alt+P'
  const toggleKey = settings?.hotkeys.toggleOverlay
  const toggleHint = toggleKey ? `${toggleKey.replaceAll('Control', 'Ctrl')} 可再開` : '於設定頁設定熱鍵後可再開'
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

  // ---- 即時教練(Phase B+):語速過快/填充詞/搶話/冷場/獨白過長 ----
  const { hint: coachingHint } = useCoaching(o?.coaching ?? true)

  const controlsRef = useRef(controls)
  controlsRef.current = controls

  // ---- 語音跟讀(scroll 模式限定:Whisper + chunk 對位)----
  const follow = useFollowMode({
    settings,
    controlsRef,
    scrollRef,
    onMeSpeech: notifyTurnYield
  })
  const { followStatus, followMsg, lastHeard, activeChunk, followProgress, followChunks, toggleFollow, adjustFollowOffset } = follow
  const followStatusRef = follow.followStatusRef
  const followLevelRef = follow.followLevelRef
  const chunkElsRef = follow.chunkElsRef

  // 講稿內容變化 → 重建跟讀索引,並把捲動位置歸零
  // (引擎內部 scrollPos 會重置,但 scroll 模式每幀直寫 DOM,暫停時不會再推,殘影會留在畫面上)
  useEffect(() => {
    follow.rebuildIndex(content)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    // 自動播放:引擎此刻已隨 content 重建,play 才會落在正確的實例上。
    // 語音跟讀進行中則不播:兩套捲動來源(定時引擎 vs STT 對位)會互相拉扯。
    if (autoPlayRef.current) {
      autoPlayRef.current = false
      if (followStatusRef.current === 'idle' && content) controlsRef.current?.play()
    }
  }, [content])

  // ---- 靈動島:事件內容優先序(該你了 > 教練 > panic)----
  // 事件發生時升為藥丸主角,結束後淡出回常规內容
  const turnActive = turnYieldHint !== null
  const coachingActive = coachingHint !== null
  const panicActive = panicPhase === 'rescue'
  const liveEventKind: 'turn' | 'coaching' | 'panic' | null = turnActive
    ? 'turn'
    : coachingActive
      ? 'coaching'
      : panicActive
        ? 'panic'
        : null
  const liveEventText = turnActive
    ? turnYieldText
    : coachingActive
      ? (coachingHint?.message ?? '')
      : panicActive
        ? '救援卡顯示中 — 點鈴鐺關閉'
        : ''
  const { shownEvent, leaving: eventLeaving } = useLiveEvents(liveEventKind, liveEventText)

  // ---- 靈動島藥丸:聲音反應層 ----
  // 音量走 ref + rAF 直接寫 CSS 變數,不經過 React render(每幀 setState 會拖累動畫)
  const voiceBarsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (followStatus !== 'listening') return
    let raf = 0
    const tick = (): void => {
      const el = voiceBarsRef.current
      if (el) el.style.opacity = String(0.3 + Math.min(1, followLevelRef.current * 2) * 0.7)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [followStatus])

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
      if (mode !== 'scroll' && followStatus !== 'idle') follow.stopFollow()
      void patchOverlay({ displayMode: mode })
    },
    [patchOverlay, followStatus, follow.stopFollow]
  )

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

  // ── Liquid Glass 真折射(P2-13)+ pill specular ──
  const { refractOk, specRef } = useGlassRefraction(o?.glass ?? false)

  // ---- 全域熱鍵事件(main 廣播):播放/暫停 + 語速步進 ----
  // 浮層可被滑鼠穿透或失焦,鍵盤控制只剩全域熱鍵這條路
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

  const { morphSize, enterCompact, exitCompact, enterLens, exitLens } = useMorph({ patchOverlay })

  if (!o || !state) {
    return <div className="h-full" />
  }

  const playing = state.status === 'playing'
  const elapsedSec = state.elapsedMs / 1000
  const isBullet = displayMode === 'bullet'
  const isTimedMode = displayMode === 'phrase' || displayMode === 'karaoke'
  const following = followStatus === 'listening' || followStatus === 'loading'
  const shownProgress = followChunks ? followProgress : progress

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
    // 靈動島光暈:顏色講狀態——事件優先(藍該你了/琥珀教練/紅救援),
    // 其次播放中綠、待機灰;穿透永遠琥珀警示
    const diGlow = o.clickThrough
      ? 'rgba(251, 191, 36, 0.5)'
      : shownEvent?.kind === 'turn'
        ? 'rgba(56, 189, 248, 0.55)'
        : shownEvent?.kind === 'coaching'
          ? 'rgba(251, 191, 36, 0.55)'
          : shownEvent?.kind === 'panic'
            ? 'rgba(244, 63, 94, 0.6)'
            : playing
              ? 'rgba(52, 211, 153, 0.45)'
              : 'rgba(148, 163, 184, 0.4)'
    // drag region 會吞掉滑鼠事件:雙擊展開不再可用,以展開按鈕取代(拖曳價值更高)
    return (
      <div
        ref={specRef}
        className={cn(
          'dynamic-island-pill glass-pill content-morph-in glass-specular flex h-full cursor-default select-none items-center gap-3 rounded-full px-4',
          refractOk && o.glass && 'glass-refract'
        )}
        title="拖曳可移動位置"
        onDoubleClick={exitCompact}
        style={{
          WebkitAppRegion: 'drag',
          '--di-glow': diGlow,
          '--di-glow-o': playing || shownEvent ? '0.8' : '0.45'
        } as React.CSSProperties}
      >
        {shownEvent ? (
          // 事件視窗:事件升為主角(字級加大、圖示上色),結束後縮回常规內容;
          // key=at 讓事件輪替時 remount 重播彈入動畫
          <div
            key={shownEvent.at}
            className={cn('flex min-w-0 flex-1 items-center gap-2', eventLeaving ? 'di-event-leaving' : 'di-event')}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {shownEvent.kind === 'turn' && <MessageCircleQuestion size={14} className="shrink-0 text-sky-300" />}
            {shownEvent.kind === 'coaching' && <Gauge size={14} className="shrink-0 text-amber-300" />}
            {shownEvent.kind === 'panic' && <Siren size={14} className="shrink-0 text-rose-400" />}
            <span className="truncate text-[13px] font-medium text-white/95">{shownEvent.text}</span>
          </div>
        ) : (
          <>
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                o.clickThrough ? 'bg-amber-450' : playing ? 'bg-emerald-500' : 'bg-ink-600'
              )}
              title={o.clickThrough ? '滑鼠穿透中:熱鍵或主視窗「提詞」按鈕重新顯示時自動解除' : undefined}
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
            {followStatus === 'listening' && (
              // 跟讀中的聲音反應:三根小柱,亮度隨輸入音量(rAF 直寫 opacity)
              <div
                ref={voiceBarsRef}
                className="di-voice-bars shrink-0 text-emerald-300"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <i />
                <i />
                <i />
              </div>
            )}
            {nextKeyword && (
              <span className="text-[11px] text-accent-300" title={`下一個:${nextKeyword}`}>
                {nextKeyword}
              </span>
            )}
            <span className="shrink-0 font-mono text-[10px] text-white/72">{formatDuration(elapsedSec)}</span>
          </>
        )}
        {panicPhase !== 'idle' ? (
          <button
            onClick={dismissRescue}
            title="救援顯示中 — 點擊關閉"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-rose-500/25 text-rose-400"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Siren size={13} />
          </button>
        ) : (
          <button
            onClick={triggerPanic}
            title={`Panic 救援(${panicKey})`}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/72 hover:bg-white/10 hover:text-white/100"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Siren size={13} />
          </button>
        )}
        <button
          onClick={playing ? controls.pause : controls.play}
          title={playing ? '暫停' : '播放'}
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/72 hover:bg-white/10 hover:text-white/100"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button
          onClick={exitCompact}
          title="展開完整面板"
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/72 hover:bg-white/10 hover:text-white/100"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Maximize2 size={12} />
        </button>
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
            <ToolBtn title={`Panic 救援(${panicKey})`} active={panicPhase !== 'idle'} onClick={triggerPanic}>
              <Siren size={13} />
            </ToolBtn>
            <ToolBtn title={playing ? '暫停' : '播放'} active={playing} onClick={controls.toggle}>
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </ToolBtn>
            <ToolBtn title={`隱藏(${toggleHint})`} onClick={() => void window.api.overlayHide()}>
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

          {/* Panic 救援:被問倒時即時給答案(熱鍵見提示)*/}
          <ToolBtn
            title={`Panic 救援:即時回答要點(${panicKey})`}
            active={panicPhase !== 'idle'}
            onClick={triggerPanic}
          >
            <Siren size={13} className={panicPhase === 'thinking' ? 'animate-pulse' : undefined} />
          </ToolBtn>

          {/* 收合成藥丸 */}
          <ToolBtn title="收合成藥丸(低存在感)" onClick={() => enterCompact(o)}>
            <Minimize2 size={13} />
          </ToolBtn>

          {/* 貼鏡模式 */}
          <ToolBtn
            title="貼鏡模式:貼近攝影機 5cm 內,眼神自然對準鏡頭(建議搭配逐句短語)"
            active={o.lensMode}
            onClick={() => enterLens(o)}
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
            title={o.clickThrough ? '滑鼠穿透:開(浮層已收不到點擊;熱鍵或主視窗「提詞」重新顯示時自動解除)' : '滑鼠穿透:關'}
            active={o.clickThrough}
            onClick={() => void window.api.overlaySetClickThrough(!o.clickThrough)}
          >
            <MousePointerClick size={13} />
          </ToolBtn>
          <ToolBtn title={`關閉(${toggleHint})`} onClick={() => void window.api.overlayHide()}>
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
