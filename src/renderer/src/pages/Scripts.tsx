import type { JSX } from "react"
import { useEffect, useRef, useState } from 'react'
import { FilePlus2, FolderOpen, Pause, Play, Save, Search, Square, Trash2, Video, X } from 'lucide-react'
import { db } from '../lib/db'
import type { Script } from '@shared/types'
import { cn, formatDateTime, formatDuration } from '../lib/utils'
import { useSettings } from '../lib/store'

function estimateMinutes(content: string, charsPerMin: number): string {
  const chars = content.replace(/\s/g, '').length
  if (chars === 0) return '0 分鐘'
  return `約 ${Math.max(1, Math.round(chars / charsPerMin))} 分鐘（${chars} 字）`
}

export default function Scripts(): JSX.Element {
  const [scripts, setScripts] = useState<Script[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<{ title: string; content: string }>({ title: '', content: '' })
  const [query, setQuery] = useState('')
  const [dirty, setDirty] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { settings } = useSettings()

  const refresh = async (keepId?: number | null): Promise<void> => {
    const list = await db.scripts.orderBy('updatedAt').reverse().toArray()
    setScripts(list)
    if (keepId != null && list.some((s) => s.id === keepId)) {
      setSelectedId(keepId)
    } else if (list.length > 0 && selectedId == null) {
      const first = list[0]
      setSelectedId(first.id ?? null)
      setDraft({ title: first.title, content: first.content })
    }
  }

  useEffect(() => {
    void refresh(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const select = (s: Script): void => {
    if (dirty && !window.confirm('目前講稿有未儲存的修改，確定要切換嗎？')) return
    setSelectedId(s.id ?? null)
    setDraft({ title: s.title, content: s.content })
    setDirty(false)
  }

  const newScript = async (): Promise<void> => {
    if (dirty && !window.confirm('目前講稿有未儲存的修改，確定要捨棄嗎？')) return
    const now = Date.now()
    const id = await db.scripts.add({
      title: '未命名講稿',
      content: '',
      createdAt: now,
      updatedAt: now
    })
    await refresh(id)
    setDraft({ title: '未命名講稿', content: '' })
    setDirty(false)
  }

  const save = async (): Promise<void> => {
    if (selectedId == null) return
    await db.scripts.update(selectedId, {
      title: draft.title.trim() || '未命名講稿',
      content: draft.content,
      updatedAt: Date.now()
    })
    setDirty(false)
    await refresh(selectedId)
  }

  const remove = async (): Promise<void> => {
    if (selectedId == null) return
    if (!window.confirm(`確定刪除「${draft.title}」嗎？此操作無法復原。`)) return
    await db.scripts.delete(selectedId)
    setSelectedId(null)
    setDraft({ title: '', content: '' })
    setDirty(false)
    await refresh(null)
  }

  const importFile = async (file: File): Promise<void> => {
    const text = await file.text()
    if (dirty && !window.confirm('目前講稿有未儲存的修改，匯入會覆蓋，確定嗎？')) return
    setDraft({ title: file.name.replace(/\.(txt|md|markdown)$/i, ''), content: text })
    setDirty(true)
  }

  const launch = async (): Promise<void> => {
    if (selectedId == null || !draft.content.trim()) return
    if (dirty) await save()
    await db.scripts.update(selectedId, { lastUsedAt: Date.now() })
    await window.api.overlayShow({ title: draft.title, content: draft.content })
  }

  // ── 錄影提詞(v3 錄影教練 lite):攝影機+麥克風 MediaRecorder,浮層對錄影隱形 ──
  const [recording, setRecording] = useState(false)
  const [recPaused, setRecPaused] = useState(false)
  const [recSec, setRecSec] = useState(0)
  const [recMsg, setRecMsg] = useState<string | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [preview, setPreview] = useState<{ url: string; path?: string } | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recStreamRef = useRef<MediaStream | null>(null)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recPausedRef = useRef(false)

  const pickMime = (): string => {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || ''
  }

  const beginRecording = async (): Promise<void> => {
    if (selectedId == null || !draft.content.trim()) return
    if (dirty) await save()
    setRecMsg(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      })
      recStreamRef.current = stream
      recChunksRef.current = []
      const mimeType = pickMime()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recChunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        recStreamRef.current?.getTracks().forEach((t) => t.stop())
        recStreamRef.current = null
        const blob = new Blob(recChunksRef.current, { type: mimeType || 'video/webm' })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const res = await window.api.saveRecording({
          bytes,
          defaultName: `提詞錄影-${formatDateTime(Date.now()).replace(/[\/: ]/g, '-')}.webm`
        })
        if (res.ok && res.filePath) {
          setPreview({ url: URL.createObjectURL(blob), path: res.filePath })
          setRecMsg(null)
        } else {
          setRecMsg(`錄影未儲存(${res.error ?? 'canceled'})`)
        }
        setRecording(false)
        setRecPaused(false)
      }
      recorder.start(500)
      recorderRef.current = recorder
      setRecording(true)
      setRecSec(0)
      setRecPaused(false)
      recPausedRef.current = false
      recTimerRef.current = setInterval(() => {
        if (!recPausedRef.current) setRecSec((s) => s + 1)
      }, 1000)
      await db.scripts.update(selectedId, { lastUsedAt: Date.now() })
      await window.api.overlayShow({ title: draft.title, content: draft.content })
    } catch (err) {
      recStreamRef.current?.getTracks().forEach((t) => t.stop())
      recStreamRef.current = null
      setRecMsg(`無法開啟攝影機:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 倒數 3-2-1 後開錄;使用者可勾選不再顯示(localStorage) */
  const startRecLaunch = async (): Promise<void> => {
    if (selectedId == null || !draft.content.trim()) return
    if (localStorage.getItem('rec-countdown-off') === '1') {
      void beginRecording()
      return
    }
    for (const n of [3, 2, 1]) {
      setCountdown(n)
      await new Promise((r) => setTimeout(r, 800))
    }
    setCountdown(null)
    void beginRecording()
  }

  const toggleRecPause = (): void => {
    const rec = recorderRef.current
    if (!rec) return
    if (rec.state === 'recording') {
      rec.pause()
      recPausedRef.current = true
      setRecPaused(true)
    } else if (rec.state === 'paused') {
      rec.resume()
      recPausedRef.current = false
      setRecPaused(false)
    }
  }

  const stopRec = (): void => {
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
    recorderRef.current?.stop()
    recorderRef.current = null
  }

  const filtered = scripts.filter(
    (s) => s.title.toLowerCase().includes(query.toLowerCase()) || s.content.includes(query)
  )

  return (
    <div className="flex h-full">
      {/* 講稿列表 */}
      <div className="flex w-72 shrink-0 flex-col border-r border-ink-800 bg-ink-900/60">
        <div className="space-y-2.5 p-4">
          <div className="flex gap-2">
            <button className="btn-outline flex-1 text-xs" onClick={newScript}>
              <FilePlus2 size={14} /> 新講稿
            </button>
            <button
              className="btn-outline text-xs"
              title="匯入 .txt / .md"
              onClick={() => fileInputRef.current?.click()}
            >
              <FolderOpen size={14} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.markdown,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importFile(f)
                e.target.value = ''
              }}
            />
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-2.5 text-ink-400" />
            <input
              className="input pl-8 text-xs"
              placeholder="搜尋講稿…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-ink-400">
              {scripts.length === 0 ? '尚未建立講稿' : '沒有符合的講稿'}
            </div>
          )}
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => select(s)}
              className={cn(
                'mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer',
                s.id === selectedId ? 'bg-ink-800' : 'hover:bg-ink-850'
              )}
            >
              <div className="truncate text-sm font-medium">{s.title}</div>
              <div className="mt-0.5 truncate text-[11px] text-ink-400">
                {s.content ? s.content.slice(0, 40) : '（空白）'} ·{' '}
                {formatDateTime(s.updatedAt)}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 編輯器 */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {/* 錄影倒數 */}
        {countdown !== null && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-ink-950/80 backdrop-blur-sm">
            <div key={countdown} className="anim-rise text-7xl font-bold text-accent-300">{countdown}</div>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-400">
              <input
                type="checkbox"
                className="accent-accent-500"
                onChange={(e) => {
                  if (e.target.checked) localStorage.setItem('rec-countdown-off', '1')
                }}
              />
              這次之後不再顯示倒數
            </label>
          </div>
        )}
        {/* 錄影預覽 modal */}
        {preview && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink-950/85 p-6 backdrop-blur-sm">
            <div className="glass anim-rise w-full max-w-2xl rounded-2xl p-4">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="text-sm font-semibold">錄影完成</span>
                <span className="flex-1 truncate text-[11px] text-ink-400">{preview.path}</span>
                <button
                  className="text-ink-400 hover:text-white cursor-pointer"
                  onClick={() => {
                    URL.revokeObjectURL(preview.url)
                    setPreview(null)
                  }}
                >
                  <X size={15} />
                </button>
              </div>
              <video src={preview.url} controls autoPlay className="w-full rounded-xl border border-white/10" />
              <div className="mt-3 flex gap-2">
                <button
                  className="btn-primary text-xs"
                  onClick={() => preview.path && void window.api.revealPath(preview.path)}
                >
                  <FolderOpen size={13} /> 開啟所在資料夾
                </button>
                <button
                  className="btn-outline text-xs"
                  onClick={() => {
                    URL.revokeObjectURL(preview.url)
                    setPreview(null)
                  }}
                >
                  關閉
                </button>
              </div>
            </div>
          </div>
        )}
        {selectedId == null ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-ink-400">
            <span>選擇或建立一份講稿</span>
            <button className="btn-primary text-xs" onClick={() => void newScript()}>
              <FilePlus2 size={14} /> 建立第一份講稿
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-ink-800 px-6 py-3.5">
              <input
                className="flex-1 bg-transparent text-lg font-semibold outline-none placeholder:text-ink-400"
                placeholder="講稿標題"
                value={draft.title}
                onChange={(e) => {
                  setDraft({ ...draft, title: e.target.value })
                  setDirty(true)
                }}
              />
              <span className="text-[11px] text-ink-400">
                {estimateMinutes(draft.content, settings?.personal.profile?.charsPerMin ?? 240)}
              </span>
              <button className="btn-ghost text-rose-450 hover:text-rose-450" onClick={remove}>
                <Trash2 size={15} />
              </button>
              <button className="btn-outline text-xs" onClick={save} disabled={!dirty}>
                <Save size={14} /> {dirty ? '儲存' : '已儲存'}
              </button>
              <button className="btn-primary text-xs" onClick={launch}>
                <Play size={14} /> 開始提詞
              </button>
              {recording ? (
                <>
                  <button
                    className="btn-outline text-xs"
                    onClick={toggleRecPause}
                    title={recPaused ? '續錄' : '暫停(計時凍結)'}
                  >
                    {recPaused ? <Play size={14} /> : <Pause size={14} />}
                  </button>
                  <button className="btn-outline text-xs text-rose-450" onClick={stopRec}>
                    <span className="h-2 w-2 animate-pulse rounded-full bg-rose-450" />
                    {recPaused ? '已暫停' : '停止錄影'} {formatDuration(recSec)}
                  </button>
                </>
              ) : (
                <button
                  className="btn-outline text-xs"
                  title="開啟攝影機錄下你的演出;浮層對錄影隱形,建議搭配浮層的貼鏡模式"
                  onClick={() => void startRecLaunch()}
                  disabled={!draft.content.trim()}
                >
                  <Video size={14} /> 錄影提詞
                </button>
              )}
            </div>
            <textarea
              className="flex-1 resize-none bg-transparent px-6 py-5 text-[15px] leading-relaxed text-ink-100 outline-none"
              placeholder={'在這裡貼上或輸入講稿…\n\n支援從 .txt / .md 匯入。空行會作為段落分隔。'}
              value={draft.content}
              onChange={(e) => {
                setDraft({ ...draft, content: e.target.value })
                setDirty(true)
              }}
            />
            {settings && (
              <div className="flex items-center gap-3 border-t border-ink-800 px-6 py-2.5 text-[11px] text-ink-400">
                <span>
                  浮層將以 {settings.overlay.fontSize}px、速度 {settings.overlay.speed} px/s 滾動 ·
                  於「設定」頁調整
                </span>
                {recMsg && <span className="truncate text-accent-300">{recMsg}</span>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
