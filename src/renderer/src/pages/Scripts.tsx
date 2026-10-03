import type { JSX } from "react"
import { useEffect, useRef, useState } from 'react'
import { FilePlus2, FolderOpen, Pause, Play, Save, Search, Sparkles, Trash2, Video, X } from 'lucide-react'
import { db } from '../lib/db'
import type { Script } from '@shared/types'
import { cn, formatClock, formatDateTime, formatDuration, normalizeScriptTitle } from '../lib/utils'
import { AUTOSAVE_DELAY_MS, createAutosave } from '../lib/autoSave'
import { toast } from '../lib/toast'
import { describeError } from '../lib/describeError'
import { DEMO_SCRIPT_CONTENT, DEMO_SCRIPT_TITLE } from '../lib/demoScript'
import { markPromptSucceeded } from '../lib/onboarding'
import { useSettings } from '../lib/store'
import { registerAuditControl } from '../lib/auditBridge'
import { confirmDialog } from '../lib/confirm'
import { useCloseGuard } from '../lib/closeGuard'
import { setCaptureIndicator } from '../lib/captureIndicator'
import { unlinkScriptFromSessions } from '../lib/sessionToScript'
import { describeImportTooLarge } from '../lib/scriptImport'

function estimateMinutes(content: string, charsPerMin: number): string {
  const chars = content.replace(/\s/g, '').length
  if (chars === 0) return '0 分鐘'
  return `約 ${Math.max(1, Math.round(chars / charsPerMin))} 分鐘（${chars} 字）`
}

