import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
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
import { useSettings } from '../lib/store'
import { cn, formatDateTime, formatDuration } from '../lib/utils'
import { aiChat, extractJson } from '../lib/ai'
import { countReadableChars } from '../lib/calibration'
import { speak, stopSpeaking, warmUpVoices } from '../lib/tts'
import { AudioSegmenter } from '../lib/audio/segmenter'
import { WhisperClient, type WhisperModelKey } from '../lib/audio/whisperClient'
import { encodeWav } from '../lib/audio/wav'
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
  const [level, setLevel] = useState(0)
  const [busy, setBusy] = useState<string | null>(null) // 'questions' | 'feedback' | 'overall'
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<PracticeRun | null>(null)
  const [history, setHistory] = useState<PracticeRun[]>([])

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
      segmenterRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      stopSpeaking()
    }
  }, [])

  const ensureWhisper = async (): Promise<void> => {
    if (!whisperRef.current) whisperRef.current = new WhisperClient()
    const client = whisperRef.current
    if (!client.isLoaded()) {
      await client.load(modelKey)
    }
  }

  const onSegment = async (audio: Float32Array, sr: number): Promise<void> => {
    if (!settings) return
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
        segsRef.current = [...segsRef.current, text.trim()]
        setCurTranscript(segsRef.current.join(''))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const startListening = async (): Promise<void> => {
    setError(null)
    try {
      if (settings?.stt.engine === 'local') await ensureWhisper()
      segsRef.current = []
      setCurTranscript('')
      setCurStart(Date.now())
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
        onSegment: (audio, sr) => void onSegment(audio, sr),
        onLevel: setLevel,
        threshold: 0.01
      })
      await segmenterRef.current.start(stream)
      setRecording(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
      setError('請填寫職位或情境，例如「產品經理」')
      return
    }
    setError(null)
    setBusy('questions')
    try {
      if (settings.ai.provider === 'ollama') {
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
      setPhase('run')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const finishAnswer = async (): Promise<void> => {
    stopListening()
    const q = questions[qIndex]
    const transcript = segsRef.current.join('')
    if (!transcript.trim()) {
      setError('沒有聽到回答內容')
      return
    }
    if (!settings) return
    setError(null)
    setBusy('feedback')
    stopSpeaking()
    const answerStart = curStart
    // 個人語速基準（若有校準）：實際語速 vs 個人基準，供表達面反饋對照
    const baselineCpm = settings.personal.profile?.charsPerMin
    const answerSecs = (Date.now() - answerStart) / 1000
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
        durationSec: (Date.now() - answerStart) / 1000,
        feedback: fb
      }
      setAnswers((a) => [...a, answer])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      // 反饋失敗仍保留回答文字
      setAnswers((a) => [
        ...a,
        {
          question: q,
          answerTranscript: transcript,
          durationSec: (Date.now() - answerStart) / 1000
        }
      ])
    } finally {
      setBusy(null)
    }
  }

  const finishRun = async (): Promise<void> => {
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
    await db.practiceRuns.delete(id)
    await refreshHistory()
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
              className="input"
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
          {error && (
            <div className="rounded-lg border border-rose-450/30 bg-rose-450/10 px-4 py-2.5 text-xs text-rose-450">
              {error}
            </div>
          )}
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
                    <div className="truncate text-sm">
                      {r.position} · {r.type}
                    </div>
                    <div className="text-[11px] text-ink-400">
                      {formatDateTime(r.createdAt)} · {r.answers.length} 題
                    </div>
                  </button>
                  <button className="btn-ghost text-rose-450" onClick={() => removeHistory(r.id)}>
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
                <div className="mb-1 text-[11px] text-ink-400">
                  你的回答（{formatDuration(curAnswer.durationSec)}）
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
              {error && (
                <div className="rounded-lg border border-rose-450/30 bg-rose-450/10 px-4 py-2.5 text-xs text-rose-450">
                  {error}
                </div>
              )}
              {recording ? (
                <button
                  className="btn-primary w-full"
                  onClick={finishAnswer}
                  disabled={busy !== null}
                >
                  {busy === 'feedback' ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> AI 評分中…
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
                  disabled={busy !== null}
                >
                  <Mic size={14} /> 開始回答
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
          </div>
        ))}
      </div>
    </div>
  )
}
