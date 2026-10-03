import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  Download,
  GraduationCap,
  Loader2,
  Mic,
  Sparkles,
  Square,
  Trash2,
  Volume2
} from 'lucide-react'
import type { PracticeAnswer, PracticeFeedback, PracticeRun } from '@shared/types'
import { db } from '../lib/db'
import { reportError, reportEvent } from '../lib/reportError'
import { useSettings } from '../lib/store'
import { cn, formatDateTime, formatDuration } from '../lib/utils'
import { extractJson, isCancelled, startAiChat } from '../lib/ai'
import { CancelableBusy } from '../components/CancelableBusy'
import { countReadableChars } from '../lib/calibration'
import { speak, stopSpeaking, warmUpVoices } from '../lib/tts'
import { AudioSegmenter } from '../lib/audio/segmenter'
import { WhisperClient, type WhisperModelKey } from '../lib/audio/whisperClient'
import { encodeWav } from '../lib/audio/wav'
import {
  createPendingTracker,
  drainPending,
  GenerationGate,
  OrderedTranscript,
  STT_FAILURE_BANNER_THRESHOLD,
  type DrainResult
} from '../lib/transcriptionQueue'
import { confirmDialog } from '../lib/confirm'
import { registerAuditControl } from '../lib/auditBridge'
import { toast } from '../lib/toast'
import { analyzePracticeRun } from '../lib/session-intelligence'
import { buildPracticeAnswer } from '../lib/practiceAnswer'
import { setCaptureIndicator } from '../lib/captureIndicator'

const PRACTICE_TYPES = ['行為面試', '技術面試', '自我介紹', '案例簡報', '銷售情境'] as const

type Phase = 'setup' | 'run' | 'done'

