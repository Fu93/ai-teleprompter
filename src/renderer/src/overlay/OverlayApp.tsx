import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  BellOff,
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
  Crosshair,
  AppWindow
} from 'lucide-react'
import type { AppSettings, CoachingKind, OverlayDisplayMode } from '@shared/types'
import type { CoachingHint } from './useCoaching'
import type { OverlayShowPayload } from '@shared/api'
import { cn, degrade, formatDuration, formatTransport } from '../lib/utils'
import { PhraseVisuals } from '../lib/teleprompter/constants'
import { effectiveEngineRate } from '../lib/calibration'
import { useTeleprompterEngine } from './useTeleprompterEngine'
import { usePanic } from './usePanic'
import { useTurnYield } from './useTurnYield'
import { useCoaching } from './useCoaching'
import { usePace } from './usePace'
import { useFollowMode } from './useFollowMode'
import { useLiveEvents } from './useLiveEvents'
import { LENS_SIZE, useMorph } from './useMorph'
import { paceReadoutFits, pillFitOf, pillKeywordCharsOf, pillSizeOf, statusBarFits } from '@shared/overlayShapes'
import { useGlassRefraction } from './useGlassRefraction'
import { OverlayDebugRoot } from './DebugHud'
import { registerAuditControl } from '../lib/auditBridge'
import { RescueCard } from './RescueCard'
import { Segmented } from '../components/Segmented'
import {
  BulletSurface,
  Divider,
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
   * 視窗高度:只有一個用途 —— 判斷底部讀數 chip 放不放得下(P4)。
   *
   * 為什麼需要它:讀數是**持續型**的絕對定位元件(每 2 秒更新,不會自己退場),
   * 而展開形態的最小高度(EXPANDED_MIN.h = 40px)比它需要的 77px 還小 —— 拖到
   * 最小又在講話時,它會永久蓋住工具列。門檻與三個來源數字見
   * shared/overlayShapes.ts 的 PACE_READOUT_MIN_H。
   */
  const [winH, setWinH] = useState(() => window.innerHeight)
  /**
   * 稽核專用:強制藥丸列的可選內容(見下方 registerAuditControl 的註解)。
   * null = 正常運作,一切走真實狀態。打包版永遠是 null —— initAuditBridge 只在
   * appInfo().audit === true 時才掛 window.__auditForce,而打包版不會是 true。
   */
  const [auditPill, setAuditPill] = useState<{ keyword: string; bars: boolean } | null>(null)
  /**
   * 稽核專用:強制顯示一則即時教練提示。null = 正常運作。
   *
   * 為什麼需要這個(與 auditPill 同一個理由,只是更極端):教練提示只有真的
   * 說話到那個程度才會出現 —— 語速過快要真的很快、填充詞要真的很多、
   * 冷場要真的停很久。而它帶著這一輪最該被驗的兩個控制項:
   * 「按提示條靜默這一種」與「本場已靜默 N 種」的恢復鈕。
   *
   * 那兩個控制項若沒有探針,效果是:使用者按了靜默鈕之後
   * 「教練還是一直響」與「我明明按過了怎麼又響」兩種狀況在發布閘門裡
   * **完全看不出來** —— 而它們都只會在使用者真的在講話時才發生。
   */
  const [auditCoaching, setAuditCoaching] = useState<CoachingHint | null>(null)

  useEffect(
    () =>
      registerAuditControl('overlay.coachingHint', (arg) => {
        const a = arg as { kind?: unknown; message?: unknown } | null
        if (a === null || a === undefined) {
          setAuditCoaching(null)
          return true
        }
        if (typeof a !== 'object') return false
        const kind = String(a.kind ?? 'filler') as CoachingKind
        setAuditCoaching({ kind, message: String(a.message ?? '稽核教練提示') })
        return true
      }),
    []
  )

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

  const content = payload.content ?? ''

  // ---- 四模式定時引擎 ----
  const o = settings?.overlay
  // 熱鍵提示動態化:自訂熱鍵後工具列文案不再過期(與側欄熱鍵提示同一教訓,這裡是同族漏網)
  const panicKey = settings?.hotkeys.panicRescue ?? 'Alt+P'
  /**
   * 真正全域可用的那一顆。
   *
   * 工具列原本寫的是「暫停(空白鍵)」,而空白鍵只在**浮層自己有焦點**時才送
   * 到這裡 —— 浮層是 `showInactive()` 顯示的(windows.ts),刻意不搶焦點,
   * 否則會打斷使用者正在簡報的那個應用。於是那個提示在真實情境下多半不成立,
   * 而永遠成立的那一顆(全域 playPause 熱鍵)從未在浮層出現過。
   * 同理 bullet 的 ←/→。
   *
   * title 的身分靠 `normalizeTitle` 在 `(` / `（` / `:` 處切斷維持
   * (見 scripts/lib/effect-inventory.mjs),所以把捷徑放進括號裡不會讓
   * 效果稽核的登記表對不上。
   */
  const playKey = (settings?.hotkeys.playPause ?? 'Alt+K').replaceAll('Control', 'Ctrl')
  const speedUpKey = (settings?.hotkeys.speedUp ?? 'Alt+Up').replaceAll('Control', 'Ctrl')
  const speedDownKey = (settings?.hotkeys.speedDown ?? 'Alt+Down').replaceAll('Control', 'Ctrl')
  const toggleKey = settings?.hotkeys.toggleOverlay
  const toggleHint = toggleKey ? `${toggleKey.replaceAll('Control', 'Ctrl')} 可再開` : '於設定頁設定熱鍵後可再開'
  const displayMode = o?.displayMode ?? 'scroll'
  // 貼鏡形態下的實際引擎模式。
  //
  // 為什麼要導一層:連續捲動的推進依賴「捲動容器已量測」(engine.tickScroll 對
  // 未量測直接 return),而貼鏡 420×170 沒有捲動容器 —— 於是 displayMode=scroll
  // 進貼鏡後,時鐘照走、狀態點照亮,但畫面一格都不動:看起來在播、實際凍結,
  // 而且只在錄影當下才看得出來。貼鏡渲染的是索引驅動的 band,其中逐句與
  // scroll 的語意最接近,所以貼鏡 + scroll 一律以 phrase 驅動;游標歸零與
  // 工具列換模式是同一套既有語意(setDisplayMode 本來就會重置游標、保留時間)。
  const engineMode: OverlayDisplayMode = o?.lensMode && displayMode === 'scroll' ? 'phrase' : displayMode
  // 個人化語速基準：已校準時 1×＝使用者自己的語速（引擎固定 120 WPM 基準，換算為有效倍率）
  const personalBaseline = settings?.personal.profile?.charsPerMin ?? PhraseVisuals.DEFAULT_WPM
  // 抽成變數:除錯層要顯示「滑桿倍率 → 實際倍率」的換算,不該重算一份
  const effectiveRate = effectiveEngineRate(
    o?.rate ?? 1,
    settings?.personal.profile?.charsPerMin,
    PhraseVisuals.DEFAULT_WPM
  )
  const { state, model, remainingMs, progress, measured, scrollable, controls } = useTeleprompterEngine({
    content,
    displayMode: engineMode,
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
  const {
    hint: realCoachingHint,
    mutedKinds: coachingMuted,
    muteKind: muteCoachingKind,
    unmuteAll: unmuteCoaching
  } = useCoaching(o?.coaching ?? true)

  // 稽核覆寫優先於真實提示。放在這裡而不是 useCoaching 裡面:那個 hook 是
  // 「main 送來的訊號 → 顯示 → 8 秒後淡出」的純流程,把它摻進一個只在
  // audit 模式存在的開關會讓它的每一次狀態變化都有兩個來源。
  const coachingHint = auditCoaching ?? realCoachingHint

  // ---- 瞬時節奏讀數(P4):10 秒窗的語速,掛在同一個「即時教練」開關下 ----
  // 刻意不做稽核覆寫:它不是事件,而是持續讀數 —— audit 要驗它,推真的逐字稿
  // 進 main 就好(e2e/overlay-pace.spec.ts 就是這樣走真 IPC 的)。
  const pace = usePace(o?.coaching ?? true)

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
  /**
   * 這三個是 useFollowMode 內的 useCallback,身分**永遠不變**。
   *
   * 為什麼要從 follow 物件上拆出來(而不是在依賴裡寫 follow.xxx):follow 是每次
   * render 都新建的物件,寫 follow 會讓 effect 每 render 重跑(訂閱反覆退訂又掛上)。
   * 拆開之後依賴是恆等的 useCallback,依賴陣列可以照實列出去,effect 仍然只會在
   * 該跑的時候跑 —— exhaustive-deps 要的不是「少寫」,是「寫真的」
   */
  const { stopFollow, rebuildIndex, resetProgress } = follow
  const followStatusRef = follow.followStatusRef
  const followLevelRef = follow.followLevelRef
  const chunkElsRef = follow.chunkElsRef

  // 這個 effect 排在 useFollowMode 之後是刻意的:它要呼叫 resetProgress,而那是
  // useFollowMode 內的 useCallback —— 寫在前面會變成「宣告前使用」。順序調整是
  // 安全的:useFollowMode 在掛載時的兩個 effect 分別是除錯日誌與視窗關閉清理,
  // 都不碰這裡建立的 IPC 訂閱;同一個 commit 之內也不可能從中漏掉事件
  // (getSettings 的回應是 microtask,更晚)。
  // ---- 初始化 ----
  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    void window.api.getSettings().then(setSettings)
    void window.api.overlayGetLastPayload().then(setPayload)
    const offScript = window.api.onOverlayLoadScript((p) => {
      setPayload(p)
      resetProgress()
      // 主視窗「開始提詞」= 打開就開始講;實際 play 在 content 變化後的 effect
      autoPlayRef.current = true
    })
    const offSettings = window.api.onSettingsChanged(setSettings)
    return () => {
      offScript()
      offSettings()
    }
    // resetProgress 恆等,所以這個 effect 仍然只跑一次(訂閱一次,不多不少)。
  }, [resetProgress])

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
      stopFollow()
      pendingFollowNoticeRef.current = '浮層隱藏時已自動停止語音跟讀（麥克風已關閉）'
    })
    return off
    // stopFollow 是 useCallback([])、followStatusRef 是 ref:兩者都不隨 render 變動,
    // 所以這裡只會訂閱一次。傳整個 follow 物件會每 render 重新訂閱。
  }, [stopFollow, followStatusRef])

  // 提示顯示 6 秒後自行消失(它只是告知,不需要使用者處理)
  useEffect(() => {
    if (!followNotice) return
    const t = setTimeout(() => setFollowNotice(''), 6000)
    return () => clearTimeout(t)
  }, [followNotice])

  // 講稿內容變化 → 重建跟讀索引,並把捲動位置歸零
  // (引擎內部 scrollPos 會重置,但 scroll 模式每幀直寫 DOM,暫停時不會再推,殘影會留在畫面上)
  useEffect(() => {
    rebuildIndex(content)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    // 自動播放:引擎此刻已隨 content 重建,play 才會落在正確的實例上。
    // 語音跟讀進行中則不播:兩套捲動來源(定時引擎 vs STT 對位)會互相拉扯。
    if (autoPlayRef.current) {
      autoPlayRef.current = false
      if (followStatusRef.current === 'idle' && content) controlsRef.current?.play()
    }
    // 三個依賴都恆等 —— 這個 effect 的觸發條件仍然只有「稿子換了」。
  }, [content, rebuildIndex, followStatusRef])

  /**
   * 教練訊號種類的人話標籤。
   *
   * 用在「本場已靜默:搶話、冷場」那一列。為什麼需要它:靜默狀態必須**看得見**
   * —— 使用者按過之後如果畫面上什麼都沒變,三小時後他會認為按鈕壞了,
   * 然後在「教練怎麼都不響」的困惑裡去翻設定。內部識別碼(fast/filler/…)
   * 不能直接顯示:那是我們的字,不是他的。
   */
  const COACHING_KIND_LABEL: Record<CoachingKind, string> = {
    fast: '語速過快',
    filler: '填充詞過多',
    interrupt: '搶話',
    dead_air: '冷場',
    monologue: '講太久'
  }

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
  const isCompact = o?.compact ?? false
  useEffect(() => {
    // 音柱元素只掛在藥丸分支:展開/貼鏡形態跟讀時 el 恆為 null,
    // 不擋掉的話 rAF 以 60fps 空轉(每秒 60 次什麼都不做的迴圈)。
    // 以 isCompact 進依賴:morph 到展開時停掉,回藥丸時自動重啟。
    if (followStatus !== 'listening' || !isCompact) return
    let raf = 0
    const tick = (): void => {
      const el = voiceBarsRef.current
      if (el) el.style.opacity = String(0.3 + Math.min(1, followLevelRef.current * 2) * 0.7)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [followStatus, isCompact, followLevelRef])

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
    const onResize = (): void => {
      setWinW(window.innerWidth)
      setWinH(window.innerHeight)
    }
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
      if (mode !== 'scroll' && followStatus !== 'idle') stopFollow()
      void patchOverlay({ displayMode: mode })
    },
    [patchOverlay, followStatus, stopFollow]
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

  /**
   * 工具列圖示的說明列(toolbar legend)。
   *
   * 為什麼不是 tooltip:展開面板的根是 overflow-hidden,而工具列本身是
   * overflow-x-auto —— 任何從按鈕往上長的原生 tooltip 都會被裁掉,而這正是
   * 原本的 title 在「一邊捲一邊看」時失效的原因。島的寬度也不允許把標籤畫在
   * 圖示旁邊(1.00× 的內容預算已經滿載,見 audit-deep 的 note)。
   * 所以說明顯示在**既有的一條底欄**上:滑鼠或鍵盤焦點落在哪一顆就報哪一顆。
   * 那一個位置不會被裁、不佔寬度,而且是滑鼠與鍵盤共用同一條路。
   *
   * 延遲 120ms 才顯示:純鍵盤/滑鼠經過不該讓底欄一直閃(原生 tooltip 的
   * 一秒延遲是在解同一個問題,只是它同時把「想學這一顆是什麼」的人也擋掉了)。
   */
  const [toolbarHint, setToolbarHint] = useState<{ label: string; detail: string } | null>(null)
  const toolbarHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 事件委派:讀 ToolBtn 自己宣告的 data 屬性,不必讓 20 個呼叫端各接一個 callback */
  const onToolbarPointer = (e: React.SyntheticEvent): void => {
    const target = e.target as HTMLElement | null
    const btn = target?.closest?.('[data-tooltip-label]')
    if (!btn) return
    const label = btn.getAttribute('data-tooltip-label') ?? ''
    const detail = btn.getAttribute('data-tooltip-detail') ?? ''
    if (!label) return
    if (toolbarHintTimer.current) clearTimeout(toolbarHintTimer.current)
    toolbarHintTimer.current = setTimeout(() => {
      // 同一個標籤不重覆 setState:hover 事件會從子元素冒泡上來,
      // 每一次都換一個新物件等於讓整棵樹白重畫(而這是每秒可能數十次的熱路徑)。
      setToolbarHint((cur) => (cur && cur.label === label && cur.detail === detail ? cur : { label, detail }))
    }, 120)
  }

  const offToolbarPointer = (e: React.SyntheticEvent): void => {
    // 只在真的離開工具列(而不是在兩顆鈕之間移動)時收起
    const next = (e as React.FocusEvent | React.MouseEvent).relatedTarget as HTMLElement | null
    if (next && next.closest?.('[data-toolbar-shell]')) return
    if (toolbarHintTimer.current) clearTimeout(toolbarHintTimer.current)
    setToolbarHint(null)
  }

  useEffect(() => () => {
    if (toolbarHintTimer.current) clearTimeout(toolbarHintTimer.current)
  }, [])

  // 貼鏡模式提示(每次開啟顯示 6 秒)
  const [lensHint, setLensHint] = useState(false)
  const lensOn = o?.lensMode ?? false
  useEffect(() => {
    if (!lensOn) return
    setLensHint(true)
    const t = setTimeout(() => setLensHint(false), 6000)
    return () => clearTimeout(t)
  }, [lensOn])

  // morphSize 不在這裡解構:那是 useMorph 的內部動作(animate→patch),
  // 組件這層只宣告「進/出 compact、進/出 lens」四個意圖。
  const { enterCompact, exitCompact, enterLens, exitLens, morphing } = useMorph({ patchOverlay })

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
  const isTimedMode = engineMode === 'phrase' || engineMode === 'karaoke'
  // 「這條線現在有沒有東西可顯示」。
  //
  // 逐句/卡拉OK 的進度由索引算得,不需要量測;連續捲動不然 —— 使用者視角試用
  // 發現的實際情況:收合成藥丸後換稿(藥丸沒有捲動容器,永遠量不到),播放中仍
  // 讓一條永遠 0% 的線貼在底緣,比完全不畫更糟:它看起來像「講稿還在第一行」,
  // 而畫面上沒有任何東西可以讓使用者發現那是假的。展開後就會量到、線就回來了。
  const progressKnown = engineMode !== 'scroll' || measured

  // 這一頁放得下 → 沒有可捲動的內容。
  //
  // 為什麼需要這個判斷在使用者這一层(而不是只靠引擎不宣告「已播畢」):
  // 引擎那一半修掉的是「一秒內自己播完」這個錯誤結論,但若只做那一步,畫面會變成
  // 狀態停在「播放中」而內容完全不動 —— 使用者按了「開始提詞」卻沒反應,那和壞掉
  // 難以區分,反而換了一種看不懂。所以在時間列旁邊把原因讲清楚。
  //
  // 實測症狀與驗收見 docs/UX_FINDINGS.md 第四輪 P0-1。預設浮層扣掉工具列約 4 行,
  // 約 96 字以內的稿都會命中。
  const fitsOnePage = engineMode === 'scroll' && measured && !scrollable

  // 與下面空狀態分支用**同一個**判斷(content ?)。兩處分開寫就會漂移:空狀態說
  // 「尚未載入講稿」而時間列照樣報時間,那正是 P0-2 的矛盾畫面。
  const hasContent = Boolean(content)

  // 「一頁放得下」的文案放在時間列的位置而不是狀態點的 title:狀態點的 title 只有
  // 滑鼠停在那 6px 的點上才看得到,而這裡正是使用者按完「開始提詞」正在看的地方。
  // 空白時間列在沒有稿時是對的(沒有可報的時間),所以只在真的有稿時加上這句。
  const transportText = fitsOnePage && hasContent ? '這一頁就放得下' : formatTransport(elapsedSec, remainingMs, hasContent)

  // 除錯層(預設關閉;Ctrl+Shift+D 開 HUD)。以 portal 掛到 body,
  // 不參與這裡的 flex 版面 —— 貼鏡模式只有 170px,多任何一層都會把正文擠掉。
  const debugLayer = (
    <OverlayDebugRoot
      data={{
        mode: engineMode,
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

  /**
   * 浮層狀態的**單一出處**(藥丸與展開的工具列共用,貼鏡不需要:它的工具列只有四顆)。
   *
   * 為什麼要一個名字:改動前,同一個狀態在兩個地方各寫一串巢狀三元運算式 ——
   * 藥丸的點與展開列標題旁的小點。結果兩處都把「滑鼠穿透」與「已播畢」
   * 畫成同一個色相的兩個明度(amber / amber-80),使用者分不出「我按不到它」
   * 與「它講完了」。更關鍵的是穿透狀態下視窗**收不到任何滑鼠事件**,所以那顆點
   * 上唯一的說明(title)在該狀態永遠不可能顯示 —— 最需要解釋的狀態剛好是最沒
   * 辦法解釋的一個(見 docs/UX_FINDINGS.md P1-1)。
   *
   * 所以:(1) 形狀必須不同(空心環 / 實心圓 / 方塊 / 滑鼠圖示),
   * (2) 穿透狀態必須有文字(島上放「穿透」兩字,見 pill 分支),
   * (3) 狀態值要能被離線稽核讀到(`data-overlay-state`)。
   */
  const overlayState: 'clickThrough' | 'following' | 'playing' | 'completed' | 'idle' =
    o.clickThrough
      ? 'clickThrough'
      : followStatus === 'listening'
        ? 'following'
        : playing
          ? 'playing'
          : state.status === 'completed'
            ? 'completed'
            : 'idle'
  /** 小点的說明文字。四處(藥丸/展開 × 狀態)共用一份,不各自寫一次。 */
  const OVERLAY_STATE_TITLE: Record<typeof overlayState, string> = {
    clickThrough: '滑鼠穿透中:浮層收不到點擊;熱鍵或主視窗「提詞」重新顯示時自動解除',
    following: '跟讀中:麥克風正在聽,捲動跟著你念',
    playing: '播放中',
    completed: '已播畢',
    idle: '待機'
  }

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
            {o.clickThrough && (
              // 事件視窗會整個取代島的內容層,連後備分支的「穿透」字樣一起消失:
              // 穿透中的島收不到點擊又看不到任何標記,像壞掉了。島只有一行寬度,
              // 圖示是唯一塞得下的穿透標記。
              <MousePointerClick size={12} className="shrink-0 text-amber-300" />
            )}
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
              // 狀態用**形狀**區分,顏色只當輔助:
              //   待機 = 空心環、跟讀 = 會呼吸的實心圓、播放 = 實心圓、
              //   已播畢 = 方塊、滑鼠穿透 = 滑鼠圖示(四個形狀互不相同)。
              // 8px 的足跡刻意不變:藥丸在 1.00× 的內容預算是「剛好裝滿」
              // (見 audit-deep 的 overlay.pill.1x.loaded note),放大這顆點
              // 就是從標題身上搶寬度(滑鼠圖示是 10px 的 svg,畫出 8px 的框
              // 之外各 1px,不影響 flex 寬度)。
              data-overlay-state={overlayState}
              className={cn(
                'flex h-2 w-2 shrink-0 items-center justify-center',
                overlayState === 'following' && 'animate-pulse rounded-full bg-emerald-400',
                overlayState === 'playing' && 'rounded-full bg-emerald-400',
                overlayState === 'completed' && 'rounded-[2px] bg-amber-450',
                overlayState === 'idle' && 'rounded-full border border-white/40'
              )}
              title={OVERLAY_STATE_TITLE[overlayState]}
            >
              {overlayState === 'clickThrough' && (
                <MousePointerClick size={10} className="text-amber-450" />
              )}
            </span>
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
            {o.clickThrough ? (
              // 穿透狀態的文字補位。島上只有這條內容通道讀得到(視窗收不到滑鼠,
              // tooltip 永遠不會出現),所以把字寫在這裡 —— 否則使用者看到的
              // 只有一顆琥珀色的點,而它不會回應任何點擊。
              // 「穿透」兩個字是刻意的寬度選擇:它比預設的計時器(5 字元等寬)
              // 還窄,所以在 1.00× 的滿載預算下不會從標題身上搶寬度。
              <span
                data-pill-notice="1"
                className="shrink-0 whitespace-nowrap text-[11px] font-medium text-amber-200"
                title={OVERLAY_STATE_TITLE.clickThrough}
              >
                穿透
              </span>
            ) : showPillKeyword ? (
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
          title={playing ? `暫停(${playKey})` : `播放(${playKey})`}
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
          {/* 貼鏡狀態點:與藥丸/展開同一份狀態(overlayState)與同一套形狀語彙。
              原本這顆只有「播放綠/其他灰」兩色,穿透/跟讀/播畢在貼鏡全靠猜,
              穿透中甚至是一顆看不見的空點(唯一說明靠 title,而穿透收不到滑鼠)。 */}
          <span
            data-overlay-state={overlayState}
            title={OVERLAY_STATE_TITLE[overlayState]}
            className={cn(
              'flex h-1.5 w-1.5 shrink-0 items-center justify-center',
              overlayState === 'following' && 'animate-pulse rounded-full bg-emerald-500',
              overlayState === 'playing' && 'rounded-full bg-emerald-500',
              overlayState === 'completed' && 'rounded-[1px] bg-amber-450',
              overlayState === 'idle' && 'rounded-full border border-white/35'
            )}
          >
            {overlayState === 'clickThrough' && <MousePointerClick size={8} className="text-amber-450" />}
          </span>
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
          displayMode={engineMode}
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
                語速過快/填充詞/冷場恰好在最像簡報的場景無聲。樣式對齊另外兩形態。
                藥丸與貼鏡形態是**唯讀**的:那兩個視窗小到放不下一顆可點的按鈕
                而不破壞尺寸計算(pillSizeOf 是量出來的硬尺寸),而放不下的
                控制項比沒有更糟。展開態是唯一能靜默的地方,而展開態也是
                使用者真正會停下來讀提示的地方。 */}
            {coachingHint && (
              <div className="flex items-center justify-center gap-1.5 rounded-full bg-amber-500/20 px-3 py-1 text-[10px] font-medium text-amber-300">
                <Gauge size={11} /> {coachingHint.message}
              </div>
            )}
            {coachingMuted.length > 0 && (
              <div className="flex items-center justify-center gap-1.5 rounded-full bg-black/40 px-2.5 py-0.5 text-[10px] text-ink-400">
                <BellOff size={10} /> 已靜默 {coachingMuted.length} 種
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
  // 說明列也佔用同一條底欄:提示 pill 的避讓判斷必須一起看它,
  // 否則 tooltip 出現的那一瞬間,提示条會與它疊印(兩行都讀不了)。
  const followBarVisible = !!toolbarHint || followStatus !== 'idle' || !!followNotice
  /**
   * 這一刻**真的畫出來**的底部狀態條:高度不足時整條讓位(見 overlayShapes 的
   * statusBarFits —— 它與讀數一樣不會自己退場,而工具列是提詞機的出口)。
   *
   * 讓位之後堆疊不能再被抬起,否則提示條會為了避開一個看不見的東西而被推出
   * 視窗(實測 720x40 時堆疊 top=-40:整個提示條在視窗上緣之外)。
   */
  const bottomBarShown = followBarVisible && statusBarFits(winH)
  /**
   * 這一刻與讀數同在底部堆疊裡的其他項(turn-yield 提示 / 教練提示 / 已靜默的恢復鈕)。
   *
   * 為什麼讀數要問這個:堆疊比空間高時被推出頂端的是**第一項** —— 也就是讀數。
   * 它的門檻若只算自己,就會壓在工具列上(稽核實測 720x120 + 狀態條 + 一條提示條
   * → 讀數 top=8、與工具列重疊 24px)。
   */
  const stackItems =
    (turnYieldHint ? 1 : 0) + (coachingHint ? 1 : 0) + (coachingMuted.length > 0 ? 1 : 0)

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
        data-overlay-toolbar="1"
        className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 px-2.5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="mr-1 flex items-center gap-1.5">
          {/* 展開態的狀態點:與藥丸那顆同一份狀態與同一套形狀語彙(見 overlayState)。
              這裡原本是 clickThrough 琥珀、其餘綠/灰的圓點 —— 同樣有「穿透與
              已播畢分不出來」的問題,只是半徑更小(6px)。 */}
          <span
            data-overlay-state={overlayState}
            title={OVERLAY_STATE_TITLE[overlayState]}
            className={cn(
              'flex h-1.5 w-1.5 shrink-0 items-center justify-center',
              overlayState === 'following' && 'animate-pulse rounded-full bg-emerald-500',
              overlayState === 'playing' && 'rounded-full bg-emerald-500',
              overlayState === 'completed' && 'rounded-[1px] bg-amber-450',
              overlayState === 'idle' && 'rounded-full border border-white/35'
            )}
          >
            {/* 穿透狀態在這個形態同樣收不到滑鼠事件,title 不可達:與藥丸同一套
                形狀語彙(琥珀滑鼠圖示),讓「按不到」至少看得出來。 */}
            {overlayState === 'clickThrough' && <MousePointerClick size={8} className="text-amber-450" />}
          </span>
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
          data-toolbar-shell="1"
          // 說明列的輸入來自這裡(事件委派):mouseover / focus 都掛在同一個壳上,
          // 所以 20 顆按鈕沒有一顆需要記得接線。
          // 用 React 的 onFocus/onBlur 而不是原生 onFocusIn/onFocusOut:React
          // 把這兩個合成事件底層實作成 focusin/focusout(會冒泡),語意一致,
          // 而 JSX 型別面上只有前者存在。
          onMouseOver={onToolbarPointer}
          onMouseOut={offToolbarPointer}
          onFocus={onToolbarPointer}
          onBlur={offToolbarPointer}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="flex w-max items-center gap-0.5">
          {/* 時間列。文案由 formatTransport 產生(純函式,有測試):
              原本是 `{已播} / -{剩餘}`,播完時顯示 `0:00 / -0:00`。
              負號在這裡讀起來是「負的剩餘」而不是「倒數」,而且剩 0 秒是一個
              沒有意義的敘述 —— 見 docs/UX_FINDINGS.md P0-3。

              三種狀態(第四輪 P0-1 / P0-2):
                - 沒有稿 → 空字串。沒有稿就沒有「播過」(P0-2:舊寫法會讓畫面同時
                  顯示「尚未載入講稿」與「已播畢」,互相矛盾)。
                - 一頁放得下 → 明講原因。引擎不再宣告「已播畢」,但只做那一步會讓
                  狀態停在「播放中」而內容不動,使用者會以為壞掉。
                - 其餘 → 已播 / 剩餘。*/}
          {transportText && (
            <span
              className="mr-1.5 select-none whitespace-nowrap font-mono text-[10px] text-white/52"
              title={fitsOnePage ? '這份稿一頁就放得下,沒有需要捲動的內容;可調整浮層尺寸讓它自動捲動' : '已播時間 · 估計剩餘時間'}
            >
              {transportText}
            </span>
          )}

          {/* ── 群組一:救援與即時提示 ──
              Panic 放在最左邊是刻意的:它是「被問倒」當下要按的鈕,
              而這條工具列是可橫捲的 —— 擺在中段就等於「高風險時刻還得先捲一下」。
              熱鍵(Alt+P)仍然存在,但那是最後的備援,不該是唯一順手的那條路。 */}
          <ToolBtn
            label="救援"
            title={`Panic 救援:即時回答要點(${panicKey})`}
            active={panicPhase !== 'idle'}
            onClick={triggerPanic}
          >
            <Siren size={13} className={panicPhase === 'thinking' ? 'animate-pulse' : undefined} />
          </ToolBtn>

          {/* turn-yield 開關(即時回饋用)*/}
          <ToolBtn
            label="接話提示"
            title={o.turnYield ? '關閉「該你說話了」提示' : '開啟「該你說話了」提示:對方講完問句時提醒你接話'}
            active={o.turnYield}
            onClick={() => void patchOverlay({ turnYield: !o.turnYield })}
          >
            <Hand size={13} />
          </ToolBtn>

          {/* 即時教練開關。
              title 要講清楚「它會不會打斷我」—— 使用者在會議中不會去讀設定頁,
              而這顆鈕的常見反應是「關掉之後就不會響了」,那會讓他失去
              「該你說話了」那種真正有價值的提示。 */}
          <ToolBtn
            label="即時教練"
            title={
              o.coaching
                ? `即時教練開啟中:語速過快、填充詞、冷場時會在浮層出現提示（本場想關某一種,直接點提示條;已靜默 ${
                    coachingMuted.length
                  } 種）— 點擊永久關閉`
                : '開啟即時教練:語速過快、填充詞、冷場時提醒你'
            }
            active={o.coaching}
            onClick={() => void patchOverlay({ coaching: !o.coaching })}
          >
            <Gauge size={13} />
            {coachingMuted.length > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400"
                aria-hidden
              />
            )}
          </ToolBtn>

          <Divider />

          {/* ── 群組二:語音跟讀 ──
              跟讀是唯一「會驅動捲動」的開關,與播放控制同組但它自己一段 ——
              它需要麥克風,所以旁邊的按鈕不該讓它看起來像純播放控制。 */}
          {displayMode === 'scroll' && (
            <ToolBtn
              label="語音跟讀"
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
              <ToolBtn label="上一個重點" title={`上一個重點(${speedDownKey};浮層有焦點時可用 ←)`} onClick={controls.prev}>
                <ChevronLeft size={13} />
              </ToolBtn>
              <ToolBtn label="下一個重點" title={`下一個重點(${speedUpKey};浮層有焦點時可用 →)`} onClick={controls.next}>
                <ChevronRight size={13} />
              </ToolBtn>
            </>
          ) : (
            <>
              <ToolBtn
                label={playing ? '暫停' : '播放'}
                title={playing ? `暫停(${playKey};浮層有焦點時可用空白鍵)` : `播放(${playKey};浮層有焦點時可用空白鍵)`}
                active={playing}
                onClick={controls.toggle}
              >
                {playing ? <Pause size={13} /> : <Play size={13} />}
              </ToolBtn>
              <ToolBtn label="回到開頭" title="回到開頭" onClick={controls.restart}>
                <span className="text-[11px] font-bold">↺</span>
              </ToolBtn>
            </>
          )}

          {/* 速度控制:timed 模式調倍率,scroll 模式調 px/s */}
          {isTimedMode ? (
            <>
              <ToolBtn
                label="語速 −"
                title={
                  personalBaseline !== PhraseVisuals.DEFAULT_WPM
                    ? `語速 -(${speedDownKey};1×=你的個人語速 ${personalBaseline} 字/分)`
                    : `語速 -(${speedDownKey})`
                }
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
                label="語速 +"
                title={
                  personalBaseline !== PhraseVisuals.DEFAULT_WPM
                    ? `語速 +(${speedUpKey};1×=你的個人語速 ${personalBaseline} 字/分)`
                    : `語速 +(${speedUpKey})`
                }
                onClick={() =>
                  void patchOverlay({ rate: Math.min(3, Math.round((o.rate + 0.1) * 10) / 10) })
                }
              >
                <ChevronRight size={13} />
              </ToolBtn>
            </>
          ) : !isBullet ? (
            <>
              <ToolBtn
                label="減速"
                title={`速度 -(${speedDownKey})`}
                onClick={() => void patchOverlay({ speed: Math.max(10, o.speed - 10) })}
              >
                <ChevronLeft size={13} />
              </ToolBtn>
              <span className="w-9 select-none text-center font-mono text-[10px] text-white/52">{o.speed}</span>              <ToolBtn label="加速" title={`速度 +(${speedUpKey})`} onClick={() => void patchOverlay({ speed: Math.min(600, o.speed + 10) })}>
                <ChevronRight size={13} />
              </ToolBtn>
            </>
          ) : null}

          <Divider />

          {/* ── 群組三:顯示(字級與鏡像)── */}
          <ToolBtn
            label="字體縮小"
            title="字體縮小"
            onClick={() => void patchOverlay({ fontSize: Math.max(16, o.fontSize - 2) })}
          >
            <span className="text-[11px] font-bold">A-</span>
          </ToolBtn>
          <ToolBtn
            label="字體放大"
            title="字體放大"
            onClick={() => void patchOverlay({ fontSize: Math.min(72, o.fontSize + 2) })}
          >
            <span className="text-[13px] font-bold">A+</span>
          </ToolBtn>
          <ToolBtn label="鏡像" title="鏡像(提詞器反射罩用)" active={o.mirror} onClick={setMirror}>
            <FlipHorizontal2 size={13} />
          </ToolBtn>

          <Divider />

          {/* ── 群組四:視窗與形態(置中 / 收合 / 貼鏡 / 擷取 / 穿透 / 關閉)──
              這六顆是「改變浮層本身」而不是「改變內容」的操作。 */}
          <ToolBtn
            label="浮層置中"
            title="浮層置中(找不到浮層時按這裡)"
            onClick={() => void window.api.recenterOverlay()}
          >
            <Crosshair size={13} />
          </ToolBtn>
          {/* 叫回主視窗:主視窗關閉後,這條浮層可能就是 App 的全部,而沒有這顆
              鈕時空狀態那句「到主視窗按開始提詞」是一條死路(沒有 tray、沒有
              工作列圖示,唯一的重建路徑是再啟動一次 App)。見 UX_FINDINGS 第三輪
              P0-2。title 一併把「浮層隱藏後 10 秒 App 會結束」講出來 ——
              那件事本來只寫在 main 端的程式碼裡。 */}
          <ToolBtn
            label="主視窗"
            title="開啟主視窗(主視窗關閉後,浮層一旦隱藏 App 會在 10 秒後結束;重新啟動 App 也可回到主視窗)"
            effectId="overlay-show-main"
            onClick={() => void window.api.showMain()}
          >
            <AppWindow size={13} />
          </ToolBtn>
          <ToolBtn label="收成藥丸" title="收合成藥丸(低存在感)" onClick={() => enterCompact(o)}>
            <Minimize2 size={13} />
          </ToolBtn>
          <ToolBtn
            label="貼鏡模式"
            title="貼鏡模式:貼近攝影機 5cm 內,眼神自然對準鏡頭(建議搭配逐句短語)"
            active={o.lensMode}
            onClick={() => {
              // 貼鏡沒有跟讀 UI(音柱與狀態列都不渲染):帶著麥克風進貼鏡會變成
              // 看不到也停不掉的背景錄音。與「隱藏浮層自動停跟讀」同一族處置,
              // 也與 setMode 切離 scroll 時停跟讀同一語意。
              if (followStatus !== 'idle') follow.stopFollow()
              enterLens(o)
            }}
          >
            <ScanFace size={13} />
          </ToolBtn>
          <ToolBtn
            label="螢幕擷取隱形"
            title={o.captureProtected ? '螢幕擷取隱形:開(分享畫面看不到此視窗)' : '螢幕擷取隱形:關'}
            active={o.captureProtected}
            onClick={() => void window.api.overlaySetCaptureProtection(!o.captureProtected)}
          >
            <ScanEye size={13} />
          </ToolBtn>
          <ToolBtn
            label="滑鼠穿透"
            title={o.clickThrough ? '滑鼠穿透:開(浮層已收不到點擊;熱鍵或主視窗「提詞」重新顯示時自動解除)' : '滑鼠穿透:關'}
            active={o.clickThrough}
            onClick={() => void window.api.overlaySetClickThrough(!o.clickThrough)}
          >
            <MousePointerClick size={13} />
          </ToolBtn>
          <ToolBtn label="關閉浮層" title={`關閉(${toggleHint})`} onClick={() => void window.api.overlayHide()}>
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

          {/* 工具列說明列 / 跟讀狀態條:同一條底欄的兩個使用者(見 toolbarHint)。
              說明列優先:它是使用者當下滑鼠所在的那一顆(即時意圖),
              而跟讀狀態是背景事實;兩者同時存在時,先回答他正在問的問題。 */}
          {bottomBarShown && (toolbarHint ? (
            <div
              data-toolbar-legend="1"
              className="pointer-events-none absolute bottom-1.5 left-1/2 flex max-w-[92%] -translate-x-1/2 items-center gap-2 rounded-full bg-black/75 px-3 py-1 text-[10px] text-white/72"
            >
              <span className="shrink-0 font-medium text-white/95">{toolbarHint.label}</span>
              {toolbarHint.detail && toolbarHint.detail !== toolbarHint.label && (
                <span className="truncate">{toolbarHint.detail}</span>
              )}
            </div>
          ) : followStatus !== 'idle' || followNotice ? (
            <div className="pointer-events-none absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-[10px] text-white/72">
              {followStatus === 'loading' && <Loader2 size={10} className="animate-spin" />}
              {followStatus === 'listening' && <AudioLines size={10} className="text-emerald-400" />}
              <span className="max-w-[280px] truncate" title={followBarText || undefined}>
                {followBarText}
              </span>
            </div>
          ) : null)}
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center text-xs leading-relaxed text-white/52">
          <div>
            尚未載入講稿
            <br />
            到主視窗「提詞講稿」頁按「開始提詞」
          </div>
          {/* 與工具列「主視窗」同一個 data-effect-id(同一個控制項的第二個入口):
              空狀態正是「主視窗可能已經不在」最常撞見的畫面 —— 指示一條到不了
              的路,比沒有指示更糟(見 UX_FINDINGS 第三輪 P0-2)。 */}
          <button
            data-effect-id="overlay-show-main"
            className="cursor-pointer rounded-full bg-white/12 px-3.5 py-1.5 text-white/85 transition-colors hover:bg-white/20"
            title="開啟主視窗(主視窗關閉後,浮層一旦隱藏 App 會在 10 秒後結束;重新啟動 App 也可回到主視窗)"
            onClick={() => void window.api.showMain()}
          >
            開啟主視窗
          </button>
        </div>
      )}

      {/* 即時回饋提示條(turn-yield 藍 / coaching 琥珀;堆疊避免同時觸發時互相遮擋)。
          救援卡顯示中時不畫:兩者在 260px 的視窗裡會疊到同一段高度(卡片是 z-30
          且不透明),被蓋住的提示文字就變成一個真的會被稽核抓到的遮擋缺陷。
          救援永遠比提醒重要,而提示條本來就會重播。 */}
      {panicPhase === 'idle' && (turnYieldHint || coachingHint || pace) && (
        <div
          // 跟讀狀態條佔著 bottom 1.5–30px:提示 pill 從 bottom-4 起跳會與它疊印,
          // 兩者都是暫態,同時出現時兩行都讀不了 → 條存在時提示上移避讓
          className={cn(
            'pointer-events-none absolute inset-x-4 z-20 flex flex-col items-center gap-2',
            bottomBarShown ? 'bottom-12' : 'bottom-4'
          )}
        >
          {/* 瞬時節奏讀數(P4):只出現在展開態。
              藥丸(320px 扣三顆按鈕)與貼鏡(420×170,高度預算被量過三次)
              都沒有空間給一個**持續**讀數 —— 那兩個形態的職責是「看著稿」,
              不是「看著自己」;教練提示在那裡是暫態事件,與讀數不同。
              放在堆疊的**第一項**:讀數隨著開口/停頓出現又消失,而位移總要有人
              吸收 —— 提示鈕是可點擊的(點它把這一種靜默到本場結束),讀數不是。
              稽核實測(`overlay-pace-shifts-hint`):放最後一項時,讀數出現會把
              提示鈕往上推 32px,使用者正在瞄準的那一顆就跑掉了。
              高度不夠時不畫(paceReadoutFits):它有**兩條**門檻 —— 堆疊貼在
              bottom-4 時需要 77px,而底部狀態條(說明列/跟讀條)出現時整個堆疊
              被抬到 bottom-12,需要 109px。展開態最小高度 40px 比兩條都小,
              持續讀數會**永久**蓋住 36px 的工具列 —— 那幾顆按鈕是提詞機的出口,
              寧可沒有讀數也不能蓋掉它。
              第二條門檻是稽核量出來的:只算 bottom-4 時,720x100(狀態條可見)
              與工具列重疊 8px、720x90 時 18px、720x80 時 24px。 */}
          {pace && paceReadoutFits(winH, bottomBarShown, stackItems) && (
            <div
              data-pace="1"
              data-pace-verdict={pace.verdict}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-full bg-black/45 px-3 py-1 text-[11px] font-medium shadow-lg',
                pace.verdict === 'on_track' && 'text-emerald-300',
                pace.verdict === 'ahead' && 'text-amber-300',
                pace.verdict === 'behind' && 'text-rose-300'
              )}
              title={`近 10 秒瞬時語速（趨勢讀數）:${pace.cpm} 字/分;基準 ${pace.baseline} 字/分${pace.verdict === 'on_track' ? ' — 節奏穩定' : pace.verdict === 'ahead' ? ' — 偏快,可留一點停頓' : ' — 偏慢,可以再推進'}`}
            >
              <Gauge size={11} className="shrink-0" />
              {pace.cpm} 字/分
              <span className="text-white/72">
                {pace.verdict === 'on_track' ? '穩定' : pace.verdict === 'ahead' ? '偏快' : '偏慢'}
              </span>
            </div>
          )}
          {turnYieldHint && (
            <div className="flex items-center justify-center gap-2 rounded-full bg-sky-500/25 px-4 py-2 text-xs font-medium text-sky-200 shadow-lg">
              <MessageCircleQuestion size={14} className="shrink-0" />
              {turnYieldText}
            </div>
          )}
          {coachingHint && (
            /* 整條提示可點:點下去把「這一種」靜默到本場結束。
               為什麼要放在提示條**本體**而不是工具列:使用者看到提示的那一刻
               才是他決定「不想再看到這種」的時刻 —— 那時他正在說話,
               而浮層工具列在展開態要捲動才看得到。把控制項放在他剛才讀到
               建議的位置,是唯一不用移動視線的設計。 */
            <button
              type="button"
              data-effect-id="coaching-mute"
              onClick={() => muteCoachingKind(coachingHint.kind)}
              className="pointer-events-auto flex cursor-pointer items-center gap-2 rounded-full bg-amber-500/25 px-4 py-2 text-xs font-medium text-amber-200 shadow-lg transition-colors hover:bg-amber-500/40"
              title={`不再提示「${COACHING_KIND_LABEL[coachingHint.kind]}」這一種(本場有效)`}
            >
              <Gauge size={14} className="shrink-0" />
              {coachingHint.message}
              <BellOff size={12} className="shrink-0 opacity-70" />
            </button>
          )}
          {/* 已靜默的種類:必須一直看得到,否則使用者會忘記自己按過,
              然後在「教練怎麼都不響了」的困惑裡去找設定。 */}
          {coachingMuted.length > 0 && (
            <button
              type="button"
              data-effect-id="coaching-unmute"
              onClick={unmuteCoaching}
              className="pointer-events-auto flex cursor-pointer items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-[11px] text-ink-400 shadow-lg transition-colors hover:bg-black/60 hover:text-ink-300"
              title="恢復所有即時教練提示"
            >
              <BellOff size={11} className="shrink-0" />
              本場已靜默：{coachingMuted.map((k) => COACHING_KIND_LABEL[k]).join('、')}
            </button>
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
