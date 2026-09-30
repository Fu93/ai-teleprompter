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
import { describeError } from '../lib/describeError'
import { useSettings } from '../lib/store'
import { cn, formatDateTime, formatDuration } from '../lib/utils'
import { aiChat, extractJson } from '../lib/ai'
import { countReadableChars } from '../lib/calibration'
import { speak, stopSpeaking, warmUpVoices } from '../lib/tts'
import { AudioSegmenter } from '../lib/audio/segmenter'
import { WhisperClient, type WhisperModelKey } from '../lib/audio/whisperClient'
import { encodeWav } from '../lib/audio/wav'
import {
  createPendingTracker,
  drainPending,
  STT_FAILURE_BANNER_THRESHOLD,
  type DrainResult
} from '../lib/transcriptionQueue'
import { confirmDialog } from '../lib/confirm'
import { toast } from '../lib/toast'
import { analyzePracticeRun } from '../lib/session-intelligence'

const PRACTICE_TYPES = ['行為面試', '技術面試', '自我介紹', '案例簡報', '銷售情境'] as const

type Phase = 'setup' | 'run' | 'done'

export default function Practice(): JSX.Element {
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
  const startAttemptRef = useRef(0)
  const answerIdRef = useRef(0)
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
  const segsRef = useRef<string[]>([])
  const answersRef = useRef<PracticeAnswer[]>([])
  answersRef.current = answers

  const modelKey = (settings?.stt.localModel ?? 'base') as WhisperModelKey

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistory(await db.practiceRuns.orderBy('createdAt').reverse().limit(10).toArray())
  }, [])

  useEffect(() => {
    void refreshHistory()
    warmUpVoices()
  }, [refreshHistory])

  useEffect(() => {
    return () => {
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

  const onSegment = async (audio: Float32Array, sr: number, answerId: number): Promise<void> => {
    if (!settings) return
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
      if (text.trim()) {
        if (answerId !== answerIdRef.current) return
        segsRef.current = [...segsRef.current, text.trim()]
        setCurTranscript(segsRef.current.join(''))
        // 餵 main:panic(Alt+P)有作答上下文、coaching 教練提示來源
        void window.api.pushTranscript({ text: text.trim(), speaker: 'me' })
        // 成功一次就代表辨識通了:清掉失敗累積,橫幅自動消失
        sttFailStreakRef.current = 0
        if (sttNotifiedRef.current) {
          sttNotifiedRef.current = false
          setSttFailed(false)
        }
      }
    } catch (err) {
      if (answerId === answerIdRef.current) {
        segFailRef.current = true
        sttFailStreakRef.current += 1
        const ctx = sttEngine === 'cloud' ? { provider: 'cloud-api' as const } : undefined
        if (sttFailStreakRef.current >= STT_FAILURE_BANNER_THRESHOLD) {
          if (!sttNotifiedRef.current) {
            sttNotifiedRef.current = true
            toast.error(describeError(err, ctx))
          }
          setSttFailed(true)
        } else {
          toast.error(describeError(err, ctx))
        }
      }
    }
  }

  const queueAnswerTranscription = (audio: Float32Array, sr: number, answerId: number): void => {
    pendingRef.current.track(answerId, onSegment(audio, sr, answerId))
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
      if (settings?.stt.engine === 'local') await ensureWhisper()
      if (attempt !== startAttemptRef.current) return
      const answerId = ++answerIdRef.current
      segsRef.current = []
      segFailRef.current = false
      setCurTranscript('')
      const startedAt = Date.now()
      setCurStart(startedAt)
      // 會話邊界必須先清完 main 端上下文，避免清理晚於第一筆新逐字稿。
      await window.api.contextReset()
      if (attempt !== startAttemptRef.current) return
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
      toast.error(describeError(err))
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
    if (!position.trim()) {
      toast.error('請填寫職位或情境，例如「產品經理」')
      return
    }
    setBusy('questions')
    const aiProvider = settings.ai.provider
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
      const raw = await aiChat(settings, [
        { role: 'system', content: '你是資深面試官。只輸出 JSON，不要任何說明。使用繁體中文。' },
        {
          role: 'user',
          content: `為應徵「${position.trim()}」的${type}設計 ${count} 道面試題。輸出 JSON 字串陣列，例如 ["題目1","題目2"]。題目要具體、由淺入深。`
        }
      ])
      const qs = extractJson<string[]>(raw).filter((q) => typeof q === 'string' && q.trim())
      if (qs.length === 0) throw new Error('AI 沒有產出題目，請再試一次或換模型')
      setQuestions(qs)
      setQIndex(0)
      setAnswers([])
      // 新的一輪從乾淨的失敗計數開始(上一輪的紅色橫幅不該跟著進來)
      sttFailStreakRef.current = 0
      sttNotifiedRef.current = false
      setSttFailed(false)
      setPhase('run')
    } catch (err) {
      toast.error(describeError(err, { provider: aiProvider }))
    } finally {
      setBusy(null)
    }
  }

  const finishAnswer = async (): Promise<void> => {
    if (finishingRef.current) return
    finishingRef.current = true
    try {
      await finishAnswerInner()
    } finally {
      finishingRef.current = false
    }
  }

  const finishAnswerInner = async (): Promise<void> => {
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
      setDraining(false)
    }
    // 逾時或有段落失敗 ⇒ 這份逐字稿不完整。分數照算(否則整題白費),
    // 但旗標必須跟答案一起存下去,否則事後只看得到一個分數。
    const partial = !result.drained || segFailRef.current
    if (!result.drained) {
      toast.error('語音辨識逾時，先用目前收到的逐字稿評分——這次的逐字稿可能少了結尾')
    }
    const q = questions[qIndex]
    const transcript = segsRef.current.join('')
    if (!transcript.trim()) {
      toast.error('沒有聽到回答內容')
      return
    }
    if (!settings) return
    const aiProvider = settings.ai.provider
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
    try {
      const raw = await aiChat(settings, [
        { role: 'system', content: '你是資深面試教練。只輸出 JSON，不要任何說明。使用繁體中文。' },
        {
          role: 'user',
          content: `面試題目：${q}\n應徵職位/情境：${position.trim()}（${type}）\n應徵者的回答逐字稿：\n${transcript}${rateLine}\n\n請評估此回答並輸出 JSON：{"score":0到100整數,"content":"內容面反饋（切題度、觀點、例證，2-3句）","structure":"結構面反饋（邏輯條理，2句）","delivery":"表達面反饋（語速與流暢度，對照個人語速基準，2句）","betterAnswer":"80-150字的示範回答"}`
        }
      ])
      const fb = extractJson<PracticeFeedback>(raw)
      const answer: PracticeAnswer = {
        question: q,
        answerTranscript: transcript,
        durationSec: Math.max(0, (answerEndedAt - answerStart) / 1000),
        feedback: fb,
        partial: partial || undefined
      }
      setAnswers((a) => [...a, answer])
    } catch (err) {
      toast.error(describeError(err, { provider: aiProvider }))
      // 反饋失敗仍保留回答文字
      setAnswers((a) => [
        ...a,
        {
          question: q,
          answerTranscript: transcript,
          durationSec: Math.max(0, (answerEndedAt - answerStart) / 1000),
          partial: partial || undefined
        }
      ])
    } finally {
      setBusy(null)
    }
  }

  const finishRun = async (): Promise<void> => {
    if (finishingRunRef.current) return
    finishingRunRef.current = true
    try {
      await finishRunInner()
    } finally {
      finishingRunRef.current = false
    }
  }

  const finishRunInner = async (): Promise<void> => {
    stopSpeaking()
    let overall = ''
    if (settings) {
      setBusy('overall')
      try {
        const recap = answersRef.current
          .map((a, i) => `題${i + 1}：${a.question}\n回答：${a.answerTranscript.slice(0, 600)}`)
          .join('\n\n')
        overall = await aiChat(settings, [
          { role: 'system', content: '你是資深面試教練，使用繁體中文。' },
          {
            role: 'user',
            content: `以下是應徵「${position.trim()}」的完整面試練習紀錄。請給一段 150-250 字的整體總評：最大優點、最大弱點、三個具體練習建議。\n\n${recap}`
          }
        ])
      } catch {
        overall = ''
      } finally {
        setBusy(null)
      }
    }
    const runData: PracticeRun = {
      position: position.trim(),
      type,
      questions,
      answers,
      createdAt: Date.now(),
      overallFeedback: overall || undefined
    }
    const id = await db.practiceRuns.add(runData)
    setRun({ ...runData, id })
    setPhase('done')
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
      segsRef.current = []
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
    startAttemptRef.current += 1
    answerIdRef.current += 1
    sttFailStreakRef.current = 0
    sttNotifiedRef.current = false
    setSttFailed(false)
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
          <button className="btn-primary w-full" onClick={startPractice} disabled={busy !== null}>
            {busy === 'questions' ? (
              <>
                <Loader2 size={14} className="animate-spin" /> AI 出題中…
              </>
            ) : (
              <>
                <GraduationCap size={15} /> 開始練習
              </>
            )}
          </button>
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
          <button className="btn-ghost text-xs" onClick={reset}>
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
              <button
                className="btn-primary w-full"
                onClick={nextQuestion}
                disabled={busy !== null}
              >
                {busy === 'overall' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <>
                    {qIndex + 1 >= questions.length ? '查看總評' : '下一題'}
                    <ChevronRight size={14} />
                  </>
                )}
              </button>
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
                <button
                  className="btn-primary w-full"
                  onClick={finishAnswer}
                  disabled={busy !== null || draining}
                >
                  {busy === 'feedback' ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> AI 評分中…
                    </>
                  ) : draining ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> 整理最後一句…
                    </>
                  ) : (
                    <>
                      <Square size={14} /> 完成回答，取得反饋
                    </>
                  )}
                </button>
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
          </div>
        ))}
      </div>
    </div>
  )
}