export default function Practice({ onGuardChange }: { onGuardChange?: (msg: string | null) => void } = {}): JSX.Element {
  const { settings } = useSettings()
  const [phase, setPhase] = useState<Phase>('setup')
  const [position, setPosition] = useState('')
  const [type, setType] = useState<string>('行為面試')
  const [count, setCount] = useState(5)
  const [questions, setQuestions] = useState<string[]>([])
  const [qIndex, setQIndex] = useState(0)
  const [answers, setAnswers] = useState<PracticeAnswer[]>([])
  const [curTranscript, setCurTranscript] = useState('')
  const [curStart, setCurStart] = useState(0)
  const [recording, setRecording] = useState(false)
  /** startListening 的多步 await(模型載入/麥克風)期間擋再按:雙擊會洩漏第一組管線且重複轉錄 */
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)
  const [level, setLevel] = useState(0)
  const [busy, setBusy] = useState<string | null>(null) // 'questions' | 'feedback' | 'overall'
  /**
   * 「完成回答」按下後、評分開始前的等待。
   *
   * 為什麼需要一個獨立的 state 而不靠 busy:
   *   finishAnswerInner 先 stopListening(),那會立刻把 recording 設成 false,
   *   於是主要按鈕在 drain 期間就換回「開始回答」而且還是可點的
   *   (disabled 只看 busy,而 busy 要等 drain 完才設 'feedback')。
   *   但 finishingRef.current 還是 true,點下去 startListening 的守衛直接 return
   *   —— 使用者看到一顆可按、按了沒反應、也沒有任何進度的按鈕,最長 65 秒
   *   (雲端 ASR 的 timeout)。
   *   Record 頁同一個 65 秒等待做對了(setSaving(true) → 「收尾中…」+ disabled),
   *   這裡漏了。
   */
  const [draining, setDraining] = useState(false)
  /** 首次載入本地模型時的下載進度(Record/Calibration 都有進度條,唯獨 Practice 缺:
   *  新使用者按「開始回答」只看到轉圈數分鐘,會以為卡死) */
  const [modelDL, setModelDL] = useState<{ progress: number; file: string } | null>(null)
  /** finishAnswer/finishRun 的多步 await(等轉錄落地、AI 呼叫、寫 DB)期間擋再按:
   *  雙擊會重複送 AI 評分/重複寫入練習紀錄(按鈕 disabled 依賴 re-render,同 tick 內擋不住) */
  const finishingRef = useRef(false)
  const finishingRunRef = useRef(false)
  const finishAnswerOperationRef = useRef(0)
  const finishRunOperationRef = useRef(0)
  const startAttemptRef = useRef(0)
  const answerIdRef = useRef(0)

  /** 每輪練習的世代；結束/重開後忽略舊的 AI 與 IndexedDB 回覆。 */
  const runGenerationRef = useRef(new GenerationGate())
  /**
   * 目前在飛的 AI 請求的取消函式(見 lib/ai.ts 的 startAiChat)。
   *
   * 為什麼是 ref 而不是 state:它每次呼叫都換一個新的函式參考,放進 state
   * 會造成「為了記住怎麼取消而多 render 一次」——而它在 busy 期間本來就
   * 不該影響畫面。ref 也讓取消鈕不需要靠按鈕本身傳 props。
   */
  const cancelRef = useRef<(() => void) | null>(null)
  // 在飛的辨識請求由 lib/transcriptionQueue 追蹤(與 Record 頁同一份實作)。
  // 型別標在 useRef 上,而非 new Map<...>() 的泛型位置 ——
  // 原寫法少了 Map 的收尾 >,esbuild 解析失敗後把它當成比較運算式,
  // 產出 new Map() < number, Set() —— 執行期 ReferenceError: number is not defined。
  // tsc 與 build 都不報錯,只有頁面真正跑起來才炸,所以用明確的泛型引數寫法。
  const pendingRef = useRef(createPendingTracker<number>())
  /** 下一題雙擊會連跳兩題(setQIndex updater 在同 tick 串聯兩次) */
  const advancingRef = useRef(false)
  const [run, setRun] = useState<PracticeRun | null>(null)
  const [history, setHistory] = useState<PracticeRun[]>([])
  /** 已取得到的整體總評。重試路徑(AI 成功但存檔失敗 → 再按查看總評)直接重用,
   *  不重花一次 AI 呼叫;AI 失敗時不進快取,重試才是真的重試。開新一輪時清空。 */
  const overallCacheRef = useRef<string | null>(null)
  /**
   * 辨識持續失敗的持續提醒。
   *
   * 為什麼 Practice 也需要(而不只是 Record):這裡的失敗同樣會讓整段回答變成
   * 空白,但使用者看到的只是一個品質不好的分數 —— 他不會知道那是「你講的話
   * 根本沒進到系統」,只會以為自己剛才表現得很差。門檻與 Record 共用同一份。
   */
  const [sttFailed, setSttFailed] = useState(false)
  const sttFailStreakRef = useRef(0)
  const sttNotifiedRef = useRef(false)
  /** 本題是否有段落辨識失敗 → 這份逐字稿不完整(隨答案一起存,見 PracticeAnswer.partial) */
  const segFailRef = useRef(false)

  const whisperRef = useRef<WhisperClient | null>(null)
  const segmenterRef = useRef<AudioSegmenter | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const segsRef = useRef(new OrderedTranscript())
  const answersRef = useRef<PracticeAnswer[]>([])
  answersRef.current = answers

  const modelKey = (settings?.stt.localModel ?? 'base') as WhisperModelKey

  /**
   * 稽核用:強制進入「會改變版面」的狀態。
   *
   * 與 Record 同一個理由 —— 辨識失敗橫幅要連續 3 次 STT 失敗才出現
   * (STT_FAILURE_BANNER_THRESHOLD),模型下載卡則由進度回呼驅動,
   * 兩者在 headless 都走不到。所以這兩個狀態從未被任何稽核掃過。
   *
   * 特別是 sttFailed 這條:沒有它,使用者拿到的是一個偏低的分數,
   * 而他永遠不會知道原因是「你講的話根本沒進系統」。
   *
   * arg:字串名稱;不傳則全部設成典型值(最貼近「真實會同時看到什麼」)。
   *
   * 注意 phase 必須一起設:'run' 階段之前(setup)這三個狀態根本不在 DOM 裡,
   * 而只設 sttFailed 回傳 true 卻沒有任何變化 —— 這正是 auditBridge 註解裡
   * 說過的「強制成功但沒渲染」。稽核端會用文字斷言把它抓出來。
   */
  useEffect(
    () =>
      registerAuditControl('practice.branchState', (arg) => {
        const want = typeof arg === 'string' ? arg : 'stt-failed'
        if (want === 'stt-failed') {
          setQuestions(['請用三分鐘介紹你負責的產品'])
          // run 階段的列首讀的是 position state,不是 run.position —— 少了這行,
          // 稽核截圖會出現「第 1 / 3 題 ·（行為面試）」的懸空分隔(目檢量到)。
          setPosition('產品經理')
          setRun({ id: 1, position: '產品經理', type: '行為面試', questions: ['請用三分鐘介紹你負責的產品'], answers: [], createdAt: Date.now() })
          setPhase('run')
          setSttFailed(true)
          return true
        }
        if (want === 'model-dl') {
          setQuestions(['請用三分鐘介紹你負責的產品'])
          setPosition('產品經理')
          setRun({ id: 1, position: '產品經理', type: '行為面試', questions: ['請用三分鐘介紹你負責的產品'], answers: [], createdAt: Date.now() })
          setPhase('run')
          setModelDL({ progress: 37, file: 'ggml-base.bin' })
          return true
        }
        if (want === 'busy') {
          setQuestions(['請用三分鐘介紹你負責的產品'])
          setPosition('產品經理')
          setRun({
            id: 1,
            position: '產品經理',
            type: '行為面試',
            questions: ['請用三分鐘介紹你負責的產品'],
            answers: [],
            createdAt: Date.now()
          })
          setPhase('run')
          // recording 也必須為 true:'AI 評分中…' 是錄音中那顆按鈕的文案,
          // 另一顆('開始回答')在 busy 時只有 spinner 沒有字。兩者版式不同,
          // 都要量 —— 而這個錯在第一次跑稽核時就以「強制成功但沒渲染」被抓出來。
          setRecording(true)
          setBusy('feedback')
          return true
        }
        /**
         * 底下四條是**列舉端**需要的:它們決定「畫面上會出現哪些控制項」,
         * 而少了它們,「完成回答，取得反饋 / 下一題 / 查看總評 / 再練一輪」
         * 這四顆鈕就永遠不存在於任何被宣告的狀態裡 —— 覆蓋率對帳會說
         * 「這顆有登記,但從來沒出現過」,而那是對的。
         *
         * 為什麼不靠腳本點出來:run 階段的每一顆都要真的開麥克風、真的講一段話,
         * 而「答完最後一題」還要 AI 評分回來。列舉要的是**版面**,不是行為;
         * 行為由各自的探針(用假麥克風 + mock 服務)負責。
         */
        const mkRun = (questions: string[], answers: PracticeAnswer[]): PracticeRun => ({
          id: 1,
          position: '產品經理',
          type: '行為面試',
          questions,
          answers,
          createdAt: Date.now()
        })
        const answered: PracticeAnswer = {
          question: '請用三分鐘介紹你負責的產品',
          answerTranscript: '我負責的產品是一個面試練習工具,主要解決的是講話沒有結構的問題。',
          durationSec: 42,
          feedback: {
            score: 82,
            content: '回答切題,有具體例子。',
            structure: '結構清楚,先結論後說明。',
            delivery: '語速穩定,可再放慢一點。',
            betterAnswer: '示範回答:我會先說明背景,再講做法,最後交代結果與學到的事。'
          }
        }
        const threeQs = ['請用三分鐘介紹你負責的產品', '說一個你主導的專案', '為什麼想離開現在的工作']
        /**
         * `questions` 與 `run.questions` 是**兩個不同的 state**。
         *
         * 只 setRun(...)、忘記 setQuestions(...) 的症狀是「強制成功但沒渲染」:
         * run 階段讀的 `questions[qIndex]` 是 undefined、`questions.length` 是 0,
         * 於是畫面寫著「第 1 / 0 題」,而主要按鈕因為
         * `qIndex + 1 >= questions.length` 恆成立,永遠是「查看總評」——
         * 「下一題」這顆按鈕於是**不存在於任何被宣告的狀態裡**。
         * 這不是列舉端的問題,是這裡少了一行。
         */
        if (want === 'run') {
          setQuestions(threeQs)
          setPosition('產品經理')
          setRun(mkRun(threeQs, []))
          setQIndex(0)
          setAnswers([])
          setRecording(false)
          setPhase('run')
          return true
        }
        if (want === 'answering') {
          setQuestions(threeQs)
          setPosition('產品經理')
          setRun(mkRun(threeQs, []))
          setQIndex(0)
          setAnswers([])
          setCurTranscript('我正在說明這個產品解決的問題,以及它是為誰設計的…')
          setLevel(0.42)
          setRecording(true)
          setPhase('run')
          return true
        }
        if (want === 'answered') {
          setQuestions(threeQs)
          setPosition('產品經理')
          setRun(mkRun(threeQs, [answered]))
          setQIndex(0)
          setAnswers([answered])
          setRecording(false)
          setPhase('run')
          return true
        }
        // 最後一題答完:主要按鈕的文字從「下一題」變成「查看總評」
        if (want === 'last-answered') {
          setQuestions([threeQs[0]])
          setPosition('產品經理')
          setRun(mkRun([threeQs[0]], [answered]))
          setQIndex(0)
          setAnswers([answered])
          setRecording(false)
          setPhase('run')
          return true
        }
        return false
      }),
    []
  )

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistory(await db.practiceRuns.orderBy('createdAt').reverse().limit(10).toArray())
  }, [])

  useEffect(() => {
    void refreshHistory()
    warmUpVoices()
  }, [refreshHistory])

  // 切頁守衛(與 Record 同一模式):關窗有守衛,側欄切頁原本沒有 ——
  // 練習進行中切頁,已答未存的回答與正在錄的音都會靜默消失。
  useEffect(() => {
    const msg =
      phase === 'run'
        ? recording
          ? '正在錄音:離開會遺失這段還在轉錄的回答。'
          : '練習進行中:離開會遺失尚未完成與尚未儲存的回答。'
        : null
    onGuardChange?.(msg)
    return () => onGuardChange?.(null)
  }, [phase, recording, onGuardChange])

  // 題目自動朗讀:setup 頁的流程文案承諾「AI 出題並朗讀」,但朗讀原本只有一顆
  // 手動喇叭鈕 —— 每換一題都要自己找按鈕,作答節奏被打斷。換題(進入 run /
  // 下一題)且該題尚未作答時自動朗讀;手動按鈕保留(重聽用)。
  // answers[qIndex] 在依賴裡:反饋回來後會重跑,但那時條件已不成立,不會重播。
  useEffect(() => {
    if (phase !== 'run') return
    const q = questions[qIndex]
    if (!q || answers[qIndex]) return
    speak(q, { lang: 'zh-TW' })
  }, [phase, qIndex, questions, answers])

  useEffect(() => {
    return () => {
      runGenerationRef.current.invalidate()
      startAttemptRef.current += 1
      answerIdRef.current += 1
      segmenterRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      stopSpeaking()
      // Whisper worker 帶著數百 MB 模型,離頁一併釋放(Cache API 快取仍在,重進免重新下載)
      whisperRef.current?.dispose()
      whisperRef.current = null
    }
  }, [])

  // 錄音中的環境指示(見 lib/captureIndicator.ts):
  // 作答時把主視窗最小化,「麥克風還開著」原本完全不可見。
  useEffect(() => {
    setCaptureIndicator('practice', recording ? '● 錄音中 — AI 提詞機' : null)
  }, [recording])
  // 離頁必還原:unmount 不會再觸發上面那個 effect 的「設成 null」分支
  useEffect(() => () => setCaptureIndicator('practice', null), [])

  const ensureWhisper = async (): Promise<void> => {
    if (!whisperRef.current) {
      const client = new WhisperClient()
      client.onProgress = (p) => {
        if (p.status === 'progress' || p.status === 'initiate') {
          setModelDL((m) => ({ progress: p.progress ?? m?.progress ?? 0, file: p.file ?? m?.file ?? '' }))
        }
      }
      whisperRef.current = client
    }
    const client = whisperRef.current
    if (!client.isLoaded()) {
      setModelDL({ progress: 0, file: '' })
      try {
        await client.load(modelKey)
      } finally {
        setModelDL(null)
      }
    }
  }

  const onSegment = async (
    audio: Float32Array,
    sr: number,
    answerId: number,
    segmentOrder: number
  ): Promise<void> => {
    if (answerId !== answerIdRef.current) return
    if (!settings) {
      const readyChunks = segsRef.current.skip(segmentOrder)
      setCurTranscript(segsRef.current.toString())
      for (const chunk of readyChunks) void window.api.pushTranscript({ text: chunk, speaker: 'me' })
      return
    }
    // 先取出來再進 try:catch 看不到 try 之前的窄化,而且「連不上」要說 Ollama
    // 還是雲端 API 完全取決於這一個值(見 describeError 的 ErrorContext)
    const sttEngine = settings.stt.engine
    try {
      let text = ''
      if (settings.stt.engine === 'local') {
        text = await whisperRef.current!.transcribe(audio, settings.stt.language)
      } else {
        const { baseUrl, apiKey, model } = settings.stt.cloud
        if (!baseUrl || !model) throw new Error('請先在設定頁設定雲端語音 API')
        const res = await window.api.cloudTranscribe({
          baseUrl,
          apiKey,
          model,
          audio: encodeWav(audio, sr),
          language: settings.stt.language
        })
        if (!res.ok) throw new Error(res.error ?? '辨識失敗')
        text = res.text ?? ''
      }
      if (answerId !== answerIdRef.current) return
      const readyChunks = text.trim()
        ? segsRef.current.resolve(segmentOrder, text.trim())
        : segsRef.current.skip(segmentOrder)
      setCurTranscript(segsRef.current.toString())
      for (const chunk of readyChunks) {
        void window.api.pushTranscript({ text: chunk, speaker: 'me' })
      }
      if (text.trim()) {
        // 成功一次就代表辨識通了:清掉失敗累積,橫幅自動消失
        sttFailStreakRef.current = 0
        if (sttNotifiedRef.current) {
          sttNotifiedRef.current = false
          setSttFailed(false)
        }
      }
    } catch (err) {
      if (answerId === answerIdRef.current) {
        const readyChunks = segsRef.current.skip(segmentOrder)
        setCurTranscript(segsRef.current.toString())
        for (const chunk of readyChunks) {
          void window.api.pushTranscript({ text: chunk, speaker: 'me' })
        }
        segFailRef.current = true
        sttFailStreakRef.current += 1
        const ctx = sttEngine === 'cloud' ? { provider: 'cloud-api' as const } : undefined
        if (sttFailStreakRef.current >= STT_FAILURE_BANNER_THRESHOLD) {
          if (!sttNotifiedRef.current) {
            sttNotifiedRef.current = true
            reportError('語音辨識失敗', err, { event: 'transcribe_failed', ...ctx })
          }
          setSttFailed(true)
        } else {
          reportError('語音辨識失敗', err, {
            event: 'transcribe_failed',
            ...ctx,
            // 累積型失敗只寫事件、不跳 toast(quiet):橫幅已在講同一件事。
            quiet: sttFailStreakRef.current > 1
          })
        }
      }
    }
  }

  const queueAnswerTranscription = (audio: Float32Array, sr: number, answerId: number): void => {
    // VAD 片段依音訊時間同步保留槽位；雲端辨識回覆可能亂序抵達。
    const segmentOrder = segsRef.current.reserve()
    pendingRef.current.track(answerId, onSegment(audio, sr, answerId, segmentOrder))
  }

  const startListening = async (): Promise<void> => {
    if (startingRef.current || recording || finishingRef.current) return
    startingRef.current = true
    setStarting(true)
    const attempt = ++startAttemptRef.current
    try {
      await startListeningInner(attempt)
    } finally {
      if (attempt === startAttemptRef.current) {
        startingRef.current = false
        setStarting(false)
      }
    }
  }

  const startListeningInner = async (attempt: number): Promise<void> => {
    let stream: MediaStream | null = null
    let segmenter: AudioSegmenter | null = null
    try {
      // 雲端引擎未設定就 fail-fast,不等第一段轉錄失敗才發現(與 Record 同一修法)
      if (settings?.stt.engine === 'cloud' && (!settings.stt.cloud.baseUrl || !settings.stt.cloud.model)) {
        toast.error('請先在設定頁填入雲端語音 API 的 Base URL 與模型')
        return
      }
      if (settings?.stt.engine === 'local') {
        // 模型載入與「開麥」是兩種不同的失敗:下載失敗(斷網/磁碟滿)被當成
        // 「無法開啟麥克風」會把使用者導去查麥克風硬體與 Windows 權限,
        // 而真正的問題(模型)連狀態都看不到。分開接住,訊息各說各的。
        try {
          await ensureWhisper()
        } catch (err) {
          reportError('語音模型載入失敗,無法開始作答', err, { event: 'transcribe_failed' })
          return
        }
      }
      if (attempt !== startAttemptRef.current) return
      const answerId = ++answerIdRef.current
      segsRef.current = new OrderedTranscript()
      segFailRef.current = false
      setCurTranscript('')
      const startedAt = Date.now()
      setCurStart(startedAt)
      // 會話邊界必須先清完 main 端上下文，避免清理晚於第一筆新逐字稿。
      await window.api.contextReset()
      if (attempt !== startAttemptRef.current) return
      // 題目還在朗讀中就開始回答:停掉 TTS,避免朗讀聲混進麥克風的作答錄音
      stopSpeaking()
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      if (attempt !== startAttemptRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      segmenter = new AudioSegmenter({
        onSegment: (audio, sr) => queueAnswerTranscription(audio, sr, answerId),
        onLevel: setLevel,
        threshold: 0.01
      })
      segmenterRef.current = segmenter
      await segmenter.start(stream)
      if (attempt !== startAttemptRef.current) {
        segmenter.stop()
        stream.getTracks().forEach((t) => t.stop())
        if (segmenterRef.current === segmenter) segmenterRef.current = null
        if (streamRef.current === stream) streamRef.current = null
        return
      }
      setRecording(true)
    } catch (err) {
      segmenter?.stop()
      stream?.getTracks().forEach((t) => t.stop())
      if (attempt !== startAttemptRef.current) return
      segmenterRef.current = null
      streamRef.current = null
      // 開麥失敗是「按下開始回答之後沒反應」的根因,使用者會以為是產品壞了。
      reportError('無法開啟麥克風', err, { event: 'transcribe_failed' })
    }
  }

  const stopListening = (): void => {
    segmenterRef.current?.stop()
    segmenterRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setRecording(false)
    setLevel(0)
  }

  const startPractice = async (): Promise<void> => {
    if (!settings) return
    const generation = runGenerationRef.current.next()
    if (!position.trim()) {
      toast.error('請填寫職位或情境，例如「產品經理」')
      return
    }
    setBusy('questions')
    const aiProvider = settings.ai.provider
    const chat = startAiChat(settings, [
      { role: 'system', content: '你是資深面試官。只輸出 JSON，不要任何說明。使用繁體中文。' },
      {
        role: 'user',
        content: `為應徵「${position.trim()}」的${type}設計 ${count} 道面試題。輸出 JSON 字串陣列，例如 ["題目1","題目2"]。題目要具體、由淺入深。`
      }
    ])
    cancelRef.current = chat.cancel
    try {
      if (aiProvider === 'ollama') {
        const res = await window.api.ollamaListModels(settings.ai.ollama.baseUrl)
        if (!res.installed) {
          throw new Error('無法連線到 Ollama——請確認已安裝並啟動（詳見設定頁）')
        }
        if (res.models.length === 0) {
          throw new Error('Ollama 尚未下載任何模型——請執行 ollama pull qwen2.5:7b')
        }
      }
      const raw = await chat.promise
      if (!runGenerationRef.current.isCurrent(generation)) return
      const qs = extractJson<string[]>(raw).filter((q) => typeof q === 'string' && q.trim())
      if (qs.length === 0) throw new Error('AI 沒有產出題目，請再試一次或換模型')
      setQuestions(qs)
      setQIndex(0)
      setAnswers([])
      // 新的一輪從乾淨的失敗計數開始(上一輪的紅色橫幅不該跟著進來)
      sttFailStreakRef.current = 0
      sttNotifiedRef.current = false
      setSttFailed(false)
      overallCacheRef.current = null
      setPhase('run')
    } catch (err) {
      // 使用者自己按的取消不是錯誤:不跳紅色 toast、不記失敗事件。
      // 他唯一能理解的畫面是「回到可以再試一次」。
      if (isCancelled(err)) {
        if (runGenerationRef.current.isCurrent(generation)) setQuestions([])
        return
      }
      // 「開始練習按了沒反應」是最常被回報的症狀之一。帶 provider 情境是必要的:
      // 同一句 fetch failed 對 Ollama 與雲端 API 是兩種完全不同的診斷,
      // 而使用者要改的東西也不同(啟動應用程式 vs 改 Base URL)。
      if (runGenerationRef.current.isCurrent(generation)) {
        reportError('無法開始練習', err, { event: 'ai_request_failed', provider: aiProvider })
      }
    } finally {
      cancelRef.current = null
      if (runGenerationRef.current.isCurrent(generation)) setBusy(null)
    }
  }

  const finishAnswer = async (): Promise<void> => {
    if (finishingRef.current) return
    finishingRef.current = true
    const operation = ++finishAnswerOperationRef.current
    try {
      await finishAnswerInner()
    } finally {
      if (operation === finishAnswerOperationRef.current) finishingRef.current = false
    }
  }

  const finishAnswerInner = async (): Promise<void> => {
    const generation = runGenerationRef.current.current()
    const answerId = answerIdRef.current
    const answerStart = curStart
    const answerEndedAt = Date.now()
    stopListening() // flush 同步呼叫 VAD callback，隨後可讀取完整 pending 集合
    const pending = pendingRef.current.take(answerId)
    // 等待期間一定要讓 UI 看得出在忙:stopListening 已把 recording 設成 false,
    // 主要按鈕會換回「開始回答」,而 finishingRef 會讓點擊靜默失效。
    // 少了這一段就是「可按、按了沒反應、最長 65 秒」。
    setDraining(true)
    let result: DrainResult
    try {
      result = await drainPending(pending, 65_000)
    } finally {
      if (runGenerationRef.current.isCurrent(generation)) setDraining(false)
    }
    // 世代閘門必須在**每一個副作用之前**,不是之後才檢查。
    // drainPending 最多等 65 秒;這段時間裡使用者可能按了重新開始
    // (reset → runGenerationRef.invalidate)。若把檢查寫在下面,重置後才抵達的
    // 逾時回覆仍會:對**新**一輪的 segsRef 呼叫 finalize(提前釋放新場次還在飛的
    // 槽位)、把舊逐字稿 push 進 main 的 panic/coaching 上下文(新場次會引用它)。
    // 這正是 GenerationGate 要消滅的那類污染,只是從另一條路鑽進來。
    if (!runGenerationRef.current.isCurrent(generation)) return
    // A timed-out ASR promise may resolve later. Once this answer is finalized, its
    // callbacks must not alter the transcript while feedback or the next answer starts.
    if (answerIdRef.current === answerId) answerIdRef.current += 1
    const lateChunks = segsRef.current.finalize()
    if (lateChunks.length > 0) {
      setCurTranscript(segsRef.current.toString())
      for (const chunk of lateChunks) void window.api.pushTranscript({ text: chunk, speaker: 'me' })
    }
    // 逾時或有段落失敗 ⇒ 這份逐字稿不完整。分數照算(否則整題白費),
    // 但旗標必須跟答案一起存下去,否則事後只看得到一個分數。
    const partial = !result.drained || segFailRef.current
    if (!result.drained) {
      toast.error('語音辨識逾時，先用目前收到的逐字稿評分——這次的逐字稿可能少了結尾')
    }
    const q = questions[qIndex]
    const transcript = segsRef.current.toString()
    if (!transcript.trim()) {
      // 錄音已停、音訊已丟,這一題的回答沒有辦法挽回 —— 訊息必須說清楚
      // 「怎麼辦」(重答),不能只有一句無出路的「沒有聽到」。
      toast.error(`沒有聽到回答內容。請確認麥克風沒有被靜音、音量沒有歸零,再按「開始回答」重答這題${q ? `:${q}` : ''}。`)
      return
    }
    if (!settings) return
    const aiProvider = settings.ai.provider
    const feedbackStartedAt = Date.now()
    setBusy('feedback')
    stopSpeaking()
    // 個人語速基準（若有校準）：實際語速 vs 個人基準，供表達面反饋對照
    const baselineCpm = settings.personal.profile?.charsPerMin
    const answerSecs = Math.max(0, (answerEndedAt - answerStart) / 1000)
    const actualChars = countReadableChars(transcript)
    const actualCpm = answerSecs > 0 ? Math.round((actualChars / answerSecs) * 60) : null
    const rateLine =
      baselineCpm && actualCpm
        ? `\n\n使用者個人語速基準：${baselineCpm} 字/分（校準值）。本次回答共 ${actualChars} 字、${answerSecs.toFixed(0)} 秒，實際語速約 ${actualCpm} 字/分（基準的 ${Math.round((actualCpm / baselineCpm) * 100)}%）。請在 delivery 反饋中對照此基準評估語速快慢與停頓。`
        : '\n\n（使用者未校準語速，delivery 請依逐字稿長度與流暢度推估。）'
    const chat = startAiChat(settings, [
      { role: 'system', content: '你是資深面試教練。只輸出 JSON，不要任何說明。使用繁體中文。' },
      {
        role: 'user',
        content: `面試題目：${q}\n應徵職位/情境：${position.trim()}（${type}）\n應徵者的回答逐字稿：\n${transcript}${rateLine}\n\n請評估此回答並輸出 JSON：{"score":0到100整數,"content":"內容面反饋（切題度、觀點、例證，2-3句）","structure":"結構面反饋（邏輯條理，2句）","delivery":"表達面反饋（語速與流暢度，對照個人語速基準，2句）","betterAnswer":"80-150字的示範回答"}`
      }
    ])
    cancelRef.current = chat.cancel
    try {
      const raw = await chat.promise
      if (!runGenerationRef.current.isCurrent(generation)) return
      const fb = extractJson<PracticeFeedback>(raw)
      const answer = buildPracticeAnswer({
        question: q,
        transcript,
        answerStart,
        answerEndedAt,
        partial,
        feedback: fb
      })
      setAnswers((a) => [...a, answer])
      // 練習的兩個 AI 呼叫(逐題反饋、整體總評)是使用者最常說「卡住了」的地方。
      // 沒有耗時就只能分辨「慢」與「壞掉」——兩者的處置完全不同。
      reportEvent('ai_request_succeeded', {
        metrics: { feedbackMs: Date.now() - feedbackStartedAt },
        fields: { provider: aiProvider }
      })
    } catch (err) {
      if (!runGenerationRef.current.isCurrent(generation)) return
      // 使用者自己按的取消:不是錯誤,但**回答要保留** ——
      // 他已經開口講完了,不能因為他不想等教練評論就把逐字稿丟掉。
      if (isCancelled(err)) {
        // 取消的是**反饋**,不是轉錄:逐字稿是完整的。
        // 原本這裡寫死 partial: true —— 於是「不想等評論」的答案被標成
        // 「逐字稿可能不完整(語音辨識逾時或有段落失敗)」,那是一則錯誤的
        // 診斷,使用者會去查一個沒壞的麥克風。「未評分」由沒有 feedback 表示。
        setAnswers((a) => [
          ...a,
          buildPracticeAnswer({ question: q, transcript, answerStart, answerEndedAt, partial })
        ])
        return
      }
      reportError('反饋未能產生，你的回答已保留', err, {
        event: 'ai_request_failed',
        provider: aiProvider
      })
      // 反饋失敗仍保留回答文字(未評分 —— 不等於逐字稿不完整)
      setAnswers((a) => [
        ...a,
        buildPracticeAnswer({ question: q, transcript, answerStart, answerEndedAt, partial })
      ])
    } finally {
      cancelRef.current = null
      if (runGenerationRef.current.isCurrent(generation)) setBusy(null)
    }
  }

  const finishRun = async (): Promise<void> => {
    if (finishingRunRef.current) return
    finishingRunRef.current = true
    const operation = ++finishRunOperationRef.current
    try {
      await finishRunInner()
    } finally {
      if (operation === finishRunOperationRef.current) finishingRunRef.current = false
    }
  }

  const finishRunInner = async (): Promise<void> => {
    const generation = runGenerationRef.current.current()
    stopSpeaking()
    let overall = overallCacheRef.current ?? ''
    let overallFailed = false
    let overallCancelled = false
    if (settings && overallCacheRef.current == null) {
      setBusy('overall')
      try {
        const recap = answersRef.current
          .map((a, i) => `題${i + 1}：${a.question}\n回答：${a.answerTranscript.slice(0, 600)}`)
          .join('\n\n')
        const overallStartedAt = Date.now()
        const chat = startAiChat(settings, [
          { role: 'system', content: '你是資深面試教練，使用繁體中文。' },
          {
            role: 'user',
            content: `以下是應徵「${position.trim()}」的完整面試練習紀錄。請給一段 150-250 字的整體總評：最大優點、最大弱點、三個具體練習建議。\n\n${recap}`
          }
        ])
        cancelRef.current = chat.cancel
        overall = await chat.promise
        if (!runGenerationRef.current.isCurrent(generation)) return
        overallCacheRef.current = overall
        reportEvent('ai_request_succeeded', {
          metrics: { overallMs: Date.now() - overallStartedAt },
          fields: { provider: settings.ai.provider }
        })
      } catch (err) {
        if (!runGenerationRef.current.isCurrent(generation)) return
        overall = ''
        // 使用者取消不是失敗:不記事件、不跳錯誤 toast,直接往下存練習紀錄。
        // 他已經練完了,唯一想要的是「存下來就好」。
        if (isCancelled(err)) {
          overallCancelled = true
        } else {
          overallFailed = true
          // 總評失敗**不會丟資料**(練習紀錄照存),所以提示不能寫成災難:
          // prefix 講清楚「紀錄仍會保存」,可行動提示則照常給(去設定/下載 Ollama)。
          reportError('整體總評未能產生，練習紀錄仍會保存', err, {
            event: 'ai_request_failed',
            provider: settings.ai.provider === 'ollama' ? 'ollama' : 'openai-compatible'
          })
        }
      } finally {
        cancelRef.current = null
        if (runGenerationRef.current.isCurrent(generation)) setBusy(null)
      }
    }
    if (!runGenerationRef.current.isCurrent(generation)) return
    const runData: PracticeRun = {
      position: position.trim(),
      type,
      questions,
      answers,
      createdAt: Date.now(),
      overallFeedback: overall || undefined
    }
    let id: number
    try {
      id = await db.practiceRuns.add(runData)
    } catch (err) {
      if (!runGenerationRef.current.isCurrent(generation)) return
      // 寫入失敗(IndexedDB 滿/隱私模式)要有聲:留在 run 階段讓使用者重試,
      // 而不是靜默丟掉整輪練習(與 Record 存講稿、Calibration 套用同一標準)。
      reportError('練習紀錄儲存失敗,尚未存檔', err, { event: 'backup_failed' })
      return
    }
    if (!runGenerationRef.current.isCurrent(generation)) {
      // IndexedDB add 在取消與完成同時競態時不可取消；刪掉已寫入的過期那筆。
      await db.practiceRuns.delete(id)
      return
    }
    setRun({ ...runData, id })
    overallCacheRef.current = null
    if (overallFailed) toast.info('你仍可查看逐題反饋與保存的練習紀錄。')
    if (overallCancelled) toast.info('已略過整體總評，逐題反饋與練習紀錄都已保存。')
    setPhase('done')
    // 與 Record 的停止路徑同一個理由:練習結束後 main 端不該還留著這一輪的
    // 語音上下文(Alt+P 或下一輪開始前的任何一次提問都可能帶著舊內容)。
    void window.api.contextReset()
    await refreshHistory()
  }

  const nextQuestion = (): void => {
    if (advancingRef.current) return
    advancingRef.current = true
    setTimeout(() => {
      advancingRef.current = false
    }, 300)
    if (qIndex + 1 >= questions.length) {
      void finishRun()
    } else {
      setQIndex((i) => i + 1)
      setCurTranscript('')
      segsRef.current = new OrderedTranscript()
    }
  }

  const avgScore =
    answers.filter((a) => a.feedback).length > 0
      ? Math.round(
          answers.filter((a) => a.feedback).reduce((s, a) => s + (a.feedback?.score ?? 0), 0) /
            answers.filter((a) => a.feedback).length
        )
      : null

  const removeHistory = async (id?: number): Promise<void> => {
    if (id == null) return
    // 永久刪除要有確認:與 Record 會議歷史、Scripts 講稿刪除同一標準
    if (
      !(await confirmDialog({
        title: '刪除這次練習紀錄？',
        body: '逐題反饋與總評會一併移除，無法復原。',
        confirmLabel: '刪除紀錄',
        variant: 'danger'
      }))
    )
      return
    await db.practiceRuns.delete(id)
    await refreshHistory()
    toast.info('練習紀錄已刪除')
  }

  const loadHistory = (r: PracticeRun): void => {
    setRun(r)
    setPosition(r.position)
    setType(r.type)
    setQuestions(r.questions)
    setAnswers(r.answers)
    setQIndex(Math.max(0, r.answers.length - 1))
    setPhase('done')
  }

  const reset = (): void => {
    runGenerationRef.current.invalidate()
    startAttemptRef.current += 1
    setBusy(null)
    setDraining(false)
    answerIdRef.current += 1
    finishAnswerOperationRef.current += 1
    finishRunOperationRef.current += 1
    finishingRef.current = false
    finishingRunRef.current = false
    advancingRef.current = false
    sttFailStreakRef.current = 0
    sttNotifiedRef.current = false
    setSttFailed(false)
    overallCacheRef.current = null
    stopSpeaking()
    stopListening()
    setPhase('setup')
    setRun(null)
    setAnswers([])
    setQuestions([])
    setCurTranscript('')
  }

  // ============ 畫面 ============
  if (phase === 'setup') {
    return (
      <div className="mx-auto max-w-2xl px-8 py-8">
        <h1 className="mb-6 text-xl font-bold">面試練習</h1>
        <div className="card space-y-5 p-6">
          <div>
            <div className="label">職位或情境</div>
            <input
              aria-label="職位或情境" className="input"
              placeholder="例如：產品經理、後端工程師、研究所口試"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            />
          </div>
          <div>
            <div className="label">練習類型</div>
            <div className="flex flex-wrap gap-2">
              {PRACTICE_TYPES.map((t) => (
                <button
                  key={t}
                  // 名稱來自 PRACTICE_TYPES 常數,但這一族是「選一個」的按鈕群:
                  // 稽核要驗的是「選了之後出題真的用這個類型」,不是每一個字串
                  data-effect-id="practice-type"
                  onClick={() => setType(t)}
                  className={cn(
                    'rounded-lg border px-3.5 py-2 text-sm transition-colors cursor-pointer',
                    type === t
                      ? 'border-accent-500 bg-accent-500/10 text-ink-100'
                      : 'border-ink-700 text-ink-300 hover:border-ink-600'
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="label">題數</div>
            <div className="flex gap-2">
              {[3, 5, 8].map((n) => (
                <button
                  key={n}
                  data-effect-id="practice-count"
                  onClick={() => setCount(n)}
                  className={cn(
                    'h-9 w-12 rounded-lg border text-sm transition-colors cursor-pointer',
                    count === n
                      ? 'border-accent-500 bg-accent-500/10 text-ink-100'
                      : 'border-ink-700 text-ink-300 hover:border-ink-600'
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <CancelableBusy
            busy={busy === 'questions'}
            onCancel={() => cancelRef.current?.()}
            onIdleClick={startPractice}
            busyLabel={
              <>
                <Loader2 size={14} className="animate-spin" /> AI 出題中…
              </>
            }
            idleLabel={
              <>
                <GraduationCap size={15} /> 開始練習
              </>
            }
          />
          <div className="text-center text-[11px] text-ink-400">
            流程：AI 出題並朗讀 → 你用麥克風回答 → AI 即時反饋評分 → 最後總評
          </div>
        </div>

        {history.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 text-sm font-medium text-ink-200">練習紀錄</div>
            <div className="space-y-2">
              {history.map((r) => (
                <div key={r.id} className="card flex items-center justify-between px-4 py-2.5">
                  <button
                    // 名稱是「職稱 · 類型」(使用者輸入的)→ 動態
                    data-effect-id="practice-row"
                    className="min-w-0 flex-1 text-left cursor-pointer"
                    onClick={() => loadHistory(r)}
                  >
                    {/* 職稱欄可以長到把整列截斷(position 是使用者自己輸入的,
                        稽核的長標題狀態量到 756 > 533)。沒有 title 就只剩半個字。 */}
                    <div className="truncate text-sm" title={`${r.position} · ${r.type}`}>
                      {r.position} · {r.type}
                    </div>
                    <div className="text-[11px] text-ink-400">
                      {formatDateTime(r.createdAt)} · {r.answers.length} 題
                    </div>
                  </button>
                  <button
                    className="btn-ghost text-rose-450"
                    onClick={() => removeHistory(r.id)}
                    title="刪除這次練習紀錄"
                    aria-label="刪除這次練習紀錄"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  if (phase === 'run') {
    const q = questions[qIndex]
    const curAnswer = answers[qIndex]
    return (
      <div className="mx-auto flex h-full max-w-3xl flex-col px-8 py-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-sm text-ink-300">
            第 {qIndex + 1} / {questions.length} 題 · {position}（{type}）
          </div>
          <button
            className="btn-ghost text-xs"
            onClick={async () => {
              if (!(await confirmDialog({
                title: '結束這次練習？',
                body: '尚未完成的作答不會存入練習紀錄。',
                confirmLabel: '結束並放棄',
                variant: 'danger'
              }))) return
              reset()
            }}
          >
            結束練習
          </button>
        </div>

        {/* 辨識持續失敗橫幅(與 Record 同一個門檻與措辭思路):
            沒有它,使用者拿到的是一個偏低的分數,而他永遠不會知道
            原因是「你講的話根本沒進系統」。 */}
        {sttFailed && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2.5 rounded-xl border border-rose-450/40 bg-rose-450/10 px-4 py-3 text-sm text-rose-300"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">語音辨識持續失敗,你這段回答不會被完整記錄</div>
              <div className="mt-0.5 text-xs text-rose-300/80">
                請確認本地模型已下載(或雲端 API 金鑰有效)後重新回答,否則評分只會看到零碎的逐字稿。
              </div>
            </div>
          </div>
        )}

        {/* 首次使用:本地模型下載進度(與 Record/Calibration 同款) */}
        {modelDL && (
          <div className="card mb-4 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs text-ink-300">
              <Download size={13} /> 下載 Whisper {modelKey} 模型（首次需要，之後會快取）
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
              <div className="h-full bg-accent-500 transition-[width]" style={{ width: `${modelDL.progress}%` }} />
            </div>
            <div className="mt-1.5 font-mono text-[10px] text-ink-400">
              {modelDL.file} {modelDL.progress.toFixed(0)}%
            </div>
          </div>
        )}

        {/* 題目與回答 */}
        <div className="card mb-4 min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="text-lg font-semibold leading-relaxed">{q}</div>
            <button
              className="btn-ghost shrink-0"
              title="朗讀題目"
              onClick={() => speak(q, { lang: 'zh-TW' })}
            >
              <Volume2 size={16} />
            </button>
          </div>
          {curAnswer ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-ink-850 p-4 text-sm leading-relaxed">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
                  你的回答（{formatDuration(curAnswer.durationSec)}）
                  {curAnswer.partial && (
                    <span
                      className="rounded bg-amber-450/15 px-1.5 py-0.5 text-[10px] text-amber-450"
                      title="語音辨識逾時或有段落失敗,這份逐字稿可能少了結尾"
                    >
                      逐字稿可能不完整
                    </span>
                  )}
                  {!curAnswer.feedback && (
                    // 「沒有拿到反饋」是另一件事:取消或 AI 失敗時逐字稿仍然完整,
                    // 不能借用 partial 的視覺(那是「逐字稿壞了」的診斷)。
                    <span
                      className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300"
                      title="AI 反饋沒有產生(被取消或失敗)—— 逐字稿保留,可直接下一題"
                    >
                      未評分
                    </span>
                  )}
                </div>
                {curAnswer.answerTranscript}
              </div>
              {curAnswer.feedback && (
                <div className="space-y-3 rounded-lg border border-accent-500/25 bg-accent-500/5 p-4 text-xs leading-relaxed">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        'flex h-11 w-11 items-center justify-center rounded-full text-lg font-bold',
                        curAnswer.feedback.score >= 70
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : curAnswer.feedback.score >= 40
                            ? 'bg-amber-450/15 text-amber-450'
                            : 'bg-rose-450/15 text-rose-450'
                      )}
                    >
                      {curAnswer.feedback.score}
                    </div>
                    <div className="font-medium text-accent-300">AI 教練反饋</div>
                  </div>
                  <div>
                    <span className="font-medium text-ink-200">內容：</span>
                    {curAnswer.feedback.content}
                  </div>
                  <div>
                    <span className="font-medium text-ink-200">結構：</span>
                    {curAnswer.feedback.structure}
                  </div>
                  <div>
                    <span className="font-medium text-ink-200">表達：</span>
                    {curAnswer.feedback.delivery}
                  </div>
                  <div className="border-t border-ink-800 pt-3">
                    <div className="mb-1 font-medium text-ink-200">示範回答</div>
                    {curAnswer.feedback.betterAnswer}
                  </div>
                </div>
              )}
              <CancelableBusy
                busy={busy === 'overall'}
                onCancel={() => cancelRef.current?.()}
                onIdleClick={nextQuestion}
                busyLabel={
                  <>
                    <Loader2 size={14} className="animate-spin" /> 產生總評中…
                  </>
                }
                idleLabel={
                  <>
                    {qIndex + 1 >= questions.length ? '查看總評' : '下一題'}
                    <ChevronRight size={14} />
                  </>
                }
                disabled={busy !== null}
              />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="min-h-[60px] rounded-lg bg-ink-850 p-4 text-sm leading-relaxed">
                {curTranscript || (
                  <span className="text-ink-400">
                    按下「開始回答」後說話，這裡會即時出現你的回答…
                  </span>
                )}
              </div>
              {recording && (
                <div className="flex items-center gap-2 text-xs text-rose-450">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-rose-450" />
                  錄音中
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800">
                    <div
                      className="h-full bg-rose-450 transition-[width] duration-100"
                      style={{ width: `${level * 100}%` }}
                    />
                  </div>
                </div>
              )}
              {recording ? (
                <CancelableBusy
                  busy={busy === 'feedback'}
                  // 正在收帳最後一段 STT 時不能取消:那不是 AI 請求,
                  // 而且使用者按下去會以為能停,其實只會停掉一個正在等的東西。
                  cancellable={!draining}
                  onCancel={() => cancelRef.current?.()}
                  busyLabel={
                    draining ? (
                      <>
                        <Loader2 size={14} className="animate-spin" /> 整理最後一句…
                      </>
                    ) : (
                      <>
                        <Loader2 size={14} className="animate-spin" /> AI 評分中…
                      </>
                    )
                  }
                  idleLabel={
                    <>
                      <Square size={14} /> 完成回答，取得反饋
                    </>
                  }
                  onIdleClick={finishAnswer}
                  disabled={busy !== null || draining}
                />
              ) : (
                <button
                  className="btn-primary w-full"
                  onClick={startListening}
                  disabled={busy !== null || starting || draining}
                >
                  {starting || draining ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Mic size={14} />
                  )}
                  {draining ? '整理最後一句…' : starting ? '啟動中…' : '開始回答'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* 題目進度 */}
        <div className="flex gap-1.5">
          {questions.map((_, i) => (
            <div
              key={i}
              className={cn(
                'h-1 flex-1 rounded-full',
                i < qIndex ? 'bg-accent-500' : i === qIndex ? 'bg-accent-400' : 'bg-ink-800'
              )}
            />
          ))}
        </div>
      </div>
    )
  }

  // done
  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">練習完成</h1>
        <button className="btn-outline text-xs" onClick={reset}>
          再練一輪
        </button>
      </div>
      {avgScore != null && (
        <div className="card mb-4 flex items-center gap-5 p-6">
          <div
            className={cn(
              'flex h-16 w-16 items-center justify-center rounded-full text-2xl font-bold',
              avgScore >= 70
                ? 'bg-emerald-500/15 text-emerald-400'
                : avgScore >= 40
                  ? 'bg-amber-450/15 text-amber-450'
                  : 'bg-rose-450/15 text-rose-450'
            )}
          >
            {avgScore}
          </div>
          <div>
            <div className="font-semibold">
              {run?.position ?? position} · {run?.type ?? type}
            </div>
            <div className="mt-0.5 text-xs text-ink-400">
              {answers.length} 題 · 平均得分 {avgScore} / 100
            </div>
          </div>
        </div>
      )}
      {/* 量化回饋(語速/時長) */}
      {(() => {
        const pa = analyzePracticeRun(answers)
        if (pa.perAnswer.length === 0) return null
        const totalSec = pa.perAnswer.reduce((a, b) => a + b.durationSec, 0)
        return (
          <div className="card mb-4 p-4">
            <div className="mb-2.5 text-xs font-medium text-ink-300">量化回饋</div>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-ink-800 bg-ink-850/60 p-3">
                <div className="text-[10px] text-ink-400">平均語速</div>
                <div className="mt-0.5 text-lg font-semibold">{pa.avgCpm} <span className="text-[10px] text-ink-400">字/分</span></div>
                <div className="text-[10px] text-ink-400">理想區間 150–260</div>
              </div>
              <div className="rounded-lg border border-ink-800 bg-ink-850/60 p-3">
                <div className="text-[10px] text-ink-400">回答總時長</div>
                <div className="mt-0.5 text-lg font-semibold">{formatDuration(totalSec)}</div>
                <div className="text-[10px] text-ink-400">{pa.perAnswer.length} 題有效回答</div>
              </div>
              <div className="rounded-lg border border-ink-800 bg-ink-850/60 p-3">
                <div className="text-[10px] text-ink-400">各題語速</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {pa.perAnswer.map((p) => (
                    <span
                      key={p.index}
                      title={`第 ${p.index + 1} 題 · ${formatDuration(p.durationSec)}`}
                      className={cn(
                        'rounded px-1.5 py-0.5 font-mono text-[10px]',
                        p.cpm > 320
                          ? 'bg-rose-450/15 text-rose-450'
                          : p.cpm < 120
                            ? 'bg-amber-450/15 text-amber-450'
                            : 'bg-emerald-500/15 text-emerald-400'
                      )}
                    >
                      {p.cpm}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )
      })()}
      {run?.overallFeedback && (
        <div className="card mb-4 p-6 text-sm leading-relaxed">
          <div className="mb-2 flex items-center gap-2 font-medium text-accent-300">
            <Sparkles size={14} /> 教練總評
          </div>
          {run.overallFeedback}
        </div>
      )}
      <div className="space-y-3">
        {answers.map((a, i) => (
          <div key={i} className="card p-5">
            <div className="mb-2 flex items-start justify-between gap-3 text-sm font-medium">
              <span>
                {i + 1}. {a.question}
              </span>
              {a.feedback && (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-xs',
                    a.feedback.score >= 70
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : a.feedback.score >= 40
                        ? 'bg-amber-450/15 text-amber-450'
                        : 'bg-rose-450/15 text-rose-450'
                  )}
                >
                  {a.feedback.score}
                </span>
              )}
            </div>
            <div className="text-xs leading-relaxed text-ink-300">{a.answerTranscript}</div>
            {a.partial && (
              <div className="mt-1.5 text-[10px] text-amber-450">
                逐字稿可能不完整（當時語音辨識逾時或有段落失敗）
              </div>
            )}
            {!a.feedback && (
              <div className="mt-1.5 text-[10px] text-ink-400">
                未評分（AI 反饋被取消或未能產生——逐字稿保留）
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