export default function Scripts({
  onDirtyChange,
  onGuardChange
}: { onDirtyChange?: (dirty: boolean) => void; onGuardChange?: (msg: string | null) => void } = {}): JSX.Element {
  const [scripts, setScripts] = useState<Script[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<{ title: string; content: string }>({ title: '', content: '' })
  const [query, setQuery] = useState('')
  const [dirty, setDirty] = useState(false)
  /** 最近一次寫入的時間戳;只在「已儲存」提示需要暫時顯示時才用到 */
  /**
   * 最近一次**寫入磁碟**的時間。用途只有一個:讓自動存檔看得見。
   *
   * 為什麼需要:自動存檔設計上完全無感(不跳 toast、不動清單)。但「無感」
   * 和「不存在」在使用者看起來是一樣的 —— 他只能靠「關掉 App 再打開,
   * 剛打的字還在」來確認自己其實一直在被保護。顯示「已儲存 14:32」就是把
   * 這個確認從一個小實驗變成一眼可見的事實。
   */
  const [savedAt, setSavedAt] = useState<number | null>(null)

  /**
   * 自動存檔的接線。
   *
   * 為什麼是 ref 而不是直接 `useEffect(..., [dirty])`:自動存檔的計時器必須
   * 在**整個元件生命週期**是同一個實例,切換選取時取消、卸載時取消。而
   * persistQuietly 每次 render 都是新的閉包,所以計時器呼叫的是
   * `persistQuietlyRef.current` —— 永遠拿到當下最新的那一版,不會存到舊稿。
   */
  const persistQuietlyRef = useRef<(() => Promise<boolean>) | null>(null)
  const autosaveRef = useRef<ReturnType<typeof createAutosave> | null>(null)
  if (autosaveRef.current === null) {
    autosaveRef.current = createAutosave(AUTOSAVE_DELAY_MS, () => {
      void persistQuietlyRef.current?.()
    })
  }
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 每次 render 更新一次:計時器到點時呼叫的一定是當下的閉包
  useEffect(() => {
    persistQuietlyRef.current = persistQuietly
  })

  // 切換選取時取消 —— 還沒落地的寫入屬於**剛才那份稿**,帶到新稿上是錯的。
  // savedAt 同理:那是**上一份稿**的寫入時間,留在按鈕上會說謊。
  useEffect(() => {
    autosaveRef.current?.cancel()
    setSavedAt(null)
  }, [selectedId])

  // 卸載時取消。反過來說:**切換頁面不會取消**,使用者打了字還沒停手就離開,
  // 那一次寫入仍然必須發生 —— 否則離開這一頁就等於回到沒有自動存檔的世界。
  useEffect(() => () => autosaveRef.current?.cancel(), [])

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
        // 編輯器渲染的是 draft,不是 selectedId 對應的稿 —— 只設 id 的話,
        // 清單高亮與編輯器內容會各講各的(目檢截圖量到的不一致)。
        setDraft({ title: target.title, content: target.content })
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
      countdownAttemptRef.current += 1
      countdownRunningRef.current = false
      recordingAttemptRef.current += 1
      recordingStartRef.current = false
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // Ignore a device teardown race; tracks are stopped below regardless.
        }
      }
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

  /**
   * 存檔後同步浮層。盡力而為:同步失敗**不能**讓存檔看起來失敗 ——
   * 稿子確實存好了,而浮層多半根本沒開著。失敗只寫日誌。
   */
  const syncOverlayScript = (scriptId: number, title: string, content: string): void => {
    void window.api
      .overlaySync({ scriptId, title, content })
      .catch((err: unknown) => {
        void window.api.logFromRenderer(
          'WARN',
          `浮層同步失敗:${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  /**
   * 安靜寫入:只把內容落盤。
   *
   * 為什麼不能直接呼叫 save():它會 (a) 重新載入整個講稿清單,(b) 把內容推給
   * 浮層。自動存檔每 1.5 秒就會跑一次 —— 那會讓使用者停止打字後清單閃一下,
   * 讓**正在用浮層講話**的他講的稿跟著游標跳動。自動存檔必須是無感的。
   *
   * 失敗時**不**靜默:使用者會以為存好了,實際上沒有。但也**不**跳紅色 toast
   * —— 使用者只是打了一段字,不是執行了一個動作。留 dirty 讓他在關窗時還被問,
   * 並寫進診斷日誌。
   */
  const persistQuietly = async (): Promise<boolean> => {
    if (selectedId == null || !dirty) return false
    const storedTitle = normalizeScriptTitle(draft.title)
    try {
      await db.scripts.update(selectedId, {
        title: storedTitle,
        content: draft.content,
        updatedAt: Date.now()
      })
    } catch (err) {
      void window.api
        .logFromRenderer('WARN', `講稿自動儲存失敗:${err instanceof Error ? err.message : String(err)}`)
        .catch(() => undefined)
      return false
    }
    // 只改 dirty,不動 draft —— 任何寫回受控欄位的動作都可能截斷原生 Ctrl+Z 的堆疊。
    setDirty(false)
    setSavedAt(Date.now())
    return true
  }

  const save = async (): Promise<boolean> => {
    if (selectedId == null) return false
    // 存進 DB 的標題是「trim 後空則回填未命名講稿」;編輯器要跟著對齊,
    // 否則清單顯示「未命名講稿」而輸入框仍是空的,兩邊各講各的
    const storedTitle = normalizeScriptTitle(draft.title)
    try {
      await db.scripts.update(selectedId, {
        title: storedTitle,
        content: draft.content,
        updatedAt: Date.now()
      })
    } catch (err) {
      // 寫入失敗(磁碟滿/隱私模式等)要有聲:保持 dirty 讓使用者重試,而不是看著「已儲存」以為存好了
      toast.error(`儲存失敗。${describeError(err)}`)
      return false
    }
    setDirty(false)
    setSavedAt(Date.now())
    if (draft.title !== storedTitle) setDraft((d) => ({ ...d, title: storedTitle }))
    await refresh(selectedId)
    // 浮層正在講同一份稿時把它換成剛存的內容(規則見 shared/overlayScript.ts)。
    // 這是「改一句稿 → 立刻上台」的主流程:沒有這一步,上台講的是舊版。
    syncOverlayScript(selectedId, storedTitle, draft.content)
    return true
  }

  /**
   * Ctrl/Cmd+S 立即儲存。
   *
   * 為什麼值得加:這是所有文字編輯器共有的肌肉記憶,沒有它的話使用者第一次
   * 按下去什麼事都沒發生 —— 然後他會以為「這個 App 不吃 Ctrl+S」,而實際上
   * 是我們沒接。用 Cmd+S 一起處理是因為同一份程式碼在 mac 上也該成立。
   *
   * 走完整的 save() 而不是 persistQuietly:按鍵是明確的「存」,應該連動清單
   * 與浮層,和按那顆按鈕完全一樣。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() !== 's') return
      e.preventDefault()
      void save()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const remove = async (): Promise<void> => {
    if (selectedId == null) return
    let unlinked = 0
    if (
      !(await confirmDialog({
        title: `刪除「${draft.title || '未命名講稿'}」？`,
        body: '這份講稿的內容會一併移除，無法復原。',
        confirmLabel: '刪除講稿',
        variant: 'danger'
      }))
    )
      return
    await db.transaction('rw', [db.scripts, db.sessions], async () => {
      await db.scripts.delete(selectedId)
      // 指向它的 session 參照必須同時清掉:留著會讓「錄音轉錄」頁那顆按鈕
      // 永遠停在 disabled 的「已存成講稿」,使用者再也存不成這份逐字稿。
      unlinked = await unlinkScriptFromSessions(selectedId)
    })
    setSelectedId(null)
    setDraft({ title: '', content: '' })
    toast.success(
      unlinked > 0
        ? `講稿已刪除(該場會議的逐字稿現在可以重新存成講稿)`
        : '講稿已刪除'
    )
    setDirty(false)
    await refresh(null)
  }

  const importFile = async (file: File): Promise<void> => {
    // 先擋大小再讀內容:file.text() 會把整份檔案變成字串,選到影片或資料備份
    // 時就是直接吃光 renderer 的記憶體,而且畫面上什麼都不會說(見 scriptImport.ts)。
    const tooLarge = describeImportTooLarge(file.size)
    if (tooLarge) {
      toast.error(tooLarge)
      return
    }
    const text = await file.text()
    if (dirty && !(await confirmDiscard('匯入的內容會覆蓋目前的修改。', '放棄變更並匯入'))) return
    const title = file.name.replace(/\.(txt|md|markdown)$/i, '') || '未命名講稿'
    // 先確定有編輯目標,否則下面的 setDraft 會被寫進不渲染的 state(見 ensureTarget)
    await ensureTarget(title)
    setDraft({ title, content: text })
    setDirty(true)
    // 匯入的檔案可能很大,使用者匯入後不會停下來把內容重新打一遍,
    // 但他可能立刻去做別的事 —— 這裡不排自動存檔,匯入就等於白做。
    autosaveRef.current?.schedule()
  }

  const launch = async (): Promise<void> => {
    if (selectedId == null || !draft.content.trim()) return
    // 儲存失敗就停:浮層若照開,使用者看到的是舊稿,比不開更糟
    if (dirty && !(await save())) return
    await db.scripts.update(selectedId, { lastUsedAt: Date.now() })
    await window.api.overlayShow({
      scriptId: selectedId,
      title: normalizeScriptTitle(draft.title),
      content: draft.content
    })
    // 「第一段提詞」的里程碑要在這裡也寫。原本只有總覽頁那條路寫,
    // 於是從講稿頁按下開始提詞的人回總覽頁會看到 3 分鐘上手停在 2/3 ——
    // 而那一頁的說明正是「先寫一段講稿,再按開始提詞」,也就是他剛剛做過的事。
    markPromptSucceeded()
  }

  /**
   * 首用入口(與總覽頁同一顆钮):建立內建範例稿 → 存起來 → 直接開浮層。
   *
   * 為什麼需要它:浮層需要「有內容的講稿」才會出現,所以全新使用者必須先
   * 自己想出一段稿子才看得到這個產品的門面。這一顆钮把那個門檻拿掉。
   * 建立的是一份**真的、可以編輯的講稿**(不是唯讀 demo)—— 使用者第一眼
   * 看到的浮層就是他等一下要用的那份稿,而不是另一種東西。
   */
  const loadDemo = async (): Promise<void> => {
    const now = Date.now()
    const id = await db.scripts.add({
      title: DEMO_SCRIPT_TITLE,
      content: DEMO_SCRIPT_CONTENT,
      createdAt: now,
      updatedAt: now
    })
    await refresh(id)
    setSelectedId(id)
    setDraft({ title: DEMO_SCRIPT_TITLE, content: DEMO_SCRIPT_CONTENT })
    // 這一顆只會出現在「沒有選取任何講稿」的空狀態,所以沒有未存變更要守。
    setDirty(false)
    await db.scripts.update(id, { lastUsedAt: Date.now() })
    await window.api.overlayShow({
      scriptId: id,
      title: DEMO_SCRIPT_TITLE,
      content: DEMO_SCRIPT_CONTENT
    })
    markPromptSucceeded()
    toast.info('已建立範例講稿 —— 它是真的稿子,可以直接改成你自己的內容。')
  }

  // ── 錄影提詞(v3 錄影教練 lite):攝影機+麥克風 MediaRecorder,浮層對錄影隱形 ──
  const [recording, setRecording] = useState(false)
  const [recPaused, setRecPaused] = useState(false)
  const [recSec, setRecSec] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [preview, setPreview] = useState<{
    url: string
    path?: string
    /** 檔案落在可服務的根目錄內 → 可以在 App 內播放;否則降級為只給路徑 */
    playable: boolean
    /** 只有稽核強制的預覽是真 Blob URL(需要 revoke) */
    isBlob: boolean
  } | null>(null)
  /**
   * 上次錄影中斷留下的未完成檔(進程在錄影中死掉時分片已經寫到磁碟)。
   *
   * 沒有這個提示的話,分片落盤只是把「資料不見」換成「資料在一個使用者
   * 永遠不會去的暫存目錄裡」—— 那不是修好,那是把損失延後。
   */
  const [orphans, setOrphans] = useState<Array<{ path: string; bytes: number }>>([])

  useEffect(() => {
    void window.api.videoRecordingOrphans().then(setOrphans).catch(() => setOrphans([]))
  }, [])

  const resolveOrphans = async (mode: 'keep' | 'discard'): Promise<void> => {
    const res = await window.api.videoRecordingResolveOrphans({ mode })
    if (!res.ok) {
      toast.error(`處理未完成錄影失敗。${res.error ?? '未知錯誤'}`)
      return
    }
    setOrphans([])
    if (mode === 'keep') toast.success(`已把 ${res.moved ?? 0} 段未完成的錄影放到「影片/AI 提詞機」`)
    else toast.info('已清除未完成的錄影暫存檔')
  }
  const recorderRef = useRef<MediaRecorder | null>(null)
  /**
   * 分片的送達順序。
   *
   * MediaRecorder 每 500ms 丟一片,而 `ipcRenderer.invoke` 是並行的 —— 不串接
   * 的話後一片可能先落地,WebM 就會壞掉(它只有第一片帶 header,後續片的順序
   * 必須與錄製順序一致)。所以這裡用一條 promise 鏈把每一片排在前一片後面。
   *
   * 也正因為分片是**直接寫到磁碟**(見 main/videoRecording.ts),renderer
   * 手上不再留副本:舊版攢在 recChunksRef 裡、停止時一次性過 IPC 的做法,
   * 等於把整段錄影的存亡押在一次幾百 MB 的複製上。
   */
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve())
  /** 第一片送達失敗(磁碟滿/唯讀)時記下原因;onstop 讀它決定要不要報錯 */
  const chunkErrorRef = useRef<string | null>(null)
  /** 退出流程呼叫 flush 時設起:只收尾,不彈存檔對話框(關機時沒人能回答) */
  const quittingRef = useRef(false)
  const recStreamRef = useRef<MediaStream | null>(null)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recPausedRef = useRef(false)
  const countdownAttemptRef = useRef(0)
  const countdownRunningRef = useRef(false)
  const recordingAttemptRef = useRef(0)
  const recordingStartRef = useRef(false)

  /**
   * 稽核用:強制開啟錄影預覽 modal。
   *
   * 這個 modal 裡有兩個東西從未被量過:一個 `truncate` 的完整檔案路徑
   * （截斷後沒有替代文字 = 使用者不知道錄影存在哪）和一個只有圖示的
   * 關閉鈕（沒有 aria-label、沒有 title,也沒有 28px 命中區）。
   * 觸發條件是 MediaRecorder 錄完,headless 不可能真的錄一段。
   */
  useEffect(
    () =>
      registerAuditControl('scripts.preview', (arg) => {
        setPreview({
          url: URL.createObjectURL(new Blob([], { type: 'video/webm' })),
          path:
            typeof arg === 'string'
              ? arg
              : 'C:\\Users\\user\\Videos\\Freebuff\\錄影\\2026-09-30-自我介紹-第二版-take3.webm',
          playable: true,
          isBlob: true
        })
        return true
      }),
    []
  )

  // 錄影預覽的來源現在是 `app://rec/<檔名>`(檔案已經在磁碟上),不是 Blob URL:
  // 分片落盤之後 renderer 手上沒有 bytes,把它讀回來會把這一輪剛拆掉的
  // 「一次性幾百 MB 複製」原封不動裝回去。isBlob 只給稽核強制預覽用,由它自己收。
  useEffect(() => {
    return () => {
      if (preview?.isBlob) URL.revokeObjectURL(preview.url)
    }
    // 卸載時收當下這筆;平時由關閉按鈕負責
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 錄影中的環境指示(見 lib/captureIndicator.ts):
  // 錄影提詞會把攝影機+麥克風開著數分鐘到數小時,最小化後「還在錄」原本不可見。
  useEffect(() => {
    setCaptureIndicator('scripts-rec', recording ? '● 錄影中 — AI 提詞機' : null)
  }, [recording])
  // 離頁必還原(unmount 清理雖然會停掉錄影,但那時 recording state 已不更新)
  useEffect(() => () => setCaptureIndicator('scripts-rec', null), [])

  /**
   * 關閉視窗的守衛(錄影那條)。
   *
   * 為什麼要有第二個 useCloseGuard 而不是把訊息掛到 'scripts-dirty' 上:
   * closeGuard 是 `Map<name, fn>`,本來就支援多個守衛併存,而這兩件事的
   * 「解決辦法」不同 —— 未存變更是「去按儲存」,錄影中是「去按停止錄影」。
   * 混成一句的話,使用者會在一個只提到儲存的對話框裡被告知要停止錄影。
   *
   * 這一輪之前錄影**一道守衛都沒有**(只有 dirty):按 X → 主視窗銷毀 →
   * renderer 跟著死 → recorder.onstop 根本不跑 → 存檔對話框不出現 →
   * 整段錄影無聲消失。對照錄音頁:closeGuard + 側欄離頁守衛 + 退出前 flush
   * 三道俱全。兩種媒體的容錯標準不該差一整級。
   */
  useCloseGuard(
    'scripts-recording',
    recording ? '正在錄影。請先按「停止錄影」再關閉,否則這段影片不會留下任何檔案。' : null
  )

  /**
   * 側欄切頁的守衛。沒有它,錄影中點「總覽」會讓 unmount 直接 recorder.stop(),
   * 使用者只是想看一下別的頁,卻被丟一個存檔對話框 —— 而且錄影已經結束了。
   * 訊息由頁面上報、App.navigate 攔下確認(與 Record / Practice 同一模式)。
   */
  useEffect(() => {
    onGuardChange?.(recording ? '正在錄影。離開「提詞講稿」會停止這段錄影並要求存檔。' : null)
    return () => onGuardChange?.(null)
  }, [recording, onGuardChange])

  /**
   * 錄影中阻擋系統睡眠。
   *
   * 錄音頁一直有(powerSaveStart),錄影沒有 —— 也就是說筆電一睡,一段
   * 可能長達數小時的錄影會在沒有人知道的情況下停掉,而畫面上的計時器
   * 已經跟著凍結了,使用者醒來只看到一個「停在某個時間」的介面。
   */
  useEffect(() => {
    if (!recording) return
    void window.api.powerSaveStart()
    return () => {
      void window.api.powerSaveStop()
    }
  }, [recording])

  /**
   * 退出前的鉤子(與 Record 的同一個名稱 —— main 用 executeJavaScript 呼叫它)。
   *
   * 錄音那半存的是 React state 裡的逐字稿;錄影這半**不用存任何東西** ——
   * 分片已經在磁碟上了。它只需要把錄音器收尾,讓暫存檔成為一個完整可播的
   * 檔,然後回 true 告訴 quitGuard「有在處理」。
   *
   * quittingRef 是為了不彈存檔對話框:OS 關機時沒有人能回答它,而它會把
   * 退出流程卡住(這正是 quitGuard 存在的理由)。檔案下一次啟動會被
   * listOrphanRecordings() 撿回來,由使用者自己決定留不留。
   */
  useEffect(() => {
    const w = window as Window & { __aiTpFlushRecording?: () => Promise<boolean> }
    w.__aiTpFlushRecording = async () => {
      const rec = recorderRef.current
      if (!rec) return false
      quittingRef.current = true
      try {
        if (rec.state !== 'inactive') rec.stop()
      } catch {
        // 錄音器可能在 stop 的瞬間被裝置層拿掉;下面的 finish 仍然會關檔
      }
      const res = await window.api.videoRecordingFinish()
      return res.ok
    }
    return () => {
      delete w.__aiTpFlushRecording
    }
  })

  const pickMime = (): string => {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || ''
  }

  const beginRecording = async (): Promise<void> => {
    if (recordingStartRef.current || selectedId == null || !draft.content.trim()) return
    // Claim the start synchronously and mark its attempt before any save/permission await.
    // Unmount invalidates it, so a late save or permission response cannot start a camera.
    recordingStartRef.current = true
    const attempt = ++recordingAttemptRef.current
    try {
      if (dirty && !(await save())) return
      if (attempt !== recordingAttemptRef.current) return
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      })
      // Page may have been left while the permission prompt was open.
      if (attempt !== recordingAttemptRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      recStreamRef.current = stream
      const activeRecorderAttempt = attempt
      // 暫存檔:第一片之前就開好。失敗(磁碟滿/唯讀)要在開錄之前就知道 ——
      // 錄了十分鐘才發現寫不進去,比一開始就失敗糟得多。
      const begun = await window.api.videoRecordingBegin()
      if (!begun.ok) {
        stream.getTracks().forEach((t) => t.stop())
        throw new Error(`無法建立錄影暫存檔:${begun.error ?? '未知錯誤'}`)
      }
      if (attempt !== recordingAttemptRef.current) {
        void window.api.videoRecordingAbort()
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      chunkQueueRef.current = Promise.resolve()
      chunkErrorRef.current = null
      quittingRef.current = false
      const mimeType = pickMime()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return
        const blob = e.data
        chunkQueueRef.current = chunkQueueRef.current
          .then(async () => {
            const bytes = new Uint8Array(await blob.arrayBuffer())
            const res = await window.api.videoRecordingChunk(bytes)
            if (!res.ok && !chunkErrorRef.current) {
              chunkErrorRef.current = res.error ?? '寫入失敗'
              // 寫不進去就停:繼續錄只會讓計時器照走而畫面永遠是空的
              toast.error(`錄影無法寫入磁碟，已停止。${chunkErrorRef.current}`)
              stopRec()
            }
          })
          .catch((err: unknown) => {
            if (!chunkErrorRef.current) chunkErrorRef.current = err instanceof Error ? err.message : String(err)
          })
      }
      recorder.onstop = async () => {
        if (recTimerRef.current) {
          clearInterval(recTimerRef.current)
          recTimerRef.current = null
        }
        recStreamRef.current?.getTracks().forEach((t) => t.stop())
        recStreamRef.current = null
        if (recorderRef.current === recorder) recorderRef.current = null
        // 分片全部落地才能收尾:finish 會關檔,先關就永遠少最後幾片
        await chunkQueueRef.current
        const fin = await window.api.videoRecordingFinish()
        if (quittingRef.current) {
          // 退出流程(OS 關機 / 自動更新 / 使用者選了放棄並關閉):
          // 檔案已經在磁碟上,下次啟動會撿回來。不彈任何對話框 ——
          // 那一刻沒有人能回答它,而它會把退出卡住。
          return
        }
        try {
          if (chunkErrorRef.current) {
            if (activeRecorderAttempt === recordingAttemptRef.current) {
              toast.error(`錄影沒有完整寫入,未建立檔案(${chunkErrorRef.current})`)
            }
            return
          }
          if (!fin.ok) {
            if (activeRecorderAttempt === recordingAttemptRef.current) {
              toast.info(fin.error === 'empty' ? '錄影沒有產生影像資料，未建立檔案' : `錄影未儲存(${fin.error ?? '未知錯誤'})`)
            }
            return
          }
          const res = await window.api.videoRecordingSave({
            defaultName: `提詞錄影-${formatDateTime(Date.now()).replace(/[/: ]/g, '-')}.webm`
          })
          if (res.ok && res.filePath) {
            // Leaving the page still offers to save the finished recording, but don't
            // update an unmounted page afterward.
            if (activeRecorderAttempt === recordingAttemptRef.current) {
              setPreview({
                url: `app://rec/${res.previewName ?? ''}`,
                path: res.filePath,
                playable: !!res.previewable && !!res.previewName,
                isBlob: false
              })
            }
            toast.success(res.autoSaved ? '已存到「影片/AI 提詞機」' : '錄影已儲存')
          } else if (res.error === 'discarded') {
            toast.info('已放棄這段錄影。')
          } else {
            toast.error(`錄影未儲存(${res.error ?? '未知錯誤'})`)
          }
        } catch (err) {
          toast.error(`錄影儲存失敗。${describeError(err)}`)
        } finally {
          if (activeRecorderAttempt === recordingAttemptRef.current) {
            setRecording(false)
            setRecPaused(false)
          }
        }
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
      if (attempt !== recordingAttemptRef.current) return
      await window.api.overlayShow({
        scriptId: selectedId,
        title: normalizeScriptTitle(draft.title),
        content: draft.content
      })
    } catch (err) {
      if (attempt === recordingAttemptRef.current) {
        if (recTimerRef.current) {
          clearInterval(recTimerRef.current)
          recTimerRef.current = null
        }
        const recorder = recorderRef.current
        recorderRef.current = null
        if (recorder && recorder.state !== 'inactive') {
          try {
            recorder.stop()
          } catch {
            // A device failure can make the recorder inactive between the state check and stop().
          }
        }
        recStreamRef.current?.getTracks().forEach((t) => t.stop())
        recStreamRef.current = null
        // 錄音器從來沒開起來:暫存檔是空的,留著只會讓下次啟動撿到一個
        // 0 位元組的「未完成錄影」。開過了就交給 onstop 走正常存檔路徑。
        if (!recorder) void window.api.videoRecordingAbort()
        toast.error(`錄影無法啟動。${describeError(err)}`)
      }
    } finally {
      if (attempt === recordingAttemptRef.current) recordingStartRef.current = false
    }
  }

  /** 倒數 3-2-1 後開錄;使用者可勾選不再顯示(localStorage) */
  const cancelCountdown = (): void => {
    countdownAttemptRef.current += 1
    countdownRunningRef.current = false
    setCountdown(null)
  }

  const startRecLaunch = async (): Promise<void> => {
    if (
      selectedId == null ||
      !draft.content.trim() ||
      countdownRunningRef.current ||
      recordingStartRef.current ||
      recording
    ) return
    if (localStorage.getItem('rec-countdown-off') === '1') {
      void beginRecording()
      return
    }
    const attempt = ++countdownAttemptRef.current
    countdownRunningRef.current = true
    try {
      for (const n of [3, 2, 1]) {
        if (attempt !== countdownAttemptRef.current) return
        setCountdown(n)
        await new Promise((r) => setTimeout(r, 800))
      }
      if (attempt !== countdownAttemptRef.current) return
      setCountdown(null)
      void beginRecording()
    } finally {
      if (attempt === countdownAttemptRef.current) countdownRunningRef.current = false
    }
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
    const recorder = recorderRef.current
    recorderRef.current = null
    if (!recorder || recorder.state === 'inactive') return
    recordingStartRef.current = false
    try {
      recorder.stop()
    } catch (err) {
      toast.error(`無法停止錄影。${describeError(err)}`)
    }
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
              // 名稱是使用者自己取的講稿標題 → 動態,必須有穩定身分
              data-effect-id="script-row"
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
        {/* 未完成的錄影(上次進程在錄影中死掉)。放在最上面而不是 toast:
            toast 4 秒就沒了,而這件事要等到使用者自己決定留不留才結束。 */}
        {orphans.length > 0 && !recording && (
          <div
            data-orphan-banner="1"
            role="alert"
            className="flex flex-wrap items-center gap-3 border-b border-amber-450/30 bg-amber-450/10 px-6 py-3 text-xs text-amber-200"
          >
            <span className="flex-1">
              找到 {orphans.length} 段未完成的錄影（上次錄影中斷,已經寫到磁碟的部份）。
            </span>
            <button
              data-effect-id="rec-orphans-keep"
              className="btn-primary text-xs"
              onClick={() => void resolveOrphans('keep')}
            >
              保留到「影片/AI 提詞機」
            </button>
            <button
              data-effect-id="rec-orphans-discard"
              className="btn-outline text-xs"
              onClick={() => void resolveOrphans('discard')}
            >
              清除
            </button>
          </div>
        )}
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
            <button type="button" className="btn-outline text-xs" onClick={cancelCountdown}>
              取消倒數
            </button>
          </div>
        )}
        {/* 錄影預覽 modal */}
        {preview && (
          <div
            // data-modal-backdrop:與 ConfirmDialog 同一個宣告。錄影預覽是模態
            // (背景不可操作),而「模態蓋住背景」正是模態的定義。
            // 沒有它, domAudit 的 text-covered 會把底下的講稿列表、工具列
            // 全部報成缺陷 —— 那是必然的覆蓋,留在報告裡只會訓練人忽略報告。
            data-modal-backdrop="preview"
            className="absolute inset-0 z-30 flex items-center justify-center bg-ink-950/85 p-6 backdrop-blur-sm"
          >
            <div className="glass anim-rise w-full max-w-2xl rounded-2xl p-4">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="text-sm font-semibold">錄影完成</span>
                <span
                  // title 是因為這是完整路徑且用 truncate:截斷後使用者
                  // 永遠不知道錄影到底存在哪,而「開啟所在資料夾」壞掉時
                  // 這是他唯一能拿到的線索。
                  className="flex-1 truncate text-[11px] text-ink-400"
                  title={preview.path}
                >
                  {preview.path}
                </span>
                <button
                  // 與 toast 關閉鈕同一個處理:28px 命中區、15px 圖示不變。
                  // 原本是 15x15 —— 這個彈窗剛好出現在「錄完一段、要決定
                  // 留不留」的當下,那時使用者的注意力在錄影內容上。
                  className="-mr-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center text-ink-400 hover:text-white"
                  aria-label="關閉錄影預覽"
                  title="關閉錄影預覽"
                  onClick={() => {
                    if (preview.isBlob) URL.revokeObjectURL(preview.url)
                    setPreview(null)
                  }}
                >
                  <X size={15} />
                </button>
              </div>
              {preview.playable ? (
                <video src={preview.url} controls autoPlay className="w-full rounded-xl border border-white/10" />
              ) : (
                // 檔案被存到兩個可服務根目錄之外(例如使用者自己選了桌面)。
                // 擺一個永遠轉不出畫面的 player 比明說更糟 —— 使用者會以為
                // 檔案壞了。降級成「它在哪、怎麼開」,那兩件事永遠成立。
                <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-8 text-center text-xs text-white/60">
                  影片已存到這個位置,App 內不預覽;
                  <br />
                  按下方按鈕用系統播放器開啟。
                </div>
              )}
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
                    if (preview.isBlob) URL.revokeObjectURL(preview.url)
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
            <div className="flex items-center gap-2">
              <button className="btn-primary text-xs" onClick={() => void newScript()}>
                <FilePlus2 size={14} /> 建立第一份講稿
              </button>
              {/* 第二條路:先看到成品再說。放這一顆的理由見 loadDemo 的說明。 */}
              <button
                data-effect-id="demo-script"
                className="btn-outline text-xs"
                onClick={() => void loadDemo()}
              >
                <Sparkles size={14} /> 用範例稿試提詞
              </button>
            </div>
            <span className="max-w-[280px] text-center text-[11px] leading-relaxed text-ink-400">
              範例稿是一份真的講稿,會存進你的清單,可以直接改成自己的內容。
            </span>
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
                  // 標題輸入框也要排自動存檔。漏掉它的後果很具體:
                  // 只改標題的使用者(匯入一份稿後改個名字就走)永遠不會
                  // 觸發寫入 —— 自動存檔變成「只在按到內文框時才生效」。
                  autosaveRef.current?.schedule()
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
              {/* 寫入時間刻意**不**放在按鈕裡面。
                  按鈕的文字就是效果稽核的控制項身分(見 lib/effect-inventory.mjs 的
                  key()),而時間會讓同一顆鈕變成不同的 key —— 09:05 一個、14:32 一個。
                  那個登記表會開始漏掉新的按鈕身分,於是「按了沒效果」的檢查
                  對**這一頁**失效,而它失效的原因正是我加的這行字。
                  非互動的 <span> 不會被列舉成控制項,所以時間放這裡是安全的。 */}
              {!dirty && savedAt != null && (
                <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-400">
                  已寫入 {formatClock(savedAt)}
                </span>
              )}
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
                    data-effect-id="rec-pause"
                    className="btn-outline shrink-0 text-xs"
                    onClick={toggleRecPause}
                    title={recPaused ? '續錄' : '暫停(計時凍結)'}
                  >
                    {recPaused ? <Play size={14} /> : <Pause size={14} />}
                  </button>
                  <button data-effect-id="rec-stop" className="btn-outline shrink-0 text-xs text-rose-450" onClick={stopRec}>
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
              //
              // data-effect-id:aria-label 裡帶著講稿標題(使用者自己取的字串),
              // 所以名稱**會隨資料變**。稽核要量的是「編輯器內容有沒有真的寫進
              // IndexedDB」這個控制項的行為,不是「這一份稿叫什麼名字」——
              // 名稱會變的話,每一輪量到的都是不同的控制項,覆蓋率會靜默縮水。
              data-effect-id="script-body"
              aria-label={`講稿內容${draft.title ? `：${draft.title}` : ''}`}
              className="flex-1 resize-none bg-transparent px-6 py-5 text-[15px] leading-relaxed text-ink-100 outline-none"
              placeholder={'在這裡貼上或輸入講稿…\n\n支援從 .txt / .md 匯入。空行會作為段落分隔。'}
              value={draft.content}
              onChange={(e) => {
                setDraft({ ...draft, content: e.target.value })
                setDirty(true)
                autosaveRef.current?.schedule()
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
