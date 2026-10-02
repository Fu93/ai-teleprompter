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
  MicOff,
  MessageCircleQuestion,
  Minimize2,
  MousePointerClick,
  Pause,
  Play,
  ScanEye,
  ScanFace,
  Siren,
  X,
  Crosshair
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
import { LENS_SIZE, useMorph } from './useMorph'
import { pillFitOf, pillKeywordCharsOf, pillSizeOf } from '@shared/overlayShapes'
import { useGlassRefraction } from './useGlassRefraction'
import { OverlayDebugRoot } from './DebugHud'
import { registerAuditControl } from '../lib/auditBridge'
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

/**
 * 島的事件文案:島只有一行,而事件訊息（例如「該你說話了 — 對方在等你回答」）
 * 一定放不下。這個專案的鐵律是「降級取代截斷」—— 截斷會讓使用者永遠不知道
 * 被切掉的是什麼，所以取第一個語意片段（破折號／逗號前），完整文字由呼叫端
 * 放進 title，展開面板則顯示全文。
 */
function pillEventText(text: string): string {
  const head = text.split(/ — |—|，|,|\(/)[0]
  return (head || text).trim()
}

export default function OverlayApp(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [payload, setPayload] = useState<OverlayShowPayload>({})

  /**
   * 浮層視窗的實際寬度(px)。
   *
   * 為什麼藥丸/貼鏡需要它:這兩個形態是「固定一列的東西裝進一個可以被拖曳的
   * 視窗」。內容一多就一定有人被裁掉,而裁掉的是最右邊那顆 —— 也就是展開鈕,
   * 藥丸唯一的出口。所以把次要資訊依寬度漸進隱藏:先時計、再「下一個關鍵詞」,
   * 但展開/播放/Panic 三顆永遠留著。
   */
  const [winW, setWinW] = useState(() => window.innerWidth)
  /**
   * 稽核專用:強制藥丸列的可選內容(見下方 registerAuditControl 的註解)。
   * null = 正常運作,一切走真實狀態。打包版永遠是 null —— initAuditBridge 只在
   * appInfo().audit === true 時才掛 window.__auditForce,而打包版不會是 true。
   */
  const [auditPill, setAuditPill] = useState<{ keyword: string; bars: boolean } | null>(null)

  /**
   * 稽核控制項:把藥丸列「本來到不了的可選內容」塞進來。
   *
   * 為什麼需要:「關鍵詞 + 跟讀音柱 + 一顆不夠寬的視窗」正是展開鈕被裁掉的那個狀態,
   * 而它**沒有任何 UI 走得到** —— 關鍵詞要真的播放到某個位置才有值,音柱要真的
   * 開著麥克風跟讀才會出現,窄視窗要真的用滑鼠拖。稽核環境三者都不成立,於是這個
   * 狀態從來沒被量過 —— 而它就是被裁掉的那一個。這是本專案第二次栽在
   * 「深狀態從來沒被渲染過」上,所以這次直接把它變成可到達。
   *
   * 這也補上一個結構性缺口:浮層是唯一沒有任何 registerAuditControl 的視窗,
   * 而它恰恰是缺陷最密集的地方。
   *
   * arg: { keyword: string; bars: boolean }。傳 null 復原。
   */
  useEffect(
    () =>
      registerAuditControl('overlay.pillContent', (arg) => {
        const a = arg as { keyword?: unknown; bars?: unknown } | null
        if (a === null || a === undefined) {
          setAuditPill(null)
          return true
        }
        if (typeof a !== 'object') return false
        setAuditPill({ keyword: String(a.keyword ?? ''), bars: Boolean(a.bars) })
        return true
      }),
    []
  )
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
  // 抽成變數:除錯層要顯示「滑桿倍率 → 實際倍率」的換算,不該重算一份
  const effectiveRate = effectiveEngineRate(
    o?.rate ?? 1,
    settings?.personal.profile?.charsPerMin,
    PhraseVisuals.DEFAULT_WPM
  )
  const { state, model, remainingMs, progress, measured, controls } = useTeleprompterEngine({
    content,
    displayMode,
    rate: effectiveRate,
    scrollSpeed: o?.speed ?? 60,
    scrollElRef: scrollRef,
    // 形態要進 measureKey:藥丸(收合)沒有捲動容器,展開時容器才第一次掛上來。
    // 若只把字體/行高放進來,效果不會重跑 —— 展開後引擎仍然拿著「沒有量測」的
    // 狀態,於是永遠停在 completed(見 engine.ts tickScroll 的說明)。
    measureKey: `${o?.fontSize ?? 30}|${o?.lineHeight ?? 1.5}`,
    surface: o?.compact ? 'pill' : o?.lensMode ? 'lens' : 'expanded'
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

  /**
   * 浮層被隱藏 → 自動停止語音跟讀。
   *
   * 為什麼:隱藏只是把視窗藏起來,renderer 照常執行 —— 跟讀中的 AudioSegmenter 與
   * Whisper worker 會繼續開著麥克風、繼續轉錄使用者的每一句話,而畫面上完全沒有
   * 任何指示(連指示燈都看不到)。使用者按熱鍵「關掉提詞機」時要的是它閉嘴,不是
   * 讓它變成背景錄音機。
   *
   * 恢復顯示時不自動續跟:重新開麥克風必須是一個明確的動作(要再按一次跟讀),
   * 但也不能默默什麼都不說 —— 使用者回來看到跟讀自己停了,會以為是壞掉。所以
   * 記一則提示,在他下次看到浮層時顯示。
   */
  const [followNotice, setFollowNotice] = useState('')
  const pendingFollowNoticeRef = useRef('')
  useEffect(() => {
    const off = window.api.onOverlayVisibility((visible) => {
      if (visible) {
        if (pendingFollowNoticeRef.current) {
          setFollowNotice(pendingFollowNoticeRef.current)
          pendingFollowNoticeRef.current = ''
        }
        return
      }
      const st = followStatusRef.current
      if (st !== 'listening' && st !== 'loading') return
      follow.stopFollow()
      pendingFollowNoticeRef.current = '浮層隱藏時已自動停止語音跟讀（麥克風已關閉）'
    })
    return off
    // stopFollow 是 useCallback([])、followStatusRef 是 ref:兩者都不隨 render 變動,
    // 所以這裡只會訂閱一次。傳整個 follow 物件會每 render 重新訂閱。
  }, [follow.stopFollow, followStatusRef])

  // 提示顯示 6 秒後自行消失(它只是告知,不需要使用者處理)
  useEffect(() => {
    if (!followNotice) return
    const t = setTimeout(() => setFollowNotice(''), 6000)
    return () => clearTimeout(t)
  }, [followNotice])

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

  // ---- 進度條寬度:rAF 直寫 ----
  //
  // 為什麼不交給 CSS transition:連續變更被引擎節流在 5Hz(CONTINUOUS_NOTIFY_INTERVAL_MS),
  // 而 transition 的長度與節流間隔同量級 —— 播放中的每一幀幾乎都處在「transition 剛被
  // 重新啟動」的狀態,getAnimations() 因此永遠非空。專案的 DOM 稽核規則
  // animation-unsettled 把這種元素判成「量到的是過渡態」,而那不是誤報:截圖真的永遠
  // 拍不到穩定的一帧,稽核腳本只要取樣時剛好在播放就會紅燈(展開形態的進度條本來
  // 就是這個寫法,只是先前的稽核狀態還沒踩到播放中)。
  // 使用者視角試用就是在播放中的藥丸上踩到的。
  //
  // 改為每幀直寫寬度(與 scrollPos / voiceBars 同一套做法):
  //   - 播放/跟讀中 → 60fps 平滑,且不產生任何常駐動畫
  //   - 其他時候 → 由 JSX 的 inline width 決定(React 每次 render 都會寫)
  // 兩個形態共用同一個 ref:藥丸與展開/貼鏡是互斥的分支,同時間只會有一個在畫面上。
  const progressTrackRef = useRef<HTMLDivElement | null>(null)
  const progressValueRef = useRef(0)
  const playing = state?.status === 'playing'
  const following = followStatus === 'listening' || followStatus === 'loading'
  const shownProgress = followChunks ? followProgress : progress
  progressValueRef.current = shownProgress
  useEffect(() => {
    if (!playing && !following) return
    let raf = 0
    const tick = (): void => {
      const el = progressTrackRef.current
      if (el) el.style.width = `${progressValueRef.current * 100}%`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, following])

  // ---- 視窗寬度追蹤(排版用,不落盤)----
  useEffect(() => {
    const onResize = (): void => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

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
      // 焦點在工具列按鈕上時不要把按鍵吃掉:空白鍵會「同時」觸發該按鈕與播放/暫停,
      // 變成一個按鍵做兩件事(例如把「收合成藥丸」連同播放一起切換)。
      // 方向鍵同理 —— 留在按鈕上當作一般的按鈕操作。
      const target = e.target as HTMLElement | null
      if (target?.closest?.('button, input, select, textarea, [role="button"]')) return
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

  const { morphSize, enterCompact, exitCompact, enterLens, exitLens, morphing } = useMorph({ patchOverlay })

  // ── Liquid Glass 真折射(P2-13)──
  // morphing 傳進去:動畫途中位移圖快取的是舊尺寸/舊半徑,那時候套折射會把背景
  // 往錯的方向推(一瞬間的扭曲)。收斂後立刻重建再掛回來,見 hook 說明。
  const { refractOk, specRef } = useGlassRefraction(o?.glass ?? false, morphing)

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

  /**
   * 啟動時把視窗尺寸對齊還原後的形態。
   *
   * 形態(compact / lensMode)現在會跨啟動保留(見 src/main/settings.ts),
   * 但視窗是在 renderer 掛載之前就以設定裡的 width/height 建好的 ——
   * 而那個寬高存的是「展開時的尺寸」(morph 定案時刻意寫回展開值,
   * 以便退出藥丸時知道要還原到多大)。直接沿用會出現「藥丸的內容裝在展開的
   * 視窗裡」:一顆小藥丸躺在 720×260 的暗色方塊中。
   *
   * 用 overlaySetSizeLive 而不是 overlaySetSize:後者會把藥丸尺寸寫回
   * settings.overlay.width/height,下次「展開」就會展開成藥丸大小。
   * Live 版本只改記憶體中的尺寸,正好符合「這是本次執行的顯示狀態,
   * 不是使用者選的展開尺寸」。
   */
  const restoredShapeRef = useRef(false)
  /**
   * Panic 在岛模式下自動展開。
   *
   * 島上沒有救援卡的版面(42px 高的胶囊只能放一行字),先前在岛模式按救援
   * 只會看到「救援卡顯示中 — 點鈴鐺關閉」—— 使用者主動求援卻拿不到任何內容,
   * 而救援正是這個 App 最不想失敗的功能。寫成「看 panicPhase」而不是包在按鈕的
   * onClick 裡:Alt+P 全域熱鍵是由 main 直接廣播的,不經過按鈕那條路。
   */
  const panicAutoExpandedRef = useRef(false)
  useEffect(() => {
    if (!o) return
    if (panicPhase === 'idle') {
      panicAutoExpandedRef.current = false
      return
    }
    if (o.compact && !panicAutoExpandedRef.current) {
      panicAutoExpandedRef.current = true
      exitCompact()
    }
  }, [panicPhase, o, exitCompact])

  useEffect(() => {
    if (!o || restoredShapeRef.current) return
    restoredShapeRef.current = true
    // 藥丸尺寸要跟 pillScale 一致:還原時用 1.00× 的常數會讓「上次用了 1.2×」
    // 的藥丸先以一顆小島出現，下一次 morph 才跳到正確大小。
    if (o.compact) {
      const pill = pillSizeOf(o.pillScale)
      void window.api.overlaySetSizeLive(pill.w, pill.h)
    } else if (o.lensMode) void window.api.overlaySetSizeLive(LENS_SIZE.w, LENS_SIZE.h)
  }, [o])

  if (!o || !state) {
    return <div className="h-full" />
  }

  const elapsedSec = state.elapsedMs / 1000
  const isBullet = displayMode === 'bullet'
  const isTimedMode = displayMode === 'phrase' || displayMode === 'karaoke'
  // 「這條線現在有沒有東西可顯示」。
  //
  // 逐句/卡拉OK 的進度由索引算得,不需要量測;連續捲動不然 —— 使用者視角試用
  // 發現的實際情況:收合成藥丸後換稿(藥丸沒有捲動容器,永遠量不到),播放中仍
  // 讓一條永遠 0% 的線貼在底緣,比完全不畫更糟:它看起來像「講稿還在第一行」,
  // 而畫面上沒有任何東西可以讓使用者發現那是假的。展開後就會量到、線就回來了。
  const progressKnown = displayMode !== 'scroll' || measured

  // 除錯層(預設關閉;Ctrl+Shift+D 開 HUD)。以 portal 掛到 body,
  // 不參與這裡的 flex 版面 —— 貼鏡模式只有 170px,多任何一層都會把正文擠掉。
  const debugLayer = (
    <OverlayDebugRoot
      data={{
        mode: displayMode,
        compact: o.compact,
        lens: o.lensMode,
        mirror: o.mirror,
        opacity: o.opacity,
        fontSize: o.fontSize,
        status: state.status,
        sentenceIndex: state.sentenceIndex,
        phraseIndex: state.phraseIndex,
        karaokeChunkIndex: state.karaokeChunkIndex,
        bulletIndex: state.bulletIndex,
        elapsedMs: state.elapsedMs,
        scrollPos: state.scrollPos,
        rate: o.rate,
        effectiveRate,
        followStatus,
        followChunk: activeChunk,
        followProgress,
        lastHeard,
        glass: o.glass,
        refractOk,
        captureProtected: o.captureProtected,
        clickThrough: o.clickThrough,
        alwaysOnTop: o.alwaysOnTop,
        contentLen: content.length,
        sentences: model.sentences.length,
        phrases: model.phrases.length,
        bullets: model.bullets.length
      }}
    />
  )

  if (o.compact) {
    // 漸進揭露:pill 顯示「下一個關鍵詞」(各模式游標的下一單元開頭);
    // 精度降級取代截斷:寬度不足時降為前 4 字,永不出現「…」
    const fit = pillFitOf(o.pillScale, winW)
    let nextKeyword = ''
    if (displayMode === 'phrase' || displayMode === 'scroll') {
      const phrases = model.phrases[state.sentenceIndex] ?? []
      const next = phrases[state.phraseIndex + 1] ?? (model.sentences[state.sentenceIndex + 1] ?? '')
      // 保留完整文字:字數由這個視窗的寬度預算決定,所以不能在這裡就 degrade
      nextKeyword = (typeof next === 'string' ? next : next.text).trim()
    } else if (displayMode === 'karaoke') {
      nextKeyword = (model.karaokeChunks[state.karaokeChunkIndex + 1] ?? '').trim()
    } else if (displayMode === 'bullet') {
      nextKeyword = (model.bullets[state.bulletIndex + 1]?.title ?? '').trim()
    }
    // 降級順序:關鍵詞縮字數 → 音柱消失 → 三顆按鈕永不動(展開鈕是藥丸唯一的出口)。
    //
    // 這裡**不能**用「設計寬 × 0.94」那種比例門檻:它與實際內容寬度無關,所以
    // 視窗一比設計寬窄就失準 —— 而窄視窗正是內容被擠爆的時候。實測(稽核的
    // overlay.pill.Nx.loaded note):0.8× 的 256px 視窗裡,內容層被壓到 120px
    // 而內容需要 188px,關鍵詞、音柱與標題疊在一起;連預設的 1.00×(320px)都差 4px。
    //
    // 縮字數而不是整個隱藏:1.00× 裝得下五個字(需要 324 但有 320),
    // 用二元的顯示/隱藏會讓預設倍率也失去這個功能。
    // 稽核覆寫只在 auditPill 非 null 時生效(見上方 registerAuditControl 的註解)
    const kwChars = pillKeywordCharsOf(winW)
    const effKeyword = auditPill ? auditPill.keyword : nextKeyword
    const effFollowing = auditPill ? auditPill.bars : followStatus === 'listening'
    const shownKeyword = effKeyword === '' ? '' : degrade(effKeyword, kwChars)
    const showPillKeyword = shownKeyword !== '' && fit.keyword
    const showVoiceBars = effFollowing && fit.voiceBars
    // 藥丸的資訊預算:展開鈕永遠留著,其次才是「下一個關鍵詞」;計時器在展開面板的工具列 ——
    // 島的留白本身就是設計,把能讓的都讓出去比塞滿更像島。
    //
    // 島上只有一條訊息通道(事件主角),所以「跟讀狀態條」的訊息要在這裡補位:
    //   展開面板底部有 followMsg / followNotice,而島模式的药丸不渲染那一區 ——
    //   於是「隱藏時自動停止跟讀（麥克風已關閉）」與「跟讀啟動失敗」對用島的人
    //   來說是完全靜默的（那正是上一輪修隱私問題要解掉的狀況,卻只在藥丸下復發）。
    //   事件(該你說話了/教練)優先:它是即時且會自行退場的;跟讀訊息沒有急迫性。
    const pillFollowMsg = followNotice
      ? { kind: 'notice' as const, text: followNotice }
      : followStatus === 'error'
        ? { kind: 'error' as const, text: followMsg || '跟讀啟動失敗' }
        : followStatus === 'loading'
          ? { kind: 'loading' as const, text: followMsg || '跟讀載入中…' }
          : null
    // drag region 會吞掉滑鼠事件:雙擊展開不再可用,以展開按鈕取代(拖曳價值更高)
    return (
      <div
        ref={specRef}
        data-overlay-surface="pill"
        className={cn(
          'dynamic-island-pill glass-pill lg-rim flex h-full cursor-default select-none items-center gap-2 rounded-full px-3.5',
          // 半徑插值:切換形態時兩邊是不同元素,進入的那一邊必須從「對方形態的半徑」
          // 起步(藥丸 rounded-full = 高一半、展開/貼鏡 overlay-radius = 20px),
          // 否則 morph 的頭一帧就是半徑瞬間跳一格。公式在 global.css 的 .is-shape-morphing。
          morphing && 'is-shape-morphing',
          refractOk && o.glass && !morphing && 'glass-refract'
        )}
        title="拖曳可移動位置（大小在設定頁的「藥丸大小」調整）"
        onDoubleClick={exitCompact}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {debugLayer}
        {/* 進度:島的處理方式是「一條貼著底緣的細線」,不是一條撐滿中間的橫條 ——
            後者是「一條 bar」的讀感來源之一,而且它把整個 flex 版面撐成 460 寬。
            只在下方 2px、且只在播放/跟讀中出現(待機時 opacity 0),不參與 flex 版面。 */}
        <div
          data-pill-progress="1"
          className={cn(
            'pointer-events-none absolute bottom-[1px] left-3 right-3 h-[2px] overflow-hidden rounded-full bg-white/10 transition-opacity duration-200',
            following || (playing && progressKnown) ? 'opacity-100' : 'opacity-0'
          )}
        >
          <div
            ref={progressTrackRef}
            className="h-full rounded-full bg-gradient-to-r from-accent-400 to-accent-600"
            style={{ width: `${shownProgress * 100}%` }}
          />
        </div>
        {/* 內容層:形狀切換時新內容的入場(舊內容在切換那一帧已經卸載,所以是單層淡入)。
            這一層絕對不能掛在 root 上:root 帶著 animation `both` + 120ms delay 的話,
            morph 的前 120ms 整顆膠囊是空白的(視窗已經縮小、內容還沒出現)。
            按鈕留在這一層之外:它們是控制項,不該跟著淡入。 */}
        <div className="di-content-in flex min-w-0 flex-1 items-center gap-2">
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
            {/* 島只有一行 162px 的寬度(320 藥丸扣掉圖示與三顆按鈕),而事件文案
                例如「該你說話了 — 對方在等你回答」一定放不下。截斷是這專案明確
                要避免的失敗模式(使用者永遠不知道被切掉的是什麼),所以取第一個
                語意片段(破折號/逗號前),完整文字留在 title,展開面板顯示全文。 */}
            <span className="truncate text-[13px] font-medium text-white/95" title={shownEvent.text}>
              {degrade(pillEventText(shownEvent.text), 12)}
            </span>
          </div>
        ) : pillFollowMsg ? (
          <div
            className="di-content-in flex min-w-0 flex-1 items-center gap-1.5"
            title={pillFollowMsg.text}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {pillFollowMsg.kind === 'loading' ? (
              <Loader2 size={12} className="shrink-0 animate-spin text-emerald-300" />
            ) : (
              <MicOff
                size={12}
                className={cn('shrink-0', pillFollowMsg.kind === 'error' ? 'text-rose-300' : 'text-amber-300')}
              />
            )}
            <span
              className={cn(
                'truncate text-[12px] font-medium',
                pillFollowMsg.kind === 'error' ? 'text-rose-200' : 'text-amber-200'
              )}
            >
              {degrade(pillFollowMsg.text, 12)}
            </span>
          </div>
        ) : (
          <>
            <span
              data-pill-dot="1"
              // 狀態改用小圓點表達(iOS 靈動島的方式):待機時不發光、
              // 播放時一個綠點。原先的彩色呼吸光暈已移除,這裡是唯一的狀態指示。
              // 待機色從 bg-ink-600(#3a4256,幾乎看不見)改成 white/25,
              // 否則在沒有光暈襯底之後會整個消失在深色藥丸裡。
              // 「已播畢」原本與「待機」一樣是灰點(使用者視角試用發現:稿子講完了
              // 跟從沒開始長得一模一樣),現在用琥珀點 + title 區分。
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                o.clickThrough
                  ? 'bg-amber-450'
                  : playing
                    ? 'bg-emerald-400'
                    : state.status === 'completed'
                      ? 'bg-amber-450/80'
                      : 'bg-white/25'
              )}
              title={
                o.clickThrough
                  ? '滑鼠穿透中:熱鍵或主視窗「提詞」按鈕重新顯示時自動解除'
                  : playing
                    ? '播放中'
                    : state.status === 'completed'
                      ? '已播畢'
                      : '待機'
              }
            />
            {/* 這一列的規則:尺寸固定的內容一律 shrink-0,只有標題可以截斷。
                沒有 min-w 下限時,flex-shrink 會把標題壓成 16px 寬的細條 ——
                max-w 是上限不是下限,給了它等於沒給。視窗拖到最小時實測如此。 */}
            <span
              className="min-w-[3.5rem] max-w-[110px] truncate text-xs font-medium text-white/100"
              // 標題被截斷的可能仍然存在(使用者可自己把視窗拖寬),給 title 讓滑鼠停留看得到全文;
              // 沒有它就是「顯示了半個字、且使用者永遠不知道被截掉的是什麼」
              title={payload.title || '提詞浮層'}
            >
              {degrade(payload.title || '提詞浮層', 8)}
            </span>
            {showVoiceBars && (
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
            {showPillKeyword ? (
              // shrink-0 + nowrap:沒有這兩個時,最小視窗下它被壓到 11px 寬,
              // 每個中文字各佔一行變成 66px 高,直接溢出視窗
              <span
                className="shrink-0 whitespace-nowrap text-[11px] text-accent-300"
                title={`下一個:${effKeyword}`}
              >
                {shownKeyword}
              </span>
            ) : (
              // 同一個資訊槽的另一種用途:沒有「下一個關鍵詞」時(講到最後一句、
              // bullet 沒有標題、逐詞模式走到 chunk 尾)那塊本來就是空的 ——
              // 把計時器放回來比留一片空白好(使用者視角試用:島上完全看不到時間)。
              <span className="shrink-0 font-mono text-[10px] text-white/60" title="已播時間">
                {formatDuration(elapsedSec)}
              </span>
            )}
          </>
        )}
        </div>
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
        data-overlay-surface="lens"
        className={cn(
          'glass-overlay lg-rim relative flex h-full flex-col overflow-hidden overlay-radius',
          // 從藥丸進來時,這一邊要從膠囊半徑起步再收到面板半徑(見 .is-shape-morphing)
          morphing && 'is-shape-morphing'
        )}
        style={{ background: `rgba(12, 14, 20, ${Math.max(0.25, Math.min(0.9, o.opacity))})` }}
      >
        {debugLayer}
        <div
          className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 px-2"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <span
            className={cn('h-1.5 w-1.5 rounded-full', playing ? 'bg-emerald-500' : 'bg-ink-600')}
          />
          <span className="flex-1" />
          {/* 角落吸附:貼到螢幕上緣,離鏡頭軸線最近。
              貼鏡的寬度下限就是它的設計寬度(420),所以這一段只會在「morph 動畫
              途中」遇到更窄的視窗 —— 那時候先讓位的應該是三顆角落鈕,而不是
              右邊的退出/pause/隱藏。 */}
          {winW >= 400 && (
          <div
            className="flex items-center gap-1"
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
                title={`浮層吸附到螢幕${c.label.replace(/[^一-龥]/g, '')}`}
                className="rounded-full bg-white/8 px-2 py-2 text-[10px] text-white/72 transition-colors hover:bg-white/15 hover:text-white/72 cursor-pointer whitespace-nowrap"
              >
                {c.label}
              </button>
            ))}
          </div>
          )}
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
        {/* 角落吸附的按鈕改放在上方工具列的空白處(見下方註解) */}
        <LensSurface
          model={model}
          state={state}
          displayMode={displayMode}
          // 預讀行與所有暫態提示是絕對定位的同一段高度:任一條出現都先收起,
          // 否則 turn-yield / coaching 會直接疊印在「下一句」上(與 lensHint 同型缺陷)
          suppressBottom={(lensHint || !!turnYieldHint || !!coachingHint) && panicPhase === 'idle'}
        />
        {/* 角落吸附:貼到螢幕上緣,離鏡頭軸線最近。
            原本是 absolute top-9 浮在正文上方,實測把第一行提詞文字整行蓋住;
            改成把正文往下讓位(pt-8)又會把底部的「下一句」擠出 170px 的視窗。
            貼鏡視窗只有 420x170,扣掉工具列 36px、底部提示 22px 後,
            「下一句/再下一句」再吃掉 40px,留給正文只剩 70px ——
            沒有任何浮層層能再吃高度。所以這三顆按鈕改放進工具列的空白處
            (原本是 flex-1 spacer,什麼都沒放),不再占用正文空間。*/}
        {null}
        {/* 貼鏡只有 170px 高:救援卡顯示中時先把這兩條提示收起來。
            三者都在絕對定位的同一段高度上,疊在一起會讓救援句的可讀性變差,
            而救援永遠比提醒重要(提示條本身也會自己重播)。 */}
        {lensHint && panicPhase === 'idle' && (
          <div className="pointer-events-none absolute inset-x-3 bottom-1.5 z-10 rounded-full bg-black/60 px-3 py-1 text-center text-[10px] text-white/72">
            把這條貼到攝影機 5cm 內 — 眼神會自然對準鏡頭,錄起來不像看稿
          </div>
        )}
        {panicPhase === 'idle' && (turnYieldHint || coachingHint) && (
          <div className="pointer-events-none absolute inset-x-3 bottom-8 z-10 flex flex-col items-center gap-1.5">
            {turnYieldHint && (
              <div className="flex items-center justify-center gap-1.5 rounded-full bg-sky-500/20 px-3 py-1 text-[10px] font-medium text-sky-300">
                <MessageCircleQuestion size={11} /> {turnYieldText}
              </div>
            )}
            {/* 教練提示在藥丸與展開分支都會出現,貼鏡原本漏了 ——
                語速過快/填充詞/冷場恰好在最像簡報的場景無聲。樣式對齊另外兩形態。 */}
            {coachingHint && (
              <div className="flex items-center justify-center gap-1.5 rounded-full bg-amber-500/20 px-3 py-1 text-[10px] font-medium text-amber-300">
                <Gauge size={11} /> {coachingHint.message}
              </div>
            )}
          </div>
        )}
        {panicPhase !== 'idle' && (
          <RescueCard
            phase={panicPhase}
            rescue={rescue}
            errorMsg={errorMsg}
            onDismiss={dismissRescue}
            compact
          />
        )}
      </div>
    )
  }

  // 跟讀狀態條:文字與可見性抽成變數,內容 / title 屬性共用一份 ——
  // 兩處各寫一次三元式遲早分叉,而截斷後沒有 title 就是看不到全文
  const followBarText =
    followStatus === 'idle'
      ? followNotice || ''
      : followMsg ||
        (followStatus === 'listening'
          ? lastHeard || '聆聽中…'
          : followStatus === 'error'
            ? '跟讀啟動失敗'
            : '')
  const followBarVisible = followStatus !== 'idle' || !!followNotice

  return (
    <div
      data-overlay-surface="expanded"
      className={cn(
        'glass-overlay lg-rim relative flex h-full flex-col overflow-hidden overlay-radius',
        // 從藥丸進來時,這一邊要從膠囊半徑起步再收到面板半徑(見 .is-shape-morphing)
        morphing && 'is-shape-morphing'
      )}
      style={{ background: `rgba(12, 14, 20, ${Math.max(0.25, Math.min(0.9, o.opacity))})` }}
    >
      {debugLayer}
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
          <span
            className="max-w-[130px] truncate text-xs font-medium text-white/72"
            // 藥丸分支同欄位有 title;這裡沒有就是「截斷了但看不到全文」
            // (專案自己的 truncated-no-label 規則,講稿標題可長到 130px 裝不下)
            title={payload.title || '提詞浮層'}
          >
            {payload.title || '提詞浮層'}
          </span>
        </div>

        {/* 顯示模式切換(iOS 分段控件)*/}
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Segmented
            ariaLabel="顯示模式"
            options={MODES.map((m) => ({ id: m.id, label: '', icon: <m.icon size={13} />, title: `模式:${m.label}` }))}
            value={displayMode}
            onChange={setMode}
          />
        </div>

        <div className="min-w-0 flex-1" />

        {/* 工具列。預設浮層寬 720px,這裡卻塞了計時器 + 18 顆左右,
            實測需要 551px 而可用空間只有約 422px。根節點是 overflow-hidden,
            多出來的 113px 直接被裁掉 —— 最右側的「速度 +」等按鈕落在視窗外,
            既看不到也點不到。
            外面包一層可橫向捲動的殼,內層用 w-max 撐出 max-content 寬度。
            只加 overflow-x-auto 沒用:捲動容器裡的 block 子元素會被壓成
            容器寬度,而 flex 子項預設可以收縮,於是按鈕被擠成 20px 寬的長條
            而不是捲動 —— 換個方式壞而已。*/}
        <div
          className="min-w-0 shrink overflow-x-auto"
          data-allow-h-scroll="1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="flex w-max items-center gap-0.5">
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

          {/* 置中:拔螢幕/改解析度後浮層可能跑到看得到的地方之外,
              自動防護只能接「遮住最多」的那台,使用者需要手動拉回主螢幕的出口 */}
          <ToolBtn title="浮層置中(找不到浮層時按這裡)" onClick={() => void window.api.recenterOverlay()}>
            <Crosshair size={13} />
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

          {/* 跟讀狀態條;跟讀已停止時的提示也走同一條(見 onOverlayVisibility 的自動停止) */}
          {followStatus !== 'idle' || followNotice ? (
            <div className="pointer-events-none absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-[10px] text-white/72">
              {followStatus === 'loading' && <Loader2 size={10} className="animate-spin" />}
              {followStatus === 'listening' && <AudioLines size={10} className="text-emerald-400" />}
              <span className="max-w-[280px] truncate" title={followBarText || undefined}>
                {followBarText}
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-white/52">
          尚未載入講稿
          <br />
          到主視窗「提詞講稿」頁按「開始提詞」
        </div>
      )}

      {/* 即時回饋提示條(turn-yield 藍 / coaching 琥珀;堆疊避免同時觸發時互相遮擋)。
          救援卡顯示中時不畫:兩者在 260px 的視窗裡會疊到同一段高度(卡片是 z-30
          且不透明),被蓋住的提示文字就變成一個真的會被稽核抓到的遮擋缺陷。
          救援永遠比提醒重要,而提示條本來就會重播。 */}
      {panicPhase === 'idle' && (turnYieldHint || coachingHint) && (
        <div
          // 跟讀狀態條佔著 bottom 1.5–30px:提示 pill 從 bottom-4 起跳會與它疊印,
          // 兩者都是暫態,同時出現時兩行都讀不了 → 條存在時提示上移避讓
          className={cn(
            'pointer-events-none absolute inset-x-4 z-20 flex flex-col items-center gap-2',
            followBarVisible ? 'bottom-12' : 'bottom-4'
          )}
        >
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

      {/* 進度條(軌道用暗色:底部 2px 亮軌在深色內容上讀作白邊;
          填充的寬度由 progressTrackRef 每帧直寫,見上面的說明)*/}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-[3px] bg-black/30">
        <div
          ref={progressTrackRef}
          data-overlay-progress="1"
          className="h-full bg-gradient-to-r from-accent-400 to-accent-600"
          style={{ width: `${shownProgress * 100}%` }}
        />
      </div>
    </div>
  )
}
