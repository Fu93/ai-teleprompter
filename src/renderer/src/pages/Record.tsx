import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Download,
  Loader2,
  Mic,
  AlertTriangle,
  MonitorSpeaker,
  Play,
  Save,
  BookPlus,
  Sparkles,
  Square,
  Trash2
} from 'lucide-react'
import type { CoachingKind, MeetingSession, MeetingSummary, SessionReport, TranscriptSegment } from '@shared/types'
import { db } from '../lib/db'
import { useSettings } from '../lib/store'
import { cn, formatDateTime, formatDuration } from '../lib/utils'
import { extractJson, isCancelled, resolvedModelName, startAiChat } from '../lib/ai'
import { CancelableBusy } from '../components/CancelableBusy'
import { toast } from '../lib/toast'
import { reportError, reportEvent, reportCode } from '../lib/reportError'
import { buildSessionReport, sortTranscriptSegments } from '../lib/session-intelligence'
import { createSessionPersister } from '../lib/sessionPersist'
import { buildActionList } from '../lib/actionList'
import { AudioSegmenter, type AudioSegmentMetadata } from '../lib/audio/segmenter'
import { WhisperClient, type WhisperModelKey } from '../lib/audio/whisperClient'
import { encodeWav } from '../lib/audio/wav'
import { registerAuditControl } from '../lib/auditBridge'
import { createPendingTracker, drainPending, STT_FAILURE_BANNER_THRESHOLD } from '../lib/transcriptionQueue'
import { confirmDialog } from '../lib/confirm'
import { useCloseGuard } from '../lib/closeGuard'
import { saveSessionAsScript, isSessionSavedAsScript } from '../lib/sessionToScript'
import { setCaptureIndicator } from '../lib/captureIndicator'

// 連續失敗門檻與 Practice 共用同一份(見 lib/transcriptionQueue.ts):
// 兩頁對「我在白講」的告警時機必須一致,否則使用者只會覺得提示不可靠。

type ModelState = {
  status: 'none' | 'loading' | 'ready' | 'error'
  progress: number
  file: string
  msg?: string
}

