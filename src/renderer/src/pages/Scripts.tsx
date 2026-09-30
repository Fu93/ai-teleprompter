import type { JSX } from "react"
import { useEffect, useRef, useState } from 'react'
import { FilePlus2, FolderOpen, Pause, Play, Save, Search, Square, Trash2, Video, X } from 'lucide-react'
import { db } from '../lib/db'
import type { Script } from '@shared/types'
import { cn, formatDateTime, formatDuration } from '../lib/utils'
import { toast } from '../lib/toast'
import { describeError } from '../lib/describeError'
import { useSettings } from '../lib/store'
import { registerAuditControl } from '../lib/auditBridge'
import { confirmDialog } from '../lib/confirm'
import { useCloseGuard } from '../lib/closeGuard'

function estimateMinutes(content: string, charsPerMin: number): string {
  const chars = content.replace(/\s/g, '').length
  if (chars === 0) return '0 分鐘'
  return `約 ${Math.max(1, Math.round(chars / charsPerMin))} 分鐘（${chars} 字）`
}

export default function Scripts({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}): JSX.Element {
  const [scripts, setScripts] = useState<Script[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<{ title: string; content: string }>({ title: '', content: '' })
  const [query, setQuery] = useState('')
  const [dirty, setDirty] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 未存變更狀態上報給 App:側欄切頁前的防呆要看到這個旗標
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  // 關閉視窗時的守衛。側欄切頁有阻擋,關窗沒有,而關窗損失更徹底。
  useCloseGuard(
    'scripts-dirty',
    dirty ? `「${draft.title || '未命名講稿'}」有未儲存的修改。` : null
  )

  // 稽核用:直接選取第 N 篇講稿。不經 UI 點擊,因為「選取後畫面沒變」
  // 無法區分「狀態沒到達」與「狀態本來就長這樣」(第一份稿會被自動選取)。
  useEffect(
    () =>
      registerAuditControl('scripts.selectIndex', (arg) => {
        const i = Number(arg)
        const target = scripts[i]
        if (!target) return false
        setSelectedId(target.id ?? null)
        return true
      }),
    [scripts]
  )

  // unmount 清理:錄影中切頁要收掉計時器、錄音器與攝影機/麥克風 track;
  // recorder.onstop 會在離頁後觸發,此時 mainWindow 還在所以 saveRecording 對話框仍會跳出——
  // 這比資料無聲消失好,但不該讓攝影機燈在背景亮著
  useEffect(() => {
    return () => {
      if (recTimerRef.current) {
        clearInterval(recTimerRef.current)
        recTimerRef.current = null
      }
      recorderRef.current?.stop()
      recStreamRef.current?.getTracks().forEach((t) => t.stop())
      recStreamRef.current = null
    }
  }, [])
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

  /** 未存變更的共用確認:稿子有三個入口會把它丢掉,文案要一致 */
  const confirmDiscard = (body: string, confirmLabel: string): Promise<boolean> =>
    confirmDialog({ title: '講稿有未儲存的修改', body, confirmLabel })

  /**
   * 確保「目前有一份正在編輯的講稿」,沒有就建立一份並選取它。
   *
   * 為什麼匯入需要這個:編輯器只在 selectedId != null 時渲染。全新使用者
   * (或剛刪光講稿的人)沒有任何選取,而原本的 importFile 只 setDraft + setDirty ——
   * 內容被寫進一個永遠不會顯示的 state:使用者選了檔案、畫面毫無變化,內容其實
   * 已經丢了;更糟的是 dirty 變成 true,之後切頁或關窗會為一份他根本看不到的
   * 內容跳「有未儲存的修改」。先讓內容有地方落腳,守衛才不會守一個幽靈。
   */
  const ensureTarget = async (title: string): Promise<void> => {
    if (selectedId != null) return
    const now = Date.now()
    const id = await db.scripts.add({ title, content: '', createdAt: now, updatedAt: now })
    await refresh(id)
  }

  const select = async (s: Script): Promise<void> => {
    if (dirty && !(await confirmDiscard('切換到其他講稿會遺失目前的修改。', '放棄變更並切換'))) return
    setSelectedId(s.id ?? null)
    setDraft({ title: s.title, content: s.content })
    setDirty(false)
  }

  const newScript = async (): Promise<void> => {
    if (dirty && !(await confirmDiscard('建立新講稿會遺失目前的修改。', '放棄變更並新增'))) return
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

  const save = async (): Promise<boolean> => {
    if (selectedId == null) return false
    try {
      await db.scripts.update(selectedId, {
        title: draft.title.trim() || '未命名講稿',
        content: draft.content,
        updatedAt: Date.now()
      })
    } catch (err) {
      // 寫入失敗(磁碟滿/隱私模式等)要有聲:保持 dirty 讓使用者重試,而不是看著「已儲存」以為存好了
      toast.error(`儲存失敗。${describeError(err)}`)
      return false
    }
    setDirty(false)
    await refresh(selectedId)
    return true
  }

  const remove = async (): Promise<void> => {
    if (selectedId == null) return
    if (
      !(await confirmDialog({
        title: `刪除「${draft.title || '未命名講稿'}」？`,
        body: '這份講稿的內容會一併移除，無法復原。',
        confirmLabel: '刪除講稿',
        variant: 'danger'
      }))
    )
      return
    await db.scripts.delete(selectedId)
    setSelectedId(null)
    setDraft({ title: '', content: '' })
    toast.success('講稿已刪除')
    setDirty(false)
    await refresh(null)
  }

  const importFile = async (file: File): Promise<void> => {
    const text = await file.text()
    if (dirty && !(await confirmDiscard('匯入的內容會覆蓋目前的修改。', '放棄變更並匯入'))) return
    const title = file.name.replace(/\.(txt|md|markdown)$/i, '') || '未命名講稿'
    // 先確定有編輯目標,否則下面的 setDraft 會被寫進不渲染的 state(見 ensureTarget)
    await ensureTarget(title)
    setDraft({ title, content: text })
    setDirty(true)
  }

  const launch = async (): Promise<void> => {
    if (selectedId == null || !draft.content.trim()) return
    // 儲存失敗就停:浮層若照開,使用者看到的是舊稿,比不開更糟
    if (dirty && !(await save())) return
    await db.scripts.update(selectedId, { lastUsedAt: Date.now() })
    await window.api.overlayShow({ title: draft.title, content: draft.content })
  }

  // ── 錄影提詞(v3 錄影教練 lite):攝影機+麥克風 MediaRecorder,浮層對錄影隱形 ──
  const [recording, setRecording] = useState(false)
  const [recPaused, setRecPaused] = useState(false)
  const [recSec, setRecSec] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [preview, setPreview] = useState<{ url: string; path?: string } | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recStreamRef = useRef<MediaStream | null>(null)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recPausedRef = useRef(false)

  // 錄影預覽的 blob URL:關閉按鈕有 revoke,但直接切頁(unmount)也要收,
  // 否則影片 blob 留在記憶體直到 app 結束
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url)
    }
    // 卸載時收當下這筆;平時由關閉按鈕負責
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickMime = (): string => {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || ''
  }

  const beginRecording = async (): Promise<void> => {
    if (selectedId == null || !draft.content.trim()) return
    if (dirty && !(await save())) return
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
          toast.success('錄影已儲存')
        } else {
          toast.error(`錄影未儲存(${res.error ?? 'canceled'})`)
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
      toast.error(`無法開啟攝影機。${describeError(err)}`)
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

  // 標題與內容統一不分大小寫(原本標題忽略大小寫、內容分,搜尋行為不可預期)
  const q = query.toLowerCase()
  const filtered = scripts.filter(
    (s) => s.title.toLowerCase().includes(q) || s.content.toLowerCase().includes(q)
  )

  return (
    <div className="flex h-full">
      {/* 講稿列表 */}
      <div className="flex w-72 shrink-0 flex-col border-r border-ink-800 bg-ink-900/60">
        <div className="space-y-2.5 p-4">
          <div className="flex gap-2">
            <button className="btn-outline flex-1 text-xs" onClick={() => void newScript()}>
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
              aria-label="搜尋講稿"
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
              onClick={() => void select(s)}
              className={cn(
                'mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer',
                s.id === selectedId ? 'bg-ink-800' : 'hover:bg-ink-850'
              )}
            >
              {/* 列表欄位只有 247px 寬,長標題一定會被 truncate 截斷。
                  給 title 讓滑鼠停留能看到全文,否則使用者只會看到半句話。*/}
              <div className="truncate text-sm font-medium" title={s.title}>
                {s.title}
              </div>
              <div
                className="mt-0.5 truncate text-[11px] text-ink-400"
                title={s.content ? s.content.slice(0, 40) : '（空白）'}
              >
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
            {/* 標題列。視窗最小寬度 960px 時,編輯區只剩 464px,這個列同時要
                裝下標題輸入 + 預估時長 + 刪除 + 儲存 + 開始提詞 + 錄影提詞。
                原本是單行不換行,而且每個子項都是 flex-shrink:1 / min-width:auto:
                flex-1 的輸入框不肯縮到比內容更小,於是所有按鈕被壓成逐字換行的
                直條(「開始提詞」變成 64x96),最後一顆還整顆溢出容器 46px 而點不到。
                flex-wrap 讓窄視窗時整組按鈕落到第二行,shrink-0 讓按鈕維持應有大小。*/}
            <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-6 py-3.5">
              <input
                className="min-w-[12rem] flex-1 bg-transparent text-lg font-semibold outline-none placeholder:text-ink-400"
                placeholder="講稿標題"
                value={draft.title}
                onChange={(e) => {
                  setDraft({ ...draft, title: e.target.value })
                  setDirty(true)
                }}
              />
              <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-400">
                {estimateMinutes(draft.content, settings?.personal.profile?.charsPerMin ?? 240)}
              </span>
              <button className="btn-ghost shrink-0 text-rose-450 hover:text-rose-450" onClick={remove} title="刪除這份講稿">
                <Trash2 size={15} />
              </button>
              <button className="btn-outline shrink-0 text-xs" onClick={save} disabled={!dirty}>
                <Save size={14} /> {dirty ? '儲存' : '已儲存'}
              </button>
              <button
                className="btn-primary shrink-0 text-xs"
                onClick={launch}
                disabled={!draft.content.trim()}
                title={draft.content.trim() ? undefined : '先輸入講稿內容再開始提詞'}
              >
                <Play size={14} /> 開始提詞
              </button>
              {recording ? (
                <>
                  <button
                    className="btn-outline shrink-0 text-xs"
                    onClick={toggleRecPause}
                    title={recPaused ? '續錄' : '暫停(計時凍結)'}
                  >
                    {recPaused ? <Play size={14} /> : <Pause size={14} />}
                  </button>
                  <button className="btn-outline shrink-0 text-xs text-rose-450" onClick={stopRec}>
                    <span className="h-2 w-2 animate-pulse rounded-full bg-rose-450" />
                    {recPaused ? '已暫停' : '停止錄影'} {formatDuration(recSec)}
                  </button>
                </>
              ) : (
                <button
                  className="btn-outline shrink-0 text-xs"
                  title="開啟攝影機錄下你的演出;浮層對錄影隱形,建議搭配浮層的貼鏡模式"
                  onClick={() => void startRecLaunch()}
                  disabled={!draft.content.trim()}
                >
                  <Video size={14} /> 錄影提詞
                </button>
              )}
            </div>
            <textarea
              // 這是編輯講稿的主要控制項,沒有無障礙名稱時螢幕閱讀器只會報「文字區塊」。
              // placeholder 會隨內容消失,不能當名稱用(這也是 no-accessible-name
              // 判定 placeholder 不足的原因);title 才有機會在內容非空時仍然可讀。
              aria-label={`講稿內容${draft.title ? `：${draft.title}` : ''}`}
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
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
