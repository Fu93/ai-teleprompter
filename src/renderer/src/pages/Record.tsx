import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Mic,
  MonitorSpeaker,
  Play,
  Save,
  Sparkles,
  Square,
  Trash2
} from 'lucide-react'
import type { CoachingKind, MeetingSession, MeetingSummary, SessionReport, TranscriptSegment } from '@shared/types'
import { db } from '../lib/db'
import { useSettings } from '../lib/store'
import { cn, formatDateTime, formatDuration } from '../lib/utils'
import { aiChat, extractJson, resolvedModelName } from '../lib/ai'
import { toast } from '../lib/toast'
import { buildSessionReport } from '../lib/session-intelligence'
import { AudioSegmenter } from '../lib/audio/segmenter'
import { WhisperClient, WHISPER_MODELS, type WhisperModelKey } from '../lib/audio/whisperClient'
import { encodeWav } from '../lib/audio/wav'

type ModelState = {
  status: 'none' | 'loading' | 'ready' | 'error'
  progress: number
  file: string
  msg?: string
}

export default function Record(): JSX.Element {
  const { settings } = useSettings()
  const [recording, setRecording] = useState(false)
  const [wantMic, setWantMic] = useState(true)
  const [wantSys, setWantSys] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [sysLevel, setSysLevel] = useState(0)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [title, setTitle] = useState('')
  const [model, setModel] = useState<ModelState>({ status: 'none', progress: 0, file: '' })
  const [saving, setSaving] = useState(false)
  const [sessions, setSessions] = useState<MeetingSession[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [aiBusyId, setAiBusyId] = useState<number | null>(null)
  const [lastReport, setLastReport] = useState<SessionReport | null>(null)
  const [coachCounts, setCoachCounts] = useState<Partial<Record<CoachingKind, number>>>({})

  const whisperRef = useRef<WhisperClient | null>(null)
  const segsRef = useRef<TranscriptSegment[]>([])
  /** 最後一段落帳時間:停止時判斷在飛轉錄是否已完成 */
  const lastSegmentAtRef = useRef(0)
  const startedAtRef = useRef(0)
  const streamsRef = useRef<{ mic?: MediaStream; sys?: MediaStream }>({})
  const segmentersRef = useRef<{ mic?: AudioSegmenter; sys?: AudioSegmenter }>({})
  const transcriptBoxRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef('')
  titleRef.current = title

  const engine = settings?.stt.engine ?? 'local'
  const modelKey = (settings?.stt.localModel ?? 'base') as WhisperModelKey

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessions(await db.sessions.orderBy('startedAt').reverse().limit(15).toArray())
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

  // 自動捲動
  useEffect(() => {
    const el = transcriptBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [segments])

  // unmount 清理:錄音中切頁要收掉分段器與音訊 track(麥克風/系統音訊燈滅),
  // 否則擷取會在背景持續運作(Practice 已有同樣模式)
  useEffect(() => {
    return () => {
      stopAll()
    }
  }, [])

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

  const transcribeSegment = async (audio: Float32Array, sr: number, speaker: 'me' | 'them'): Promise<void> => {
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
      if (!text.trim()) return
      const end = (Date.now() - startedAtRef.current) / 1000
      const seg: TranscriptSegment = {
        speaker,
        text: text.trim(),
        start: Math.max(0, end - audio.length / sr),
        end
      }
      segsRef.current = [...segsRef.current, seg]
      lastSegmentAtRef.current = Date.now()
      setSegments(segsRef.current)
      // 餵 main 的 liveContext:panic(Alt+P)才有「對方問了什麼」的上下文
      void window.api.pushTranscript({ text: seg.text, speaker })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const start = async (): Promise<void> => {
    if (!wantMic && !wantSys) {
      toast.error('請至少選擇一個音訊來源')
      return
    }
    if (settings?.stt.engine === 'local') {
      try {
        await ensureWhisper()
      } catch {
        return
      }
    }
    segsRef.current = []
    setSegments([])
    startedAtRef.current = Date.now()
    setElapsed(0)
    setCoachCounts({})
    // 會話邊界:清上一場的語音上下文與即時回饋冷卻狀態
    await window.api.contextReset()

    try {
      if (wantMic) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
        streamsRef.current.mic = stream
        segmentersRef.current.mic = new AudioSegmenter({
          onSegment: (a, sr) => void transcribeSegment(a, sr, 'me'),
          onLevel: setMicLevel,
          threshold: 0.01
        })
        await segmentersRef.current.mic.start(stream)
      }
      if (wantSys) {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        stream.getVideoTracks().forEach((t) => t.stop()) // 只留音訊
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach((t) => t.stop())
          throw new Error('系統音訊擷取被取消或不可用')
        }
        streamsRef.current.sys = stream
        segmentersRef.current.sys = new AudioSegmenter({
          onSegment: (a, sr) => void transcribeSegment(a, sr, 'them'),
          onLevel: setSysLevel,
          threshold: 0.018
        })
        await segmentersRef.current.sys.start(stream)
      }
      setRecording(true)
    } catch (err) {
      stopAll()
      toast.error(err instanceof Error ? err.message : String(err))
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
    setRecording(false)
    // 最後一段話此刻多半還在 segmenter 的靜音判定窗裡(750ms):
    // flush 送出的轉錄是 async,不等它就存檔會把使用者的最後一句話丟掉。
    // 記住停止當下的數量,等所有在飛轉錄完成(或逾時)再收帳。
    const pendingAtStop = segsRef.current.length
    stopAll()
    await Promise.race([
      (async () => {
        for (let i = 0; i < 40 && segsRef.current.length === pendingAtStop; i++) {
          await new Promise((r) => setTimeout(r, 100))
        }
        // 再給一小段緩衝,若期間又進帳了段落,同樣等它安定
        for (let i = 0; i < 30 && Date.now() - lastSegmentAtRef.current < 800; i++) {
          await new Promise((r) => setTimeout(r, 100))
        }
      })(),
      new Promise((r) => setTimeout(r, 4_000))
    ])
    if (segsRef.current.length > 0) {
      setSaving(true)
      try {
        const startedAt = startedAtRef.current
        const segments = segsRef.current
        // 會話量化報告:與 session 一起存,供 Dashboard 趨勢使用;
        // 併入會議期間的 coaching 觸發計數,形成改進閉環
        const report = buildSessionReport(segments, {
          durationSec: (Date.now() - startedAt) / 1000
        })
        try {
          report.coachingCounts = await window.api.coachingStats()
        } catch {
          // 計數不可得時不影響報告本體
        }
        setLastReport(report)
        await db.sessions.add({
          title: titleRef.current.trim() || `會議 ${formatDateTime(startedAt)}`,
          startedAt,
          endedAt: Date.now(),
          segments,
          report
        })
        await refreshSessions()
      } finally {
        setSaving(false)
      }
    } else {
      // 0 段落停止:不留「看起來存了但其實什麼都沒有」的沉默,給使用者明確回饋
      toast.info('這次沒有偵測到語音,未建立會議紀錄')
    }
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
    await window.api.exportFile({
      defaultName: `${s.title.replace(/[\\/:*?"<>|]/g, '_')}.md`,
      content: lines.join('\n')
    })
  }

  const removeSession = async (id?: number): Promise<void> => {
    if (id == null) return
    // 永久刪除要有確認:與 Scripts 頁刪除講稿同一標準,誤觸即失去逐字稿+報告無法復原
    if (!window.confirm('確定刪除這場會議紀錄嗎？逐字稿與報告將一併移除，無法復原。')) return
    await db.sessions.delete(id)
    await refreshSessions()
  }

  const generateSummary = async (s: MeetingSession): Promise<void> => {
    if (!settings || s.id == null) return
    setAiBusyId(s.id)
    try {
      const transcript = s.segments
        .map((seg) => `[${seg.speaker === 'me' ? '我' : '對方'}] ${seg.text}`)
        .join('\n')
        .slice(-8000)
      const raw = await aiChat(settings, [
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
    } catch (err) {
      toast.error(`AI 摘要失敗:${err instanceof Error ? err.message : String(err)}`)
    } finally {
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

      {/* 控制列 */}
      <div className="card mb-4 flex flex-wrap items-center gap-4 p-4">
        {!recording && (
          <>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={wantMic} onChange={(e) => setWantMic(e.target.checked)} className="accent-accent-500" />
              <Mic size={15} /> 我的麥克風
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm" title="擷取系統播放中的聲音（會議對方、影片等），選擇分享畫面即可">
              <input type="checkbox" checked={wantSys} onChange={(e) => setWantSys(e.target.checked)} className="accent-accent-500" />
              <MonitorSpeaker size={15} /> 系統音訊（對方）
            </label>
            <input
              className="input w-52 text-xs"
              placeholder="會議名稱（可留空）"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button className="btn-primary ml-auto" onClick={start}>
              <Play size={14} /> 開始聆聽
            </button>
          </>
        )}
        {recording && (
          <>
            <span className="flex items-center gap-2 text-sm font-medium text-rose-450">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-450" />
              聆聽中 {formatDuration(elapsed)}
            </span>
            <div className="flex items-center gap-2" title="麥克風音量">
              <Mic size={13} className="text-ink-400" />
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800">
                <div className="h-full bg-emerald-500 transition-[width] duration-100" style={{ width: `${micLevel * 100}%` }} />
              </div>
            </div>
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
              <div key={i} className="flex gap-3">
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
          <div className="mb-3 text-sm font-semibold">會後報告</div>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: '時長', value: formatDuration(lastReport.durationSec) },
              {
                label: '發言佔比',
                value: `${Math.round(lastReport.talkRatio * 100)}%`,
                hint: `我 ${formatDuration(lastReport.mySec)} / 對方 ${formatDuration(lastReport.theirSec)}`
              },
              {
                label: '我的語速',
                value: lastReport.myCpm > 0 ? `${lastReport.myCpm}` : '—',
                hint: lastReport.myCpm > 0 ? '字/分' : undefined
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
                      'mt-0.5 rounded px-1.5 py-0.5 text-[9px] shrink-0',
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
                    className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
                    onClick={() => setExpandedId(expandedId === s.id ? null : (s.id ?? null))}
                  >
                    {expandedId === s.id ? (
                      <ChevronDown size={13} className="shrink-0 text-ink-400" />
                    ) : (
                      <ChevronRight size={13} className="shrink-0 text-ink-400" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm">{s.title}</div>
                      <div className="text-[11px] text-ink-400">
                        {formatDateTime(s.startedAt)} · {s.segments.length} 段 ·{' '}
                        {s.summary ? '已生成摘要' : '未摘要'}
                      </div>
                    </div>
                  </button>
                  <div className="flex shrink-0 gap-1">
                    <button
                      className="btn-ghost text-xs text-accent-300"
                      onClick={() => generateSummary(s)}
                      disabled={aiBusyId !== null}
                    >
                      {aiBusyId === s.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Sparkles size={12} />
                      )}
                      {s.summary ? '重新摘要' : 'AI 摘要'}
                    </button>
                    <button className="btn-ghost text-xs" onClick={() => exportSession(s)}>
                      匯出
                    </button>
                    <button className="btn-ghost text-rose-450" onClick={() => removeSession(s.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {expandedId === s.id && s.summary && (
                  <div className="space-y-3 border-t border-ink-800 bg-ink-850/50 px-5 py-4 text-xs leading-relaxed">
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