export default function Record({ onGuardChange }: { onGuardChange?: (msg: string | null) => void } = {}): JSX.Element {
  const { settings } = useSettings()
  const [recording, setRecording] = useState(false)
  /**
   * 「正在錄音」的鏡像 ref。兩個用途:
   *   1. 退出前存檔由 main 端用 executeJavaScript 觸發,那時不能假設
   *      React state 是最新一次 render 的值。
   *   2. 通知 main(`setRecording`),讓 App 退出流程知道該不該先存檔 ——
   *      before-quit 會繞過視窗守衛,逐字稿卻只存在這個進程的記憶體裡。
   */
  const recordingRef = useRef(false)
  /** start() 的多步 await(模型載入/麥克風/AudioContext)期間擋再按:
   *  雙擊會讓第一組 stream/segmenter ref 被覆蓋而永久洩漏,且兩組分段器重複送轉錄 */
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)
  const [wantMic, setWantMic] = useState(true)
  const [wantSys, setWantSys] = useState(false)
  /**
   * 本視窗內已存成講稿的 session id(畫面快取)。
   * 事實在 MeetingSession.savedAsScriptId —— 只靠這個 Set 的話,切頁/重啟就歸零,
   * 再按一次會產生第二份同內容講稿(見 lib/sessionToScript.ts)。
   */
  const [savedAsScriptIds, setSavedAsScriptIds] = useState<Set<number>>(new Set())
  /**
   * 現存的講稿 id。null = 還沒問過資料庫。
   *
   * 為什麼需要:「已存成講稿」不能只看 session 上的 savedAsScriptId —— 那份講稿
   * 可以被刪掉(講稿頁有刪除鈕),參照卻會留著,於是按鈕永遠停在 disabled 的
   * 「已存成講稿」,使用者既看不到那份稿,也再也存不成。
   *
   * 一次把主鍵全部載進 Set(而不是每次 render 去問 DB):這頁有 15 場會議的按鈕,
   * 每個都要判斷一次。
   */
  const [scriptIds, setScriptIds] = useState<Set<number> | null>(null)
  const [micLevel, setMicLevel] = useState(0)
  const [sysLevel, setSysLevel] = useState(0)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [title, setTitle] = useState('')
  const [model, setModel] = useState<ModelState>({ status: 'none', progress: 0, file: '' })
  const [saving, setSaving] = useState(false)
  /** stop() 的多步 await(等在飛轉錄落地、寫 DB)期間擋再按:
   *  雙擊會重複跑收帳/存檔流程(重複 toast、重複 build report、第二次可能存進空段落) */
  const stoppingRef = useRef(false)
  const startAttemptRef = useRef(0)
  const [sessions, setSessions] = useState<MeetingSession[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [aiBusyId, setAiBusyId] = useState<number | null>(null)
  /** 在飛的摘要請求的取消函式(見 lib/ai.ts 的 startAiChat) */
  const cancelSummaryRef = useRef<(() => void) | null>(null)
  const [lastReport, setLastReport] = useState<SessionReport | null>(null)
  /**
   * 這份會後報告是哪一場的。
   *
   * 為什麼需要:報告一旦產生就會一直留在畫面上直到下次「開始聆聽」,而「沒有段落」
   * 的收場(真的沒說話 / 說了但辨識失敗)不會覆蓋它 —— 使用者看到的是一份沒有
   * 出處的漂亮報告,很自然會當成「這一場」的結果。加上名稱與時間之後,殘留期間
   * 也讀得出來它是誰,並且可以直接關掉。
   */
  const [lastReportMeta, setLastReportMeta] = useState<{ title: string; endedAt: number } | null>(null)

  /**
   * 辨識失敗的累積狀態。
   *
   * 為什麼要有這個:原本每個失敗的段落都直接 toast.error 一次。持續失敗時
   * (雲端 401、模型沒下載、斷網)畫面會幾秒一個錯誤跳出來,堆滿並蓋住錄音介面。
   * 使用者收到的是「一直有東西出錯」的噪音,而不是「你現在講的話不會被儲存,
   * 請立刻停止」—— 他很可能就這樣把整場會議講完,最後拿到一份空紀錄。
   * 改成:連續失敗達門檻後只顯示一個持續的橫幅,取代重複的 toast。
   */
  const [sttFailed, setSttFailed] = useState(false)
  const sttFailStreakRef = useRef(0)
  /** 送出去等結果的段落數。用來分辨「真的沒說話」與「說了但辨識失敗」 */
  const sttAttemptedRef = useRef(0)
  const sttNotifiedRef = useRef(false)

  const whisperRef = useRef<WhisperClient | null>(null)
  const segsRef = useRef<TranscriptSegment[]>([])
  /** 保存本場實際起始時間；UI 計時器停止時 startedAtRef 歸零，但在飛轉錄仍要用此值定時間戳 */
  const sessionStartedAtRef = useRef(0)
  const sessionIdRef = useRef(0)
  // 在飛的辨識請求由 lib/transcriptionQueue 追蹤(與 Practice 頁同一份實作)
  const pendingRef = useRef(createPendingTracker<number>())
  const startedAtRef = useRef(0)
  const streamsRef = useRef<{ mic?: MediaStream; sys?: MediaStream }>({})
  const segmentersRef = useRef<{ mic?: AudioSegmenter; sys?: AudioSegmenter }>({})
  const transcriptBoxRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef('')
  titleRef.current = title
  const wantMicRef = useRef(wantMic)
  wantMicRef.current = wantMic
  const wantSysRef = useRef(wantSys)
  wantSysRef.current = wantSys
  /**
   * 這一場的寫入器。「只寫一次」的守衛住在裡面(見 lib/sessionPersist.ts 的
   * 檔頭):正常 stop() 與退出前存檔共用同一個實例,才不會寫出兩場會議。
   */
  const persisterRef = useRef(createSessionPersister())

  /**
   * 把「現在這場」寫進 IndexedDB。**正常 stop() 與退出前存檔共用這一段。**
   *
   * 為什麼讀 refs 而不是 state:退出前存檔是 main 端用 executeJavaScript
   * 觸發的,那一刻 React 的 state 可能已經不是最新一次 render 的值。
   *
   * 真實的演算法與「只寫一次」守衛在 lib/sessionPersist.ts —— 抽出來是為了
   * 讓它有可測的接縫(元件內的函式測不到),也在於兩條路徑必須保證是同一份。
   */
  const persistNow = async (
    // 呼叫端可以帶入已經算好的時間。
    //
    // 為什麼需要這個參數:stop() 會在呼叫 persistNow **之前**把
    // `startedAtRef.current` 歸零(那個時間已經被 stop() 存進自己的區域變數)。
    // 如果 persistNow 自己去讀 refs,它會讀到 0 → durationSec 算出來是 0 →
    // 會後報告卡因為 `durationSec > 0` 不成立而**整張不出現**,而且存進
    // IndexedDB 的 startedAt 也變成「現在」。這是抽出共用函式時最容易犯、
    // 而且症狀最不相關的一類錯(畫面上看起來像「報告不顯示」而不是「時間算錯」)。
    opts?: { startedAt?: number; endedAt?: number }
  ): Promise<MeetingSession | null> => {
    const startedAt = opts?.startedAt ?? (sessionStartedAtRef.current || startedAtRef.current)
    let coachingCounts: Partial<Record<CoachingKind, number>> | undefined
    try {
      coachingCounts = await window.api.coachingStats()
    } catch {
      // 計數不可得不影響報告本體(與 stop() 的既有行為一致)
    }
    const endedAt = opts?.endedAt ?? Date.now()
    return persisterRef.current.persist({
      segments: segsRef.current,
      startedAt: startedAt || endedAt,
      endedAt,
      title: titleRef.current,
      speakerAvailability: { me: wantMicRef.current, them: wantSysRef.current },
      personalCpm: personalCpmBaseline,
      coachingCounts
    })
  }

  /**
   * 退出前存檔的掛鉤。main 端在 `before-quit` 用 executeJavaScript 叫它
   * (見 src/main/quitGuard.ts)。
   *
   * 為什麼掛成 window 上的函式:contextIsolation 之下 preload 的 world 和
   * renderer 的 world 分開,main 叫不到元件內的函式;而
   * `webContents.executeJavaScript` 跑在 page 的 **main world**,正是這裡。
   */
  useEffect(() => {
    // 回 boolean 而不是 session:executeJavaScript 的結果會被序列化回 main 端,
    // 整份逐字稿走一趟 IPC 沒有任何好處。main 只需要知道「存了沒有」。
    const w = window as Window & { __aiTpFlushRecording?: () => Promise<boolean> }
    w.__aiTpFlushRecording = async () => {
      // 沒在錄音就不動作:「使用者只是改設定就關 App」不該憑空多出一場會議。
      if (!recordingRef.current) return false
      return (await persistNow()) !== null
    }
    return () => {
      delete w.__aiTpFlushRecording
    }
  })

  /**
   * recordingRef 跟著 state 走,並在每次改變時通知 main。
   *
   * 為什麼兩件事都要做:
   *   1. ref:退出前存檔是由 main 用 executeJavaScript 觸發的,那一刻不能假設
   *      React state 是最新一次 render 的值。
   *   2. IPC:讓 App 退出流程知道該不該先存檔 —— before-quit 會繞過視窗守衛,
   *      逐字稿卻只存在這個進程的記憶體裡。
   *
   * 這段曾經整段不見過(被另一段抽取程式碼時一起刪掉),而症狀是
   * 「退出前存檔永遠回傳 false」—— 型別檢查與單元測試都抓不到,
   * 因為 ref 宣告還在、只是沒有任何地方寫入它。**ref 宣告存在不代表它會被更新。**
   */
  useEffect(() => {
    recordingRef.current = recording
    void window.api.setRecording(recording).catch(() => undefined)
  }, [recording])

  const engine = settings?.stt.engine ?? 'local'
  /** 使用者的個人語速基準(字/分);沒校準過就是 null。報告的語速建議與卡片標示共用它。 */
  const personalCpmBaseline = settings?.personal.profile?.charsPerMin ?? null
  const modelKey = (settings?.stt.localModel ?? 'base') as WhisperModelKey

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessions(await db.sessions.orderBy('startedAt').reverse().limit(15).toArray())
    // 「已存成講稿」需要知道哪些講稿**還在**(見 scriptIds 的註解)。
    // 與 sessions 一起載入:同一個 useEffect 觸發,不會出現「按鈕已顯示舊判定」的瞬間。
    const keys = await db.scripts.toCollection().primaryKeys()
    setScriptIds(new Set(keys as number[]))
  }, [])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    const t = setInterval(() => {
      if (startedAtRef.current > 0) setElapsed((Date.now() - startedAtRef.current) / 1000)
    }, 500)
    return () => clearInterval(t)
  }, [])

  // 自動捲動:只在使用者本來就在底部時跟隨。
  // 錄音中往上回讀是明確意圖,每個新段落把畫面拽回底部會讓「回讀」變成不可能。
  // 「是否在底部」必須在 DOM 更新前記帳:段落渲染後 scrollHeight 已長高,
  // 那時才量的話,「本來在底部」會被誤判成「不在底部」而永遠不跟。
  const atBottomRef = useRef(true)
  useEffect(() => {
    const el = transcriptBoxRef.current
    if (!el) return
    const onScroll = (): void => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = transcriptBoxRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [segments])

  // unmount 清理:錄音中切頁要收掉分段器與音訊 track(麥克風/系統音訊燈滅),
  // 否則擷取會在背景持續運作(Practice 已有同樣模式);
  /**
   * 關閉視窗守衛:錄音中關掉等於整場會議沒有逐字稿(離場只做 stopAll,不寫 DB)。
   *
   * 刻意不「自動停止並存檔」:stop() 的收尾會等所有在飛的辨識落地(最長 65 秒),
   * 把那段等待塞進關窗流程會讓 App 看起來像當掉。這裡改成明確告訴使用者
   * 先按停止,他要硬關仍然可以(對話框上有明確的「放棄並關閉」)。
   */
  useCloseGuard(
    'record-recording',
    recording
      ? '正在錄音。請先按「停止並儲存」再關閉,否則這場會議不會留下任何逐字稿。'
      : saving
        ? // 收尾中(最長 65 秒等待在飛的辨識):原本這一段也講「請先按停止並儲存」,
          // 但那時候按鈕已經是 disabled 的「儲存中…」—— 叫使用者去按一顆不存在的按鈕。
          '正在收尾:還在等最後幾段語音辨識回來。現在關閉會遺失尾段逐字稿。'
        : null
  )

  // 切頁守衛:關窗有上面的 useCloseGuard,側欄切頁原本沒有 —— 錄音中點側欄會把
  // 整場會議靜默丟掉(unmount 只 stopAll,不寫 DB,麥克風燈滅就是使用者看到的全部)。
  // 與 Scripts 的 onDirtyChange 同一模式:訊息由頁面上報,App.navigate 攔下確認。
  useEffect(() => {
    const msg = recording
      ? '正在錄音。離開「錄音轉錄」會讓這場會議不留任何逐字稿。'
      : saving
        ? '正在收尾:還在等最後幾段語音辨識回來。現在離開會遺失尾段逐字稿。'
        : null
    onGuardChange?.(msg)
    return () => onGuardChange?.(null)
  }, [recording, saving, onGuardChange])

  // 稽核用:展開第 N 場會議(會後報告/摘要只有展開後才存在於 DOM,
  // 是「從來沒被量測過」的其中一個深狀態)。
  useEffect(
    () =>
      registerAuditControl('record.expandSession', (arg) => {
        const s = sessions[Number(arg)]
        if (!s) return false
        setExpandedId(s.id ?? null)
        return true
      }),
    [sessions]
  )

  /**
   * 稽核用:強制進入「會改變版面」的狀態。
   *
   * 為什麼這些只能靠橋推進,不能靠腳本點:辨識失敗橫幅的門檻是**連續 3 次**
   * STT 失敗(STT_FAILURE_BANNER_THRESHOLD),headless 沒有麥克風也沒有模型,
   * 怎麼點都走不到那三次失敗。模型下載卡同理 —— 它由 Whisper 的進度回呼驅動。
   * 結果是:這三個狀態從未被任何一支稽核掃過,而「辨識持續失敗,你的話不會被儲存」
   * 是使用者唯一會知道自己在白講的提示。
   *
   * arg 形狀:傳入要設的狀態;不傳則把三個都設成典型值。
   */
  useEffect(
    () =>
      registerAuditControl('record.branchState', (arg) => {
        const want = typeof arg === 'string' ? arg : 'stt-failed'
        if (want === 'stt-failed') {
          // 橫幅現在只在錄音中渲染(停止後留著會與「會後報告已儲存」矛盾),
          // 所以強制這個狀態要一併打開 recording:稽核量的是「錄音中辨識持續
          // 失敗」這個使用者真的會處在的狀態,不是一個單獨的 boolean。
          setRecording(true)
          setSttFailed(true)
          return true
        }
        if (want === 'model-loading') {
          setModel({ status: 'loading', progress: 37, file: 'ggml-base.bin' })
          return true
        }
        if (want === 'model-error') {
          setModel({ status: 'error', progress: 0, file: '', msg: '模型下載失敗：磁碟空間不足' })
          return true
        }
        if (want === 'report') {
          setLastReport({
            durationSec: 754,
            mySec: 388,
            theirSec: 366,
            talkRatio: 0.51,
            myUnits: 1284,
            myCpm: 198,
            turnCount: 23,
            avgMyTurnSec: 16.9,
            longestMyTurnSec: 74.2,
            gapCount: 6,
            gapTotalSec: 41.5,
            theirQuestionCount: 9,
            steadiness: 72,
            suggestions: [
              { severity: 'high', message: '最長的一段連續發言是 74 秒,對方沒有插話空間' },
              { severity: 'medium', message: '有 6 次超過 5 秒的冷場,平均 6.9 秒' }
            ],
            generatedAt: Date.now()
          })
          return true
        }
        return false
      }),
    []
  )

  // Whisper worker 帶著數百 MB 模型,離頁一併釋放(Cache API 快取仍在,重進免重新下載)
  useEffect(() => {
    return () => {
      startAttemptRef.current += 1
      sessionIdRef.current += 1
      stopAll()
      void window.api.powerSaveStop()
      whisperRef.current?.dispose()
      whisperRef.current = null
    }
  }, [])

  // 錄音中的環境指示(見 lib/captureIndicator.ts):最小化後「還在錄」要看得出來。
  // 收尾中(saving)也算 —— 那段等待最長 65 秒,同樣會被最小化。
  useEffect(() => {
    setCaptureIndicator(
      'record',
      recording ? '● 錄音中 — AI 提詞機' : saving ? '收尾中 — AI 提詞機' : null
    )
  }, [recording, saving])
  // 離頁必還原:unmount 不會再觸發上面那個 effect 的「設成 null」分支
  useEffect(() => () => setCaptureIndicator('record', null), [])

  const ensureWhisper = async (): Promise<void> => {
    if (!whisperRef.current) {
      const client = new WhisperClient()
      client.onProgress = (p) => {
        if (p.status === 'progress' || p.status === 'initiate') {
          setModel((m) =>
            m.status === 'loading'
              ? { ...m, progress: p.progress ?? m.progress, file: p.file ?? m.file }
              : m
          )
        }
      }
      client.onStatus = (message) => setModel((m) => ({ ...m, msg: message }))
      whisperRef.current = client
    }
    const client = whisperRef.current
    if (!client.isLoaded()) {
      setModel({ status: 'loading', progress: 0, file: '' })
      try {
        const device = await client.load(modelKey)
        setModel({ status: 'ready', progress: 100, file: '', msg: device === 'webgpu' ? 'WebGPU 加速' : 'CPU 模式' })
      } catch (err) {
        setModel({ status: 'error', progress: 0, file: '', msg: err instanceof Error ? err.message : String(err) })
        throw err
      }
    } else {
      setModel((m) => (m.status === 'ready' ? m : { ...m, status: 'ready', progress: 100 }))
    }
  }

  const transcribeSegment = async (
    audio: Float32Array,
    sr: number,
    speaker: 'me' | 'them',
    sessionId: number,
    sessionStartedAt: number,
    segmentEndedAt: number,
    metadata: AudioSegmentMetadata
  ): Promise<void> => {
    if (!settings) return
    try {
      let text = ''
      if (settings.stt.engine === 'local') {
        await ensureWhisper()
        text = await whisperRef.current!.transcribe(audio, settings.stt.language)
      } else {
        const { baseUrl, apiKey, model: m } = settings.stt.cloud
        if (!baseUrl || !m) throw new Error('請先在設定頁填入雲端語音 API 的 Base URL 與模型')
        const res = await window.api.cloudTranscribe({
          baseUrl,
          apiKey,
          model: m,
          audio: encodeWav(audio, sr),
          language: settings.stt.language
        })
        if (!res.ok) throw new Error(res.error ?? '語音辨識失敗')
        text = res.text ?? ''
      }
      if (!text.trim() || sessionId !== sessionIdRef.current) return
      // 時間戳取自音訊分段完成時，不是 ASR 回應時間；雲端延遲不應改寫語音發生時間。
      const bufferEnd = Math.max(0, (segmentEndedAt - sessionStartedAt) / 1000)
      const end = Math.max(0, bufferEnd - metadata.trailingSilenceSec)
      const start = Math.max(0, bufferEnd - audio.length / sr + metadata.leadingSilenceSec)
      const seg: TranscriptSegment = {
        speaker,
        text: text.trim(),
        start: Math.min(start, end),
        end,
        speechDurationSec: metadata.speechDurationSec
      }
      // ASR requests from mic and system audio run concurrently; completion order is
      // not speech order. Keep the live transcript and persisted report chronological.
      segsRef.current = sortTranscriptSegments([...segsRef.current, seg])
      setSegments(segsRef.current)
      // 成功一次就代表 STT 通了:清掉失敗累積,橫幅自動消失
      sttFailStreakRef.current = 0
      if (sttNotifiedRef.current) {
        sttNotifiedRef.current = false
        setSttFailed(false)
      }
      // 餵 main 的 liveContext:panic(Alt+P)才有「對方問了什麼」的上下文
      void window.api.pushTranscript({ text: seg.text, speaker })
    } catch (err) {
      if (sessionId === sessionIdRef.current) {
        // 失敗不每段都跳 toast —— 那會變成風暴並蓋住錄音介面。
        // 改為累積連續次數,達門檻後顯示一個持續的橫幅;
        // 單次失敗(例如剛開錄時模型還沒載好)仍然給一次 toast。
        sttFailStreakRef.current += 1
        const streak = sttFailStreakRef.current
        // 本地引擎的失敗(模型、WebGPU)與雲端 API 的失敗(金鑰、網路、逾時)
        // 需要不同的診斷;不給 ctx 時只給中性訊息,不臆測。
        const ctx = settings.stt.engine === 'cloud' ? { provider: 'cloud-api' as const } : undefined
        // 事件只在「第一次失敗」時帶環境欄位:連續失敗是同一件事,而診斷報告要的是
        // 「這場會議轉錄失敗過、當時用的哪個引擎」而不是「失敗了幾十次」
        // (recordEvent 本身也有 5 秒抑制,這裡先擋掉的主要是「不該因為 banner
        //  而變得每段都寫一次」)。引擎/模型掛在 transcribe_failed 的 fields 上 ——
        // 「started」事件在 startInner 真正開始時記,不在这里冒名。
        const firstFailure = !sttNotifiedRef.current
        const sttFields = { engine: settings.stt.engine, model: settings.stt.localModel }
        if (streak >= STT_FAILURE_BANNER_THRESHOLD) {
          if (!sttNotifiedRef.current) {
            sttNotifiedRef.current = true
            reportError('語音辨識失敗', err, { event: 'transcribe_failed', ...ctx, fields: sttFields })
          }
          setSttFailed(true)
        } else {
          reportError('語音辨識失敗', err, {
            event: 'transcribe_failed',
            ...ctx,
            fields: firstFailure ? sttFields : undefined,
            // 累積型失敗只寫事件、不跳 toast(quiet):橫幅已經在講同一件事了。
            quiet: streak > 1
          })
        }
      }
    }
  }

  /** 精確追蹤每個 VAD flush/segmenter 送出的轉錄 Promise，停止時才不靠段落數猜測是否完成。 */
  const queueTranscription = (
    audio: Float32Array,
    sr: number,
    speaker: 'me' | 'them',
    metadata: AudioSegmentMetadata
  ): void => {
    const sessionId = sessionIdRef.current
    const sessionStartedAt = sessionStartedAtRef.current
    const segmentEndedAt = Date.now()
    const job = transcribeSegment(audio, sr, speaker, sessionId, sessionStartedAt, segmentEndedAt, metadata)
    // 送出就算一次「有偵測到語音」——不管結果成功或失敗。
    // 停止時靠它分辨「真的沒說話」與「說了但辨識失敗」。
    sttAttemptedRef.current += 1
    pendingRef.current.track(sessionId, job)
  }

  const start = async (): Promise<void> => {
    if (startingRef.current || stoppingRef.current || recording || saving) return
    startingRef.current = true
    setStarting(true)
    const attempt = ++startAttemptRef.current
    const abandonStart = (): void => {
      if (attempt === startAttemptRef.current) {
        startingRef.current = false
        setStarting(false)
      }
    }
    try {
      await startInner(attempt)
    } finally {
      abandonStart()
    }
  }

  const startInner = async (attempt: number): Promise<void> => {
    if (!wantMic && !wantSys) {
      toast.error('請至少選擇一個音訊來源')
      return
    }
    // 雲端引擎未設定就 fail-fast:原本要等開麥之後第一段轉錄失敗才知道,
    // 使用者已經講了半分鐘、而且要自己從錯誤訊息反推「去設定頁」。
    if (settings?.stt.engine === 'cloud' && (!settings.stt.cloud.baseUrl || !settings.stt.cloud.model)) {
      toast.error('請先在設定頁填入雲端語音 API 的 Base URL 與模型,再開始錄音')
      return
    }
    // Request system-audio capture while still inside the user's start action.
    // Loading Whisper first may take minutes and loses the transient user activation
    // required by getDisplayMedia in Chromium/Electron.
    if (wantSys) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        stream.getVideoTracks().forEach((t) => t.stop()) // 只留音訊
        if (attempt !== startAttemptRef.current) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach((t) => t.stop())
          throw new Error('系統音訊擷取被取消或不可用')
        }
        streamsRef.current.sys = stream
      } catch (err) {
        // main 端 setDisplayMediaRequestHandler核准不到來源時,這裡收到的是
        // NotAllowedError —— 交給規則比對會被麥克風那條接走,把使用者導去改
        // 一個不相關的系統設定。所以這裡**指定**系統音訊的錯誤碼,
        // 不用 try 的錯誤內容去猜(這個專案記錄過的原則:成因已知就直接講)。
        if (attempt === startAttemptRef.current) {
          reportCode('E_SYSTEM_AUDIO_UNAVAILABLE', err, { event: 'transcribe_failed' })
        }
        return
      }
    }
    if (settings?.stt.engine === 'local') {
      try {
        await ensureWhisper()
      } catch (err) {
        stopAll()
        // 原本靜默 return:模型下載失敗(斷網/磁碟滿)時按鈕卡在「啟動中」,
        // 畫面上沒有任何話解釋為什麼。模型載入與「開麥」是兩種不同的失敗,
        // 訊息也要分開 —— 叫使用者去查麥克風權限是錯診斷。
        startingRef.current = false
        setStarting(false)
        reportError('語音模型載入失敗,無法開始轉錄', err, { event: 'transcribe_failed' })
        return
      }
      if (attempt !== startAttemptRef.current) {
        stopAll()
        startingRef.current = false
        setStarting(false)
        return
      }
    }
    segsRef.current = []
    setSegments([])
    // 新的一場:上一場若已經存過(含退出前存檔),這裡要把「已存檔」的事實清掉,
    // 否則寫入器會以為這一場也存過而拒絕寫入 —— 結果是第二場會議無聲無息地
    // 沒有被儲存。
    persisterRef.current.reset()
    // 新的一場開始,上一場的報告立刻下架:留著只會誤導(見 lastReportMeta)
    setLastReport(null)
    setLastReportMeta(null)
    startedAtRef.current = Date.now()
    sessionStartedAtRef.current = startedAtRef.current
    sessionIdRef.current += 1
    setElapsed(0)

    try {
      // 會話邊界:清上一場的語音上下文與即時回饋冷卻狀態
      await window.api.contextReset()
      sttAttemptedRef.current = 0
      sttFailStreakRef.current = 0
      sttNotifiedRef.current = false
      setSttFailed(false)
      if (attempt !== startAttemptRef.current) {
        sessionStartedAtRef.current = 0
        startingRef.current = false
        setStarting(false)
        return
      }
      if (wantMic) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
        if (attempt !== startAttemptRef.current) {
          stream.getTracks().forEach((t) => t.stop())
          sessionStartedAtRef.current = 0
          startingRef.current = false
          setStarting(false)
          return
        }
        streamsRef.current.mic = stream
        segmentersRef.current.mic = new AudioSegmenter({
          onSegment: (a, sr, metadata) => queueTranscription(a, sr, 'me', metadata),
          onLevel: setMicLevel,
          threshold: 0.01
        })
        await segmentersRef.current.mic.start(stream)
      }
      if (wantSys) {
        const stream = streamsRef.current.sys
        if (!stream) throw new Error('系統音訊擷取已中止，請重新開始')
        segmentersRef.current.sys = new AudioSegmenter({
          onSegment: (a, sr, metadata) => queueTranscription(a, sr, 'them', metadata),
          onLevel: setSysLevel,
          threshold: 0.018
        })
        await segmentersRef.current.sys.start(stream)
      }
      if (attempt !== startAttemptRef.current) {
        stopAll()
        sessionStartedAtRef.current = 0
        startingRef.current = false
        setStarting(false)
        return
      }
      setRecording(true)
      // 開會的人常常已經沒在碰電腦(正是系統會想睡覺的時候):轉錄期間
      // 阻止系統睡眠,停止時解除(見 ipc.ts 的 powerSaveBlocker)。
      void window.api.powerSaveStart()
      // 「這場會議有真的嘗試過轉錄」的唯一錨點。沒有它的話,診斷報告裡
      // 「從來沒按過開始」與「按了但全部失敗」長得一樣 —— 而那正是回報者
      // 最常提供的資訊(「我按了,沒反應」)。engine/model 讓報告直接回答
      // 「他用的是哪個引擎」這個九成問題的第一個。
      reportEvent('transcribe_started', {
        fields: { engine: settings?.stt.engine ?? 'local', model: settings?.stt.localModel ?? 'base' }
      })
    } catch (err) {
      stopAll()
      startedAtRef.current = 0
      sessionStartedAtRef.current = 0
      sessionIdRef.current += 1
      if (attempt === startAttemptRef.current) {
        startingRef.current = false
        setStarting(false)
        // 開麥失敗是整個 App 最常見的第一個牆。帶 provider 情境讓它知道
        // 是雲端 STT 還是本地 —— 金鑰錯與模型沒下載的診斷完全不同。
        reportError('無法開啟麥克風', err, {
          event: 'transcribe_failed',
          ...(settings?.stt.engine === 'cloud' ? { provider: 'cloud-api' as const } : {})
        })
      }
    }
  }

  const stopAll = (): void => {
    segmentersRef.current.mic?.stop()
    segmentersRef.current.sys?.stop()
    streamsRef.current.mic?.getTracks().forEach((t) => t.stop())
    streamsRef.current.sys?.getTracks().forEach((t) => t.stop())
    segmentersRef.current = {}
    streamsRef.current = {}
    setMicLevel(0)
    setSysLevel(0)
  }

  const stop = async (): Promise<void> => {
    if (stoppingRef.current || saving) return
    stoppingRef.current = true
    setSaving(true)
    try {
      setRecording(false)
      // 在歸零之前捕捉起始時間；保留 sessionStartedAtRef 供已送出的轉錄回呼使用。
      const sessionId = sessionIdRef.current
      const startedAt = sessionStartedAtRef.current || startedAtRef.current
      const endedAt = Date.now()
      startedAtRef.current = 0
      stopAll() // stop() 同步 flush 最後音訊，會在此處將它加入本場 pending set

      // 雲端 API 有 60 秒 timeout；等待本場已送出的請求完成，避免 4 秒猜測窗造成尾段逐字稿遺失。
      // (等待期間的「收尾中…」由 stop() 開頭的 setSaving(true) 提供，見下方按鈕)
      const drained = await drainPending(pendingRef.current.take(sessionId), 65_000)
      // timeout 後隔離舊 session，避免晚到結果被寫入下一場會議。
      sessionIdRef.current += 1
      sessionStartedAtRef.current = 0
      if (!drained.drained) toast.error(`部分語音辨識逾時(${drained.outstanding} 段未完成)，已先儲存目前可用的逐字稿`)

      if (segsRef.current.length > 0) {
        try {
          const segments = segsRef.current
          // 會話量化報告:與 session 一起存,供 Dashboard 趨勢使用;
          // 併入會議期間的 coaching 觸發計數,形成改進閉環
          const sessionTitle = titleRef.current.trim() || `會議 ${formatDateTime(startedAt)}`
          // 報告由 persistNow 裡的寫入器算並回傳 —— 這裡**不再自己算第二次**。
          // 算兩次會有兩份統計,而它們只在其中一條路徑(退出前存檔)不一致,
          // 那是最難被使用者自己發現、也最難回報的形狀。
          const saved = await persistNow({ startedAt, endedAt })
          if (!saved) throw new Error('會議寫入失敗')
          setLastReport(saved.report ?? null)
          setLastReportMeta({ title: saved.title, endedAt })
          // 收帳成功的錨點:與 transcribe_started / transcribe_failed 配對,
          // 「這場會議從開始到存檔」的整條故事在診斷報告裡才讀得完整。
          reportEvent('transcribe_succeeded', {
            metrics: { segments: segments.length },
            fields: { engine: settings?.stt.engine ?? 'local' }
          })
          await refreshSessions()
        } catch (err) {
          // 寫入失敗 = 整場會議不見了。使用者已經講了十幾分鐘,
          // 這是這個專案記錄過最貴的失敗模式(靜默失敗讓人以為存好了)。
          reportError('會議紀錄儲存失敗', err, { event: 'transcribe_failed' })
        }
      } else {
        // 「沒有段落」有兩種完全不同的原因,原本用同一句話講,等於給錯診斷:
        //   a) sttAttempted === 0 → 使用者真的沒說話
        //   b) sttAttempted  > 0 → 偵測到語音但辨識失敗
        // (b) 的情況下使用者明明整場都在說話,看到「沒有偵測到語音」會以為
        // 麥克風壞了、去查硬體 —— 浪費的是他的時間,而且真正的問題被埋掉了。
        if (sttAttemptedRef.current > 0) {
          toast.error(
            '偵測到你的語音,但語音辨識沒有成功——這場會議沒有被儲存。請確認模型已下載或雲端 API 金鑰有效後重新錄音。'
          )
        } else {
          toast.info('這次沒有偵測到語音,未建立會議紀錄')
        }
      }
    } finally {
      sessionStartedAtRef.current = 0
      stoppingRef.current = false
      setSaving(false)
      void window.api.powerSaveStop()
      // 會話結束就把 main 端的語音上下文丟掉(成功、失敗、取消都算)。
      //
      // 為什麼要在「停止」清、而不是只在「開始」清:contextReset 原本只在
      // startRecording 呼叫,於是**停止之後到下一場開始之前**,main 端仍然留著
      // 上一場的逐字稿與冷卻狀態。這段縫隙裡按 Alt+P(Panic 救援),AI 會拿著
      // 上一場會議的內容去回答 —— 而「把不該外送的內容送到雲端」正是這個 App
      // 在資料信任面板上對使用者承諾不會發生的事。
      void window.api.contextReset()
    }
  }

  /**
   * 把逐字稿存成一份講稿。
   *
   * 為什麼需要這個轉換(使用者視角稽核 scripts/audit-journey.mjs 量到的唯一死路):
   *   這個 App 是提詞機,但錄音產出的是「會議紀錄」。使用者開完會拿到逐字稿,
   *   最自然的下一步是「把這段變成我下次要用的講稿」—— 而程式裡沒有任何一條路
   *   做得到,唯一的下游動作是「匯出 .md 到磁碟」。他得自己開記事本複製貼上到
   *   講稿頁,而這一步沒有任何 UI 指引。**產出的東西和使用者累積的內容被隔離在
   *   兩個 store 裡,而其中一邊是這個產品的主功能。**
   *
   * 格式的選擇:只取**我方**的發言。提詞是給自己講的,對方的話不需要念出來;
   *   全部段落混在一起會變成一份「會議逐字稿」而不是講稿。
   *   段落前保留時間戳是刻意的 —— 講稿需要能對照原文位置。
   */
  /**
   * 「已存成講稿」的判斷:畫面快取(Set)+ 事實(MeetingSession.savedAsScriptId)。
   *
   * 只看 Set 的話,切頁再回來(或重啟)就歸零 —— 按鈕回到「存成講稿」,
   * 再按一次就產生兩份一模一樣的講稿。savedAsScriptId 存在 IndexedDB,
   * 是跨頁、跨重啟都成立的事實(見 lib/sessionToScript.ts)。
   */
  const isSavedAsScript = (s: MeetingSession): boolean =>
    isSessionSavedAsScript(s, scriptIds, savedAsScriptIds)

  /**
   * 把逐字稿存成一份講稿。
   *
   * 為什麼需要這個轉換(使用者視角稽核 scripts/audit-journey.mjs 量到的唯一死路):
   *   這個 App 是提詞機,但錄音產出的是「會議紀錄」。使用者開完會拿到逐字稿,
   *   最自然的下一步是「把這段變成我下次要用的講稿」—— 而程式裡沒有任何一條路
   *   做得到,唯一的下游動作是「匯出 .md 到磁碟」。他得自己開記事本複製貼上到
   *   講稿頁,而這一步沒有任何 UI 指引。**產出的東西和使用者累積的內容被隔離在
   *   兩個 store 裡,而其中一邊是這個產品的主功能。**
   *
   * 格式與防重複的決定都在 lib/sessionToScript.ts(資料層):
   * 只取**我方**的發言、段落前保留時間戳;「存過了」以 savedAsScriptId 為準,
   * 重複呼叫冪等 —— 不會產生兩份一模一樣的講稿。
   */
  const saveTranscriptAsScript = async (s: MeetingSession): Promise<void> => {
    // 重複防護:按鈕沒有 busy 態,使用者不確定是否成功時會再按一次。
    if (isSavedAsScript(s)) {
      toast.info('這場已經存成講稿了,在「提詞講稿」頁')
      return
    }
    let scriptId: number
    try {
      const res = await saveSessionAsScript(s)
      if (!res.ok) {
        toast.error('這場會議沒有可以存成講稿的內容')
        return
      }
      scriptId = res.scriptId
    } catch (err) {
      // 寫入失敗(IndexedDB 滿/隱私模式)要有聲,而不是靜默失敗讓使用者以為存好了
      reportError('講稿儲存失敗', err, { event: 'backup_failed' })
      return
    }
    // 不跨頁跳轉:Scripts 進頁時本來就會自動選中最新的那一份(orderBy updatedAt desc),
    // 所以 toast 裡直接給出下一步就好。使用者按完會看到「已存成講稿」並知道去哪找 ——
    // 硬加一個跨頁跳轉得動 App 的 navigate 簽章,那是為了順手而擴大改動面。
    const sid = s.id
    if (sid != null) {
      setSavedAsScriptIds((prev) => new Set(prev).add(sid))
      // sessions state 跟著補上事實:按鈕的 disabled/文案讀的是它
      setSessions((prev) => prev.map((x) => (x.id === sid ? { ...x, savedAsScriptId: scriptId } : x)))
    }
    // 剛建立的講稿要立刻算進「現存的講稿」,否則這顆按鈕會因為
    // 「參照的 id 不在 scriptIds 裡」而看起來仍然沒存過。
    setScriptIds((prev) => new Set(prev ?? []).add(scriptId))
    toast.success(`已存成講稿:${s.title}（講稿）,在「提詞講稿」頁`)
  }

  const exportSession = async (s: MeetingSession): Promise<void> => {
    const lines = [`# ${s.title}`, '', `時間：${formatDateTime(s.startedAt)}`, '']
    if (s.summary) {
      lines.push('## 摘要', s.summary.abstract, '', '## 重點')
      s.summary.keyPoints.forEach((k) => lines.push(`- ${k}`))
      lines.push('', '## 待辦')
      s.summary.todos.forEach((t) => lines.push(`- [ ] ${t}`))
      lines.push('')
    }
    lines.push('## 逐字稿')
    s.segments.forEach((seg) => {
      const who = seg.speaker === 'me' ? '我' : '對方'
      lines.push(`**[${formatDuration(seg.start)}] ${who}**：${seg.text}`)
    })
    try {
      const res = await window.api.exportFile({
        defaultName: `${s.title.replace(/[\\/:*?"<>|]/g, '_')}.md`,
        content: lines.join('\n')
      })
      // canceled 是使用者主動取消,不是失敗;除此之外的 no 都要說人話。
      // 原本結果整個沒看:寫入失敗(磁碟滿/無權限)是靜默的,使用者以為匯出成功了。
      if (!res.ok && res.error !== 'canceled') toast.error(`匯出失敗(${res.error ?? '未知錯誤'})`)
    } catch (err) {
      reportError('匯出失敗', err, { event: 'backup_failed' })
    }
  }

  /**
   * 複製行動清單。
   *
   * 為什麼這一鍵很重要:會後報告是**觀察**(你講了 62%、冷場 3 次),
   * 而使用者的下一步需要是**動作**(明天要做什麼)。中間那段轉換原本要他自己
   * 在腦中做,於是多數人看完報告就關掉了 —— 那是這個產品最常被放棄的一段。
   *
   * 刻意**不要求**先有 AI 摘要:沒有摘要時清單仍然有量化建議與練習目標,
   * 而要求「先按摘要才能複製」會讓沒有雲端 AI 的使用者完全拿不到這一段。
   */
  const copyActionList = async (s: MeetingSession): Promise<void> => {
    const list = buildActionList(s)
    try {
      await navigator.clipboard.writeText(list.text)
      toast.success(
        list.aiMissing
          ? '行動清單已複製。這場還沒有 AI 摘要，清單裡是量化建議。'
          : '行動清單已複製，可以直接貼到你的待辦工具。'
      )
    } catch (err) {
      // 剪貼簿在某些環境不可用。使用者正要拿這份清單去做事,
      // 所以除了錯誤還要給他看得懂的版本 —— 匯出成 .md 是可行的退路。
      reportError('複製行動清單失敗', err, { event: 'backup_failed' })
      toast.info(`可以改用「匯出」把這場存成 .md。\n\n${list.text.slice(0, 400)}`)
    }
  }

  const removeSession = async (id?: number): Promise<void> => {
    if (id == null) return
    // 永久刪除要有確認:與 Scripts 頁刪除講稿同一標準,誤觸即失去逐字稿+報告無法復原
    if (
      !(await confirmDialog({
        title: '刪除這場會議紀錄？',
        body: '逐字稿、摘要與量化報告會一併移除，無法復原。',
        confirmLabel: '刪除紀錄',
        variant: 'danger'
      }))
    )
      return
    await db.sessions.delete(id)
    await refreshSessions()
    // 與刪除講稿(toast.success)、刪除練習紀錄(toast.info)同一標準:
    // 三種刪除中這筆資料量最大(逐字稿+摘要+報告),反而不能無聲消失。
    toast.info('會議紀錄已刪除')
  }

  const generateSummary = async (s: MeetingSession): Promise<void> => {
    if (!settings || s.id == null) return
    const aiProvider = settings.ai.provider
    setAiBusyId(s.id)
    try {
      const transcript = (() => {
        const full = s.segments
          .map((seg) => `[${seg.speaker === 'me' ? '我' : '對方'}] ${seg.text}`)
          .join('\n')
        // 頭尾組合而不是只取尾段:長會議的開頭(議程、結論)與結尾(決定事項)
        // 都要進摘要,中段才可犧牲。只取 slice(-8000) 時前半場會被靜默丟掉,
        // 使用者看到的摘要不知不覺漏掉了會議的結論段。
        if (full.length <= 8000) return full
        return `${full.slice(0, 6000)}\n…(中略)…\n${full.slice(-2000)}`
      })()
      const aiStartedAt = Date.now()
      reportEvent('ai_request_started', {
        fields: { provider: aiProvider, model: resolvedModelName(settings) }
      })
      const chat = startAiChat(settings, [
        {
          role: 'system',
          content:
            '你是專業的會議助理。只輸出 JSON，不要加任何說明或程式碼圍籬。所有內容使用繁體中文。'
        },
        {
          role: 'user',
          content: `根據以下會議逐字稿，輸出 JSON，格式：{"abstract":"三到五句的會議摘要","keyPoints":["重要討論重點"],"todos":["待辦事項，可含負責人"],"followUps":["建議跟進或追問的事項"]}\n\n逐字稿：\n${transcript}`
        }
      ])
      cancelSummaryRef.current = chat.cancel
      const raw = await chat.promise
      const summary = extractJson<MeetingSummary>(raw)
      const clean: MeetingSummary = {
        abstract: summary.abstract ?? '',
        keyPoints: summary.keyPoints ?? [],
        todos: summary.todos ?? [],
        followUps: summary.followUps ?? [],
        generatedAt: Date.now(),
        model: resolvedModelName(settings)
      }
      await db.sessions.update(s.id, { summary: clean })
      await refreshSessions()
      setExpandedId(s.id)
      // 耗時寫進事件:使用者回報「一直轉圈」時,這是唯一能量到「到底卡了多久」
      // 的數字 —— 沒有它,15 秒與 15 分鐘在日誌裡長得一樣。
      reportEvent('ai_request_succeeded', {
        metrics: { summaryMs: Date.now() - aiStartedAt },
        fields: { provider: aiProvider }
      })
    } catch (err) {
      // 使用者自己按的取消不是失敗:逐字稿已存在 IndexedDB,不需要任何錯誤提示。
      if (isCancelled(err)) {
        toast.info('已取消 AI 摘要，逐字稿仍完整保留。')
        return
      }
      // 摘要失敗是使用者最常回報的問題(「按了沒反應」)。帶 provider 情境
      // 是必要的:同一句 fetch failed 對 Ollama 與雲端 API 是兩種診斷。
      reportError('AI 摘要失敗', err, { event: 'ai_request_failed', provider: aiProvider })
    } finally {
      cancelSummaryRef.current = null
      setAiBusyId(null)
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">錄音轉錄</h1>
        <div className="flex items-center gap-2 text-xs text-ink-400">
          {engine === 'local' ? (
            <>
              <span className="font-mono">Whisper {modelKey}</span>
              {model.status === 'ready' && (
                <span className="text-emerald-400">已載入{model.msg ? ` · ${model.msg}` : ''}</span>
              )}
            </>
          ) : (
            <span>雲端 API</span>
          )}
        </div>
      </div>

      {/*
        辨識失敗橫幅。
        為什麼需要這個而不是多跳幾個 toast:持續失敗時原本會幾秒一個錯誤跳出來,
        堆滿並蓋住錄音介面。使用者只會得到「一直有東西出錯」的雜訊,
        不會知道「我現在講的話不會被儲存」。這個橫幅把該有的那句話講清楚。
        只在錄音中顯示:停止後橫幅留著會與「會後報告已儲存」互相矛盾
        (已經沒有在錄,卻還說「你現在說的話不會被儲存」)。
      */}
      {sttFailed && recording && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2.5 rounded-xl border border-rose-450/40 bg-rose-450/10 px-4 py-3 text-sm text-rose-300"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">語音辨識持續失敗,你現在說的話不會被儲存</div>
            <div className="mt-0.5 text-xs text-rose-300/80">
              請先停止錄音,確認本地模型已下載(或雲端 API 金鑰有效)後再重新錄製,否則這場會議不會留下任何逐字稿。
            </div>
          </div>
        </div>
      )}

      {/* 控制列 */}
      <div className="card mb-4 flex flex-wrap items-center gap-4 p-4">
        {!recording && (
          <>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={wantMic} onChange={(e) => setWantMic(e.target.checked)} className="accent-accent-500" />
              <Mic size={15} /> 我的麥克風
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm" title="擷取系統播放中的聲音（會議對方、影片等），開始後自動擷取，不會出現分享視窗">
              <input type="checkbox" checked={wantSys} onChange={(e) => setWantSys(e.target.checked)} className="accent-accent-500" />
              <MonitorSpeaker size={15} /> 系統音訊（對方）
            </label>
            <input
              className="input w-52 text-xs"
              aria-label="會議名稱"
              title="會議名稱"
              placeholder="會議名稱（可留空）"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button className="btn-primary ml-auto" onClick={start} disabled={starting || saving}>
              {starting || saving ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {saving ? '收尾中…' : starting ? '啟動中…' : '開始聆聽'}
            </button>
          </>
        )}
        {recording && (
          <>
            <span className="flex items-center gap-2 text-sm font-medium text-rose-450">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-450" />
              聆聽中 {formatDuration(elapsed)}
            </span>
            {wantMic && (
              <div className="flex items-center gap-2" title="麥克風音量">
                <Mic size={13} className="text-ink-400" />
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800">
                  <div className="h-full bg-emerald-500 transition-[width] duration-100" style={{ width: `${micLevel * 100}%` }} />
                </div>
              </div>
            )}
            {wantSys && (
              <div className="flex items-center gap-2" title="系統音訊音量">
                <MonitorSpeaker size={13} className="text-ink-400" />
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800">
                  <div className="h-full bg-sky-500 transition-[width] duration-100" style={{ width: `${sysLevel * 100}%` }} />
                </div>
              </div>
            )}
            <button className="btn-primary ml-auto" onClick={stop} disabled={saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
              {saving ? '儲存中…' : '停止並儲存'}
            </button>
          </>
        )}
      </div>

      {model.status === 'loading' && (
        <div className="card mb-4 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs text-ink-300">
            <Download size={13} /> 下載 Whisper {modelKey} 模型（首次需要，之後會快取）
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
            <div className="h-full bg-accent-500 transition-[width]" style={{ width: `${model.progress}%` }} />
          </div>
          <div className="mt-1.5 font-mono text-[10px] text-ink-400">{model.file} {model.progress.toFixed(0)}%</div>
        </div>
      )}
      {model.msg && model.status !== 'ready' && (
        <div className="mb-4 text-xs text-amber-450">{model.msg}</div>
      )}

      {/* 逐字稿 */}
      <div ref={transcriptBoxRef} className="card mb-4 min-h-0 flex-1 overflow-y-auto p-4">
        {segments.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-xs leading-relaxed text-ink-400">
            {recording ? '等待說話…' : '按下「開始聆聽」後，這裡會即時出現逐字稿'}
          </div>
        ) : (
          <div className="space-y-3">
            {segments.map((seg, i) => (
              // 陣列每次追加都會整個重排序(mic/sys 的 ASR 回來順序不等於語音順序):
              // index key 會讓既有列被重用成別的段落,複合 key 讓排序後的 DOM 節點跟著段落走。
              <div key={`${seg.start}-${seg.end}-${seg.speaker}-${i}`} className="flex gap-3">
                <div className="w-24 shrink-0 pt-0.5 text-right font-mono text-[10px] text-ink-400">
                  {formatDuration(seg.start)}
                </div>
                <div className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'mr-2 rounded px-1.5 py-0.5 text-[10px]',
                      seg.speaker === 'me' ? 'bg-accent-500/20 text-accent-300' : 'bg-sky-500/20 text-sky-300'
                    )}
                  >
                    {seg.speaker === 'me' ? '我' : '對方'}
                  </span>
                  <span className="text-sm leading-relaxed">{seg.text}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 會後量化報告 */}
      {!recording && lastReport && lastReport.durationSec > 0 && (
        <div className="card mb-4 p-4">
          <div className="mb-3 flex items-center gap-3">
            <div className="text-sm font-semibold">會後報告</div>
            {lastReportMeta && (
              <div className="min-w-0 flex-1 truncate text-[11px] text-ink-400" title={lastReportMeta.title}>
                {lastReportMeta.title} · {formatDateTime(lastReportMeta.endedAt)}
              </div>
            )}
            <button
              // data-effect-id:可及名稱在這裡是會變的 —— aria-label 寫「關閉這份報告」,
              // 而列舉端對按鈕優先取可見文字(「關閉」)。那個字太通用,
              // 用名稱當身分等於讓稽核去指一個可能指錯的對象。
              data-effect-id="report-close"
              className="btn-ghost ml-auto shrink-0 text-[11px]"
              onClick={() => {
                setLastReport(null)
                setLastReportMeta(null)
              }}
              title="關閉這份報告"
              aria-label="關閉這份報告"
            >
              關閉
            </button>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: '時長', value: formatDuration(lastReport.durationSec) },
              {
                label: '發言佔比',
                value:
                  lastReport.talkRatioAvailable === false ? '—' : `${Math.round(lastReport.talkRatio * 100)}%`,
                hint:
                  lastReport.talkRatioAvailable === false
                    ? '需同時擷取麥克風與系統音訊'
                    : `我 ${formatDuration(lastReport.mySec)} / 對方 ${formatDuration(lastReport.theirSec)}`
              },
              {
                label: '我的語速',
                value: lastReport.myCpm > 0 ? `${lastReport.myCpm}` : '—',
                // 有基準就把基準一起擺出來:單一個數字讀不出「這算快還算慢」,
                // 而判斷偏快偏慢本來就是相對於這個人的常態。
                hint:
                  lastReport.myCpm > 0
                    ? personalCpmBaseline
                      ? `字/分 · 你的基準 ${Math.round(personalCpmBaseline)}`
                      : '字/分'
                    : undefined
              },
              {
                label: '語速穩定度',
                value: `${lastReport.steadiness}`,
                hint: `冷場 ${lastReport.gapCount} 次`
              }
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-ink-800 bg-ink-850/60 p-3">
                <div className="text-[10px] text-ink-400">{s.label}</div>
                <div className="mt-0.5 text-lg font-semibold text-ink-100">{s.value}</div>
                {s.hint && <div className="text-[10px] text-ink-400">{s.hint}</div>}
              </div>
            ))}
          </div>
          {lastReport.coachingCounts && Object.values(lastReport.coachingCounts).some((n) => (n ?? 0) > 0) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {(
                [
                  ['fast', '語速過快'],
                  ['filler', '填充詞'],
                  ['interrupt', '搶話'],
                  ['dead_air', '冷場'],
                  ['monologue', '獨白過長']
                ] as Array<[CoachingKind, string]>
              ).map(([kind, label]) => {
                const n = lastReport.coachingCounts?.[kind] ?? 0
                if (n <= 0) return null
                return (
                  <span key={kind} className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[10px] text-amber-300">
                    {label} ×{n}
                  </span>
                )
              })}
            </div>
          )}
          {lastReport.suggestions.length > 0 && (
            <ul className="mt-3 space-y-1">
              {lastReport.suggestions.map((sg, i) => (
                <li key={i} className="flex items-start gap-2 text-xs leading-relaxed">
                  <span
                    className={cn(
                      'mt-0.5 rounded px-1.5 py-0.5 text-[10px] shrink-0',
                      sg.severity === 'high'
                        ? 'bg-rose-450/15 text-rose-450'
                        : sg.severity === 'medium'
                          ? 'bg-amber-450/15 text-amber-450'
                          : 'bg-ink-700 text-ink-300'
                    )}
                  >
                    {sg.severity === 'high' ? '重要' : sg.severity === 'medium' ? '建議' : '參考'}
                  </span>
                  <span className="text-ink-200">{sg.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 歷史 */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-200">
            <Save size={14} /> 最近的會議紀錄
          </div>
        </div>
        {sessions.length === 0 ? (
          <div className="text-xs text-ink-400">還沒有紀錄</div>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id} className="card overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <button
                    // 名稱是會議標題(使用者自己取的)→ 動態,必須有穩定身分
                    data-effect-id="session-row"
                    // py-1.5:原本列高只有 17px(等於一行文字),是整頁最小的點擊目標。
                    // 內容本身不變,只是把可點範圍拉到 29px,對齊其他控制項的下限。
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left cursor-pointer"
                    onClick={() => setExpandedId(expandedId === s.id ? null : (s.id ?? null))}
                  >
                    {expandedId === s.id ? (
                      <ChevronDown size={13} className="shrink-0 text-ink-400" />
                    ) : (
                      <ChevronRight size={13} className="shrink-0 text-ink-400" />
                    )}
                    <div className="min-w-0">
                      {/* title 不是裝飾:會議標題可以長到把整列截斷,而沒有一個
                          可看的全文,使用者只能靠猜。稽核的 truncated-no-label 規則
                          (由 scripts/audit-states.mjs 的長標題狀態量到)會抓這一類。 */}
                      <div className="truncate text-sm" title={s.title}>
                        {s.title}
                      </div>
                      <div className="text-[11px] text-ink-400">
                        {formatDateTime(s.startedAt)} · {s.segments.length} 段 ·{' '}
                        {s.summary ? '已生成摘要' : '未摘要'}
                      </div>
                    </div>
                  </button>
                  <div className="flex shrink-0 gap-1">
                    {aiBusyId === s.id ? (
                      <CancelableBusy
                        busy
                        className="btn-ghost text-xs text-accent-300"
                        busyLabel={
                          <>
                            <Loader2 size={12} className="animate-spin" /> 摘要中…
                          </>
                        }
                        idleLabel="AI 摘要"
                        onCancel={() => cancelSummaryRef.current?.()}
                      />
                    ) : (
                      <button
                        className="btn-ghost text-xs text-accent-300"
                        onClick={() => generateSummary(s)}
                        disabled={aiBusyId !== null}
                      >
                        <Sparkles size={12} />
                        {s.summary ? '重新摘要' : 'AI 摘要'}
                      </button>
                    )}
                    <button
                      // 這是「錄音 → 提詞」唯一缺的那一步。這個 App 的主功能是提詞,
                      // 但逐字稿原本只能「匯出 .md 到磁碟」—— 那是給人看的,
                      // 回到這個 App 的路要使用者自己複製貼上。這顆鈕把它接回去。
                      className="btn-ghost text-xs"
                      disabled={isSavedAsScript(s)}
                      onClick={() => void saveTranscriptAsScript(s)}
                      title="把這場會議的逐字稿存成一份講稿,之後就能拿去提詞"
                    >
                      <BookPlus size={12} /> {isSavedAsScript(s) ? '已存成講稿' : '存成講稿'}
                    </button>
                    <button
                      data-effect-id="copy-action-list"
                      className="btn-ghost text-xs"
                      onClick={() => void copyActionList(s)}
                      title="把待辦、建議追問與下一次練習目標複製成一份清單,直接貼進你的待辦工具"
                    >
                      <ClipboardCopy size={12} /> 行動清單
                    </button>
                    <button className="btn-ghost text-xs" onClick={() => exportSession(s)}>
                      匯出
                    </button>
                    <button
                      className="btn-ghost text-rose-450"
                      onClick={() => removeSession(s.id)}
                      title="刪除這場會議紀錄"
                      aria-label="刪除這場會議紀錄"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {/*
                  展開列的條件原本是 `s.summary` —— 那是一個**死路**:
                  歷史上的每一場會議都沒有摘要(摘要要使用者自己按),而列上的箭頭
                  在每一列都畫著。點下去什麼都不會發生,於是「展開」這個動作
                  對 99% 的資料而言是無效的 UI。
                  改成「有摘要顯示摘要;沒摘要顯示逐字稿」——兩者都有的時候
                  摘要在上、逐字稿在下(使用者想核對的重點往往就在原文裡)。
                */}
                {expandedId === s.id && (
                  <div className="space-y-3 border-t border-ink-800 bg-ink-850/50 px-5 py-4 text-xs leading-relaxed">
                    {s.summary && (
                      <>
                        <div>
                          <div className="mb-1 font-medium text-accent-300">摘要</div>
                          {s.summary.abstract}
                        </div>
                        {s.summary.keyPoints.length > 0 && (
                          <div>
                            <div className="mb-1 font-medium text-accent-300">重點</div>
                            <ul className="list-inside list-disc space-y-0.5 text-ink-200">
                              {s.summary.keyPoints.map((k, i) => (
                                <li key={i}>{k}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {s.summary.todos.length > 0 && (
                          <div>
                            <div className="mb-1 font-medium text-accent-300">待辦</div>
                            <ul className="space-y-0.5 text-ink-200">
                              {s.summary.todos.map((t, i) => (
                                <li key={i}>☐ {t}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {s.summary.followUps.length > 0 && (
                          <div>
                            <div className="mb-1 font-medium text-accent-300">建議跟進</div>
                            <ul className="list-inside list-disc space-y-0.5 text-ink-200">
                              {s.summary.followUps.map((t, i) => (
                                <li key={i}>{t}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                    {s.segments.length > 0 && (
                      <div>
                        <div className="mb-1 font-medium text-accent-300">逐字稿</div>
                        <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                          {s.segments.map((seg, i) => (
                            <div key={i} className="flex gap-2">
                              <span
                                className={cn(
                                  'shrink-0 font-mono text-[10px] leading-5 text-ink-500',
                                  seg.speaker === 'me' ? 'text-accent-400' : ''
                                )}
                              >
                                {seg.speaker === 'me' ? '我' : '對方'}
                              </span>
                              <span className="min-w-0 text-ink-200">{seg.text}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
