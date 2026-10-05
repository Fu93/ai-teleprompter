import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, RefreshCw, Ruler, ScanEye } from 'lucide-react'
import { useSettings } from '../lib/store'
import { describeError } from '../lib/describeError'
import {
  clampPillScale,
  PILL_SCALE_MAX,
  PILL_SCALE_MIN,
  PILL_SCALE_STEP,
  pillKeywordCharsOf,
  pillSizeOf
} from '@shared/overlayShapes'
import { toast } from '../lib/toast'
import { useHotkeyConflicts } from '../lib/hotkeys'
import { cn, formatDateTime } from '../lib/utils'
import type { AppSettings, GazeInfo } from '@shared/types'
import {
  DEFAULT_VIEWING_DISTANCE_CM,
  gazeOffsetDeg,
  pxToCm96dpi
} from '../lib/calibration'
import type { SceneSummary } from '@shared/api'
import { Segmented } from '../components/Segmented'
import { BackupSection } from '../components/BackupSection'
import { DataTrustPanel } from '../components/DataTrustPanel'
import { formatDiagnosticsReport } from '@shared/observability'
import { reportError } from '../lib/reportError'
import { PreflightCard } from '../components/PreflightCard'
import { DENSITY_MODE_LABEL, suggestDisplayMode } from '../lib/densityAdvice'

const SCENE_LABELS_ZH: Record<string, string> = {
  interview: '面試',
  sales: '銷售',
  investor: '投資人',
  podcast: '播客',
  demo: '產品展示',
  support: '客服',
  defense: '學術答辯',
  default: '通用'
}

/** 熱鍵欄位名稱 → 顯示名(衝突提示用) */
const HOTKEY_LABELS: Record<string, string> = {
  toggleOverlay: '顯示浮層',
  hideOverlay: '隱藏浮層',
  panicRescue: 'Panic 救援',
  playPause: '播放 / 暫停',
  speedUp: '語速 +',
  speedDown: '語速 −'
}

function sceneLabel(s: SceneSummary): string {
  if (SCENE_LABELS_ZH[s.key]) return SCENE_LABELS_ZH[s.key]
  return s.label.length <= 6 ? s.label : s.label.slice(0, 6)
}

/**
 * 設定頁的區塊目錄(2026-10-03 新增)。
 *
 * 為什麼要它:這一頁有九個區塊疊成一個長捲動頁(實測 1099 行),而「快速鍵」
 * 是第七個 —— 使用者為了改一顆熱鍵要一路捲過五個與他無關的區塊。
 * 每一個區塊單獨看都合格,合起來就是一頁找不到東西。幾何/對比/覆蓋那類稽核
 * 永遠不會報這件事(它不屬於任何單一元素的屬性)。
 *
 * 文字是區塊的正式標題,不是簡寫 —— 目錄與卡片寫不同詞會讓人懷疑自己看錯頁。
 * id 用固定字串(而不是把中文標題轉 id):中文標題會微調,id 不該跟著動。
 */
const SETTINGS_SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'calibration', label: '個人化校準' },
  { id: 'overlay', label: '提詞浮層' },
  { id: 'stt', label: '語音辨識' },
  { id: 'preflight', label: '開始之前' },
  { id: 'ai', label: 'AI 助理' },
  { id: 'hotkeys', label: '快速鍵' },
  { id: 'data-trust', label: '你的資料去了哪裡' },
  { id: 'backup', label: '資料備份' },
  { id: 'troubleshoot', label: '疑難排解' }
]

/**
 * 一個設定區塊。
 *
 * id 有兩個消費者:(1) 頁首目錄的錨點跳轉, (2) 離線稽核用來驗
 * 「每個區塊都出現在目錄裡」—— 那就是加 id 的理由,不只是為了美觀。
 * scroll-mt-6:沒有它,跳過去的區塊上緣會被頁面頂端貼齊到看不見標題。
 */
function Section({
  id,
  title,
  desc,
  children
}: {
  id: string
  title: string
  desc?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div id={id} data-settings-section={id} className="card scroll-mt-6 p-6">
      <div className="mb-5">
        <div className="eyebrow">{title}</div>
        {desc && <div className="mt-0.5 text-xs text-ink-400">{desc}</div>}
      </div>
      <div className="space-y-5">{children}</div>
    </div>
  )
}

/**
 * 金鑰欄位的狀態說明。
 *
 * 為什麼需要:金鑰欄位在讀到安全儲存之前是 disabled 的,而「灰色不能打」與
 * 「壞掉了」在畫面上長得一模一樣 —— 使用者能做的最合理推論是後者。原本只有
 * 一個 `disabled={!secureKeysLoaded}` 與 `disabled:opacity-40`,沒有任何一句話
 * 說明它為什麼不能按、要等多久(見 docs/UX_FINDINGS.md P1-4)。
 *
 * 兩種狀態共用一個元件而不是各寫一次:它們是同一件事的兩個結局
 * (还在讀 / 讀不到),分開寫遲早會有一邊忘了更新。
 */
function KeyStatus({ loading, note }: { loading: boolean; note: string | null }): JSX.Element | null {
  if (loading) {
    return (
      <div data-key-status="loading" className="mt-1.5 text-[11px] text-ink-400">
        正在讀取已儲存的金鑰…(載入完成前先不開放編輯,避免空值把已存的金鑰蓋掉)
      </div>
    )
  }
  if (note) {
    return (
      <div data-key-status="unreadable" className="mt-1.5 text-[11px] leading-relaxed text-amber-450">
        {note}
      </div>
    )
  }
  return null
}

function Switch({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}): JSX.Element {
  return (
    <button
      // data-effect-id:頁面上有 8 個開關,而稽核要逐個驗「它真的翻了對應的設定」。
      // 用 label 當 key 也行,但 label 文案是產品會改的東西 —— 那一族的重複實例
      // 用同一個穩定 id 涵蓋,逐個對應的責任留給探針(它會列出 8 組 label→設定路徑)。
      data-effect-id="switch"
      onClick={() => onChange(!checked)}
      // 這是開關不是一般按鈕:螢幕閱讀器預設會報「按鈕」而完全不報狀態,
      // 使用者不知道現在是開還是關。role/aria-checked 是 toggle 的必要條件。
      role="switch"
      aria-checked={checked}
      // py-2 讓列高從 24px 拉到 40px。原本沒有任何內距,按鈕高度剛好等於
      // 視覺開關本身,文字與開關完全貼在一起,點目標也偏小。
      className="flex w-full items-center justify-between gap-4 py-2 text-left cursor-pointer"
    >
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div>}
      </div>
      <span
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent-500' : 'bg-ink-700'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
            checked ? 'left-[22px]' : 'left-0.5'
          )}
        />
      </span>
    </button>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  format,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  /** 覆寫右側數值的顯示方式(例如倍率固定兩位小數:1.00× / 0.80×) */
  format?: (v: number) => string
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <div>
      <div className="mb-2 flex justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono text-xs text-ink-300">
          {format ? format(value) : `${value}${unit ?? ''}`}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        // 上方的 label 是視覺文字,不會自動成為表單控制的無障礙名稱
        aria-label={label}
        // 命中帶高度由 global.css 的 `input[type='range']` 決定(已 22 → 28px,
        // 第四輪 P2-2)。不要在這裡加 h-7 之類的高度 class:元素特異度
        // (0,1,1) 高於 Tailwind 的 (0,1,0),加了也不會生效 —— 實測過。
        className="w-full cursor-pointer accent-accent-500"
      />
    </div>
  )
}

export default function SettingsPage({
  onNavigate
}: {
  onNavigate?: (page: 'dashboard' | 'scripts' | 'record' | 'practice' | 'calibration' | 'settings') => void
}): JSX.Element {
  const { settings, update } = useSettings()
  // 更新待安裝的橫幅已經搬到 App 層(見 App.tsx 的 UpdateBanner 與 lib/update.ts):
  // 它原本只長在這裡,而使用者幾乎不會為了「看看有沒有更新」進設定頁 ——
  // 提示長在他不會去的地方,與靜默安裝是同一件事。
  const [testing, setTesting] = useState(false)
  const [aiApiKey, setAiApiKey] = useState('')
  const [sttApiKey, setSttApiKey] = useState('')
  const [secureKeysLoaded, setSecureKeysLoaded] = useState(false)
  /**
   * 安全儲存**沒有回應**時要說的那句話。
   *
   * 原本這個旗標只有兩個結局:讀到了(欄位解鎖)或拋錯(欄位解鎖 + toast)。
   * 但 IPC 也可能**永遠不回來**(主程序卡在磁碟或 safeStorage),那時欄位就
   * 一直灰著,沒有任何訊息、沒有任何出口 —— 使用者只能重開 App。
   * 所以給它一個上限:4 秒之後就當作「讀不到舊金鑰」,把欄位交還給使用者
   * (輸入新的一定覆蓋得了舊的,而「不能輸入」比「可能覆蓋」嚴重得多)。
   */
  const [secureKeysNote, setSecureKeysNote] = useState<string | null>(null)
  const secureKeysRef = useRef<Record<string, unknown>>({})
  const pendingKeysRef = useRef<Partial<Record<'apiKey' | 'sttApiKey', string>>>({})
  const keyTimersRef = useRef<Partial<Record<'apiKey' | 'sttApiKey', ReturnType<typeof setTimeout>>>>({})
  const keyWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  const [models, setModels] = useState<string[] | null>(null)
  const [ollamaVersion, setOllamaVersion] = useState<string | null>(null)
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null)
  const [simBusy, setSimBusy] = useState(false)
  const [simDataUrl, setSimDataUrl] = useState<string | null>(null)
  const [gaze, setGaze] = useState<GazeInfo | null>(null)
  // 凝視錨點狀態(DESIGN_RESEARCH P0-1):進頁時取一次 —— App 的路由是條件渲染,
  // 離開再回來就是重新掛載,所以在浮層裡「◎ 鎖定」之後重開設定頁就會看到新值。
  useEffect(() => {
    let alive = true
    void window.api.overlayGazeInfo().then((g) => {
      if (alive) setGaze(g)
    })
    return () => {
      alive = false
    }
  }, [])

  /**
   * **作業系統層級註冊失敗的熱鍵。**
   *
   * 上一行的重複偵測只看得見「自己和自己衝突」。但熱鍵更常是
   * **被別的程式佔走** —— Ctrl+Alt+T 這種組合在 Windows 上很容易撞到
   * 常駐軟體,而 Alt+Up / Alt+Down 是某些視窗管理器的標準鍵。
   * main 端 `globalShortcut.register` 會回 false 並記進 state.hotkeyConflicts,
   * 但那個值**從來沒有被任何畫面讀過**。
   *
   * 結果:設定頁寫著「全域熱鍵，任何應用程式上方都有效」,
   * 使用者挑了一組組合、存檔成功、設定看起來完全正常 ——
   * 按下去什麼都不發生,而且沒有任何地方告訴他為什麼。
   * 這種故障在每一個 DOM 稽核裡都長得跟正常的一模一樣。
   *
   * 這是 audit:effects 抓到的(它量的是「按了之後系統有沒有變」)。
   */
  const hotkeyConflicts = useHotkeyConflicts()

  // 讀取金鑰的保險絲:讀得到就沒有這回事,沒回應時讓欄位自己解鎖(理由見上)。
  useEffect(() => {
    if (secureKeysLoaded) return
    const t = setTimeout(() => {
      setSecureKeysNote('讀不到已儲存的金鑰(安全儲存沒有回應)—— 直接輸入新的即可,會以你輸入的為準。')
      setSecureKeysLoaded(true)
    }, 4000)
    return () => clearTimeout(t)
  }, [secureKeysLoaded])

  /**
   * **每次熱鍵設定改變都要重新問一次。**
   *
   * 第一版只在 mount 時讀一次 `appInfo().hotkeyConflicts`，而 main 是在
   * `SettingsSet` 之後重新註冊熱鍵的 —— 所以使用者把衝突的那幾顆改掉之後，
   * 畫面還是拿著**舊的那份名單**。
   *
   * 後果比沒有提示更糟：
   *   1. 使用者已經修好了，警告卻還說「6 顆熱鍵沒有註冊成功」，
   *      而且列的是他已經改掉的組合 —— 他會以為自己的修改沒生效。
   *   2. 反查「這顆是哪個功能」時，`settings.hotkeys` 已經是新的了，
   *      用舊名單去比對永遠比不到，於是每顆都退化成一串按鍵代碼。
   *
   * 這個缺陷是 audit:effects 抓到的：它的熱鍵探針為了驗「熱鍵下拉有沒有
   * 效果」會把組合改掉，於是快照與現況對不上 —— 訊息裡明明白白寫著
   * 「有 6 顆」而列出的組合和當下的設定無關。
   */
  // 熱鍵衝突的取得與新鮮度已經抽到 lib/hotkeys.ts —— 同一份判斷現在有三個
  // 使用端(這裡、側欄提示、總覽頁 footer),留在這裡就會變成三份會漂移的實作。
  // watcher 本身由 App.tsx 掛一次(依賴 settings.hotkeys),這裡只讀結果。

  // 場景清單(場景情境那張卡片的資料來源)。
  // **這行是被我自己弄丟過的**:加入上面那個 hotkeyConflicts effect 時,
  // 我用它當錨點做替換,把這整個 useEffect 一起刪掉了。型別檢查完全沒報錯
  // (scenes 只是永遠保持 null,`scenes ?? []` 讓它安靜地渲染成空),
  // 是 audit:effects 報「只找到 0 個情境按鈕」才發現。
  // 刪掉別的 effect 時要用「插入」而不是「拿它當替換錨點」。
  useEffect(() => {
    void window.api.sceneList().then(setScenes).catch(() => setScenes([]))
  }, [])

  /**
   * 安全金鑰讀不到時的 fallback 值,直接從 settings 取。
   *
   *   提成具名的兩個值(而不是在 effect 裡寫 settings.xxx):依賴陣列本來就列的是
   *   這兩個欄位,讓 effect 內文也用同一組名稱,「什麼變了才重讀金鑰」才是
   *   一句看得出來、也驗得出來的話 —— 而不是「依賴兩個欄位、內文卻讀整個物件」。
   */
  const aiKeyFallback = settings?.ai.openaiCompatible.apiKey
  const sttKeyFallback = settings?.stt.cloud.apiKey
  /** 設定還沒回來之前不讀金鑰(與原本的 if (!settings) return 同一個條件)。 */
  const settingsLoaded = settings !== undefined

  useEffect(() => {
    if (!settingsLoaded) return
    let mounted = true
    void window.api.keysGet().then((keys) => {
      if (!mounted) return
      const stored = keys ?? {}
      secureKeysRef.current = stored
      const pending = pendingKeysRef.current
      setAiApiKey(
        typeof pending.apiKey === 'string'
          ? pending.apiKey
          : typeof stored.apiKey === 'string'
            ? stored.apiKey
            : aiKeyFallback ?? ''
      )
      setSttApiKey(
        typeof pending.sttApiKey === 'string'
          ? pending.sttApiKey
          : typeof stored.sttApiKey === 'string'
            ? stored.sttApiKey
            : sttKeyFallback ?? ''
      )
      setSecureKeysLoaded(true)
    }).catch((err) => {
      if (!mounted) return
      setSecureKeysLoaded(true)
      toast.error(`讀取安全金鑰失敗。${describeError(err)}`)
    })
    return () => {
      mounted = false
    }
  }, [settingsLoaded, aiKeyFallback, sttKeyFallback])
  const [testError, setTestError] = useState<string | null>(null)

  /**
   * 存金鑰去作業系統安全儲存(safeStorage)。
   *
   * 為什麼改成 debounce 而不是只有 onBlur:
   *   原本兩個金鑰欄位是「離開欄位才存」,而同一頁其他 14 個欄位都是
   *   onChange 立刻存。使用者的實際動作是「打完金鑰 → 直接關掉視窗」——
   *   那個 blur 事件不一定會發生(金鑰沒送到焦點的情況下關窗、App 被關閉、
   *   系統直接結束行程),於是他輸入的字**整個遺失,而且沒有任何提示**。
   *   使用者下次打開會看到空的金鑰欄位,以為自己記錯了。
   *   這是「改了但沒存」裡最貴的一種:它牽涉使用者付費的東西,而且使用者
   *   不會收到任何回饋。
   *
   * 為什麼 debounce 而不是每敲一個字就寫一次:
   *   金鑰是十幾個字,每敲一個字都過一次 IPC + safeStorage 加密是不必要的負擔
   *   (而 Windows DPAPI 每次呼叫都不便宜)。600ms 讓「停頓」才寫,
   *   使用者打完字繼續動作時已經存好了。
   *
   * **blur 時仍然立刻寫一次**:debounce 會讓「打完直接關窗」的最後一段
   *   有機會落在計時器裡來不及寫,所以 blur 是最後一道保險。
   */
  const writeSecureKey = (name: 'apiKey' | 'sttApiKey', value: string): void => {
    if ((secureKeysRef.current[name] ?? '') === value) {
      delete pendingKeysRef.current[name]
      return
    }
    // Serialize full-object writes and merge at execution time. Keep the ref as the
    // last successfully persisted object: failed writes must remain retryable, and
    // independently edited keys must never overwrite one another.
    keyWriteChainRef.current = keyWriteChainRef.current
      .then(async () => {
        // A newer keystroke may have superseded this queued debounce/blur write.
        if (pendingKeysRef.current[name] !== value) return
        if ((secureKeysRef.current[name] ?? '') === value) {
          if (pendingKeysRef.current[name] === value) delete pendingKeysRef.current[name]
          return
        }
        const next = { ...secureKeysRef.current, [name]: value }
        const ok = await window.api.keysSet(next)
        if (!ok) {
          toast.error('作業系統安全儲存不可用，API 金鑰未儲存')
          return
        }
        secureKeysRef.current = next
        if (pendingKeysRef.current[name] === value) delete pendingKeysRef.current[name]
        window.dispatchEvent(new Event('ai-tp:keys-changed'))
      })
      .catch((err) => toast.error(`金鑰儲存失敗。${describeError(err)}`))
  }
  const saveSecureKey = (name: 'apiKey' | 'sttApiKey', value: string): void => {
    pendingKeysRef.current[name] = value
    const currentTimer = keyTimersRef.current[name]
    if (currentTimer) clearTimeout(currentTimer)
    keyTimersRef.current[name] = setTimeout(() => {
      delete keyTimersRef.current[name]
      writeSecureKey(name, value)
    }, 600)
  }
  /** blur 時呼叫:立刻寫,不等 debounce。見上方「為什麼改成 debounce」。 */
  const flushSecureKey = (name: 'apiKey' | 'sttApiKey', value: string): void => {
    const currentTimer = keyTimersRef.current[name]
    if (currentTimer) clearTimeout(currentTimer)
    delete keyTimersRef.current[name]
    writeSecureKey(name, value)
  }
  // 離頁時同步 flush 所有欄位的最新輸入;計時器分欄位,一個金鑰不會取消另一個。
  useEffect(
    () => () => {
      for (const name of ['apiKey', 'sttApiKey'] as const) {
        const timer = keyTimersRef.current[name]
        if (timer) clearTimeout(timer)
        delete keyTimersRef.current[name]
        const pending = pendingKeysRef.current[name]
        if (pending !== undefined) writeSecureKey(name, pending)
      }
    },
    []
  )

  /**
   * 複製診斷報告。
   *
   * 報告由 **main 端**組裝並已遮蔽(見 src/main/diagnostics.ts)——
   * 刻意不在 renderer 拼:任何一條未來新增的取值路徑都會漏掉遮蔽,
   * 而遮蔽是這個功能唯一不能出錯的部分。
   */
  const copyDiagnostics = async (): Promise<void> => {
    try {
      const report = await window.api.diagnosticsReport()
      const text = formatDiagnosticsReport(report)
      await navigator.clipboard.writeText(text)
      toast.success('診斷報告已複製。貼到問題回報時請順便說明你當下在做什麼。')
    } catch (err) {
      // 複製失敗仍然要說人話:clipboard 在某些環境不可用,而使用者
      // 此刻正要回報問題 —— 讓他自己開記錄資料夾是可行的退路。
      reportError('複製診斷報告失敗', err, { event: 'backup_failed' })
      toast.info('可以改用「開啟記錄資料夾」,把 main.log 附在回報裡。')
    }
  }

  if (!settings) return <div className="p-8 text-sm text-ink-400">載入中…</div>

  const o = settings.overlay

  /**
   * 提詞密度建議(roadmap P3 的重寫版):唯讀,只在有校準而且語速落在
   * 快/慢兩側時出現。不自動切換模式 —— 理由見 lib/densityAdvice.ts 檔頭。
   */
  const densityAdvice = suggestDisplayMode(settings.personal.profile, o.displayMode)
  const patchO = (patch: Partial<AppSettings['overlay']>): Promise<void> =>
    update({ overlay: patch })

  const testOllama = async (): Promise<void> => {
    setTesting(true)
    setTestError(null)
    setModels(null)
    try {
      const res = await window.api.ollamaListModels(settings.ai.ollama.baseUrl)
      if (!res.installed) {
        setTestError('無法連線到 Ollama——請確認已安裝並啟動（終端機執行 ollama serve 或直接開啟 Ollama 應用程式）')
      } else {
        setModels(res.models)
        setOllamaVersion(res.version)
        if (res.models.length === 0) setTestError('已連線，但還沒有任何模型——請執行 ollama pull qwen2.5:7b')
      }
    } catch (err) {
      // 這裡測的就是 Ollama:連線失敗就是 Ollama 沒開,不要給中性的網路訊息
      setTestError(describeError(err, { provider: 'ollama' }))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-8 py-8">
      <h1 className="text-xl font-bold">設定</h1>

      {/* 區塊目錄:九個區塊的單一長捲動頁需要一條索引(見 SETTINGS_SECTIONS) */}
      <nav
        data-settings-toc="1"
        aria-label="設定區塊"
        className="card flex flex-wrap gap-1.5 p-3"
      >
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            // 九顆 chip 共用同一個身分。效果稽核的列舉端對 data-effect-id 一律
            // 收斂成 `${page}|id:${id}`,重複的實例只加 #n 序號、基礎鍵不變 ——
            // 所以一筆登記(settings|id:settings-toc)就涵蓋九顆,不必為了讓
            // 對帳對得上而登記九筆一模一樣的東西(那九筆會隨區塊增減而漂移)。
            data-effect-id="settings-toc"
            data-settings-toc-link={s.id}
            // py-1.5(而不是 py-1):第一版是 py-1,高度 25px,低於 28px 的點擊目標
            // 下限 —— audit:ui 當場報了五筆 small-tap-target(五個不同寬度各一筆)。
            // 這一條正是「先修、後開門檻」的反面教材:新加的 UI 也要自己通過舊門檻。
            className="cursor-pointer rounded-lg px-2.5 py-1.5 text-[11px] text-ink-300 transition-colors hover:bg-white/8 hover:text-ink-100"
            onClick={() => {
              // scrollIntoView 而不是改 hash:主視窗的網址被 App.tsx 拿去記頁面
              // (#/settings),在這裡動 hash 會把頁面路由踢掉。
              document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <Section id="calibration" title="個人化校準" desc="以你的眼距與語速自動產生字級、滾動速度與預估時長">
        {settings.personal.profile ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-3 text-center">
              <div className="rounded-lg bg-ink-850 p-3">
                <div className="text-[10px] text-ink-400">瞳距</div>
                <div className="mt-0.5 text-lg font-semibold">
                  {settings.personal.profile.ipdMm}
                  <span className="text-xs text-ink-400">mm</span>
                </div>
              </div>
              <div className="rounded-lg bg-ink-850 p-3">
                <div className="text-[10px] text-ink-400">視距</div>
                <div className="mt-0.5 text-lg font-semibold">
                  {settings.personal.profile.viewingDistanceCm}
                  <span className="text-xs text-ink-400">cm</span>
                </div>
              </div>
              <div className="rounded-lg bg-ink-850 p-3">
                <div className="text-[10px] text-ink-400">語速</div>
                <div className="mt-0.5 text-lg font-semibold">
                  {settings.personal.profile.charsPerMin}
                  <span className="text-xs text-ink-400">字/分</span>
                </div>
              </div>
              <div className="rounded-lg bg-ink-850 p-3">
                <div className="text-[10px] text-ink-400">字級／速度</div>
                <div className="mt-0.5 text-lg font-semibold">
                  {settings.personal.profile.derivedFontSize}
                  <span className="text-xs text-ink-400">px</span> · {settings.personal.profile.derivedSpeed}
                  {/* 單位補齊:旁邊的 px 有單位而這個數字沒有,「32px · 90」
                      讀不出 90 是什麼(見 UX_FINDINGS 第三輪 P1-2)。 */}
                  <span className="text-xs text-ink-400">px/s</span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between text-[11px] text-ink-400">
              <span>校準於 {formatDateTime(settings.personal.profile.calibratedAt)}</span>
              <button className="btn-outline text-xs" onClick={() => onNavigate?.('calibration')}>
                <Ruler size={13} /> 重新校準
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div className="text-xs leading-relaxed text-ink-400">
              尚未校準——目前使用通用預設值。
              <br />
              校準後會自動產生適合你的字級與滾動速度。
            </div>
            <button className="btn-primary shrink-0 text-xs" onClick={() => onNavigate?.('calibration')}>
              <Ruler size={13} /> 開始校準
            </button>
          </div>
        )}
      </Section>

      <Section id="overlay" title="提詞浮層" desc="外觀與行為，變更即時生效">
        <div>
          <div className="label">顯示模式</div>
          <Segmented
            ariaLabel="顯示模式"
            options={[
              { id: 'scroll', label: '連續捲動' },
              { id: 'phrase', label: '逐句短語' },
              { id: 'bullet', label: '重點要點' },
              { id: 'karaoke', label: '逐詞高亮' }
            ]}
            value={o.displayMode}
            onChange={(id) => patchO({ displayMode: id })}
          />
          <div className="mt-1.5 text-[11px] text-ink-400">
            {settings.personal.profile
              ? `逐句/逐詞以你的個人語速 ${settings.personal.profile.charsPerMin} 字/分為基準推進（倍率 1×＝你自己的語速）;重點要點自動切出 Markdown 大綱或段落,手動(← →)翻頁。`
              : '逐句/逐詞以 120 WPM 為基準推進（完成個人化校準後改以你的語速為基準）;重點要點自動切出 Markdown 大綱或段落,手動(← →)翻頁。'}
          </div>
          {/* 密度建議:出現在「做決定的地方」——使用者正在看這四顆模式鈕。 */}
          {densityAdvice && (
            <div className="mt-1.5 text-[11px] text-ink-400" data-density-advice="1">
              建議:{DENSITY_MODE_LABEL[densityAdvice.mode]}模式 — {densityAdvice.reason}
            </div>
          )}
        </div>
        <div>
          <Slider
            label="藥丸大小"
            value={o.pillScale}
            min={PILL_SCALE_MIN}
            max={PILL_SCALE_MAX}
            step={PILL_SCALE_STEP}
            // 固定兩位小數:滑桿的步進是 0.05,顯示 1× / 1.2× / 0.8× 會讓
            // 「1」看不出是 1.00× 還是被夾住的 1.3×(使用者視角試用發現的不一致)
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => patchO({ pillScale: clampPillScale(v) })}
          />
          {/* 倍率是抽象的數字:把它換算成使用者眼前真正會看到的尺寸。
              這裡的數字與實際視窗是同一個值 —— 藥丸/貼鏡的視窗被設成不可調整大小
              (只有展開形態能拖,見 windows.ts 的 applyOverlayWindowSettings),
              所以「倍率 = 你會看到的尺寸」是精確的,不需要寫「約」。
              順帶把「下一個關鍵詞」會縮到幾字一起講:那是這個寬度下唯一會變的東西。 */}
          <div className="mt-1.5 text-[11px] text-ink-400">
            收合成藥丸（靈動島）時的尺寸:{pillSizeOf(o.pillScale).w}×{pillSizeOf(o.pillScale).h}（不會再更大或更小）;
            只縮放膠囊本體，字級與 28px 的按鈕（觸控目標）不變。
            「下一個關鍵詞」在這個寬度下顯示 {pillKeywordCharsOf(pillSizeOf(o.pillScale).w)} 字。
          </div>
        </div>
        <div>
          <div className="label">凝視錨點（貼鏡）</div>
          {/* 把「眼神自然」從感覺變成度數:角度 = atan(實體偏移 ÷ 臉距)。
              px→cm 用 calibration.ts 的 96dpi 假設(與 visualAngleDeg 同一套);
              offsetPx 的幾何(錨點距螢幕物理上緣 + 文字帶在視窗內的偏移)
              在 main/gaze.ts。臉距未校準時用文獻典型值 50cm 並**標明**,不裝作精確。 */}
          <div className="mt-1.5 text-[11px] text-ink-400">
            {!gaze ? (
              '浮層尚未開啟(進一次貼鏡模式後可校正)'
            ) : !gaze.anchored ? (
              '未校正 — 進貼鏡模式,把浮層拖到攝影機正下方,按工具列「◎ 鎖定」'
            ) : gaze.stale ? (
              '已校正,但錨點所在的螢幕已拔除 — 進貼鏡重新按「◎ 鎖定」(目前吸附會退回上中)'
            ) : (
              `已校正（${gaze.cameraLabel ?? '攝影機'}）:文字帶頂緣在鏡頭下方 ≈ ${
                (pxToCm96dpi(gaze.offsetPx ?? 0)).toFixed(1)
              } cm,視線偏角 ${gazeOffsetDeg(
                gaze.offsetPx ?? 0,
                settings.personal.profile?.viewingDistanceCm ?? DEFAULT_VIEWING_DISTANCE_CM
              ).toFixed(1)}°（臉距 ${
                settings.personal.profile?.viewingDistanceCm ?? DEFAULT_VIEWING_DISTANCE_CM
              } cm${settings.personal.profile ? '' : ',未校準預設'}）`
            )}
          </div>
        </div>
        <Slider label="字體大小" value={o.fontSize} min={16} max={72} step={2} unit="px" onChange={(v) => patchO({ fontSize: v })} />
        <Slider label="滾動速度" value={o.speed} min={10} max={600} step={10} unit=" px/s" onChange={(v) => patchO({ speed: v })} />
        <Slider label="語速倍率" value={o.rate} min={0.5} max={3} step={0.1} unit="×" onChange={(v) => patchO({ rate: Math.round(v * 10) / 10 })} />
        <Slider label="行距" value={o.lineHeight} min={1.1} max={2.4} step={0.1} onChange={(v) => patchO({ lineHeight: v })} />
        <Slider label="不透明度" value={o.opacity} min={0.15} max={1} step={0.01} onChange={(v) => patchO({ opacity: v })} />
        <Switch label="鏡像模式" hint="透過反射罩拍攝時使用（左右翻轉）" checked={o.mirror} onChange={(v) => patchO({ mirror: v })} />
        <Switch
          label="玻璃折射"
          hint="面板邊緣折射背後的桌面，液態玻璃的來源（Liquid Glass）。不用系統毛玻璃材質：那種材質是畫在整個視窗矩形上的，會在面板四個圓角外露出方形補丁"
          checked={o.glass}
          onChange={(v) => patchO({ glass: v })}
        />
        <Switch
          label="該你說話了提示"
          hint="會議轉錄中偵測到對方講完問句或長段時，浮層即時提醒你接話（turn-yield，需搭配錄音轉錄頁的系統音訊）。這一種是救場用的,不受教練靜默影響"
          checked={o.turnYield}
          onChange={(v) => patchO({ turnYield: v })}
        />
        <Switch
          label="即時教練"
          hint="會議/練習轉錄中偵測語速過快、填充詞過多、搶話、冷場、獨白過長，浮層即時提醒（語速基準取自個人化校準）。會議中想關掉其中一項,直接點提示條上的提示即可,只靜默到本場結束,不會影響「該你說話了」"
          checked={o.coaching}
          onChange={(v) => patchO({ coaching: v })}
        />
        <Switch label="螢幕擷取隱形" hint="開啟後，視訊軟體分享畫面與錄影都看不到浮層" checked={o.captureProtected} onChange={(v) => window.api.overlaySetCaptureProtection(v)} />
        <div>
          <button
            className="btn-outline text-xs"
            onClick={async () => {
              setSimBusy(true)
              setSimDataUrl(null)
              try {
                const res = await window.api.shareSimulation()
                if (res.ok && res.dataUrl) setSimDataUrl(res.dataUrl)
                else toast.error(res.error ?? '擷取失敗')
              } finally {
                setSimBusy(false)
              }
            }}
            disabled={simBusy}
          >
            {simBusy ? <Loader2 size={13} className="animate-spin" /> : <ScanEye size={13} />}
            分享前模擬測試
          </button>
          <div className="mt-1.5 text-[11px] text-ink-400">
            擷取主螢幕縮圖給你看「視訊軟體實際分享到的畫面」— 浮層不應出現;有出現代表擷取保護未生效。
          </div>
          {simDataUrl && (
            <div className="anim-rise mt-2 overflow-hidden rounded-xl border border-white/10">
              <img src={simDataUrl} alt="螢幕擷取模擬" className="w-full" />
              <div className="bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-400">
                若浮層沒有出現在上方截圖,隱形即生效 ✓
              </div>
            </div>
          )}
        </div>
        <Switch label="滑鼠穿透" hint="滑鼠點擊直接穿過浮層操作底下的視窗;熱鍵或「提詞」按鈕重新顯示浮層時會自動解除" checked={o.clickThrough} onChange={(v) => window.api.overlaySetClickThrough(v)} />
        <Switch label="永遠置頂" checked={o.alwaysOnTop} onChange={(v) => patchO({ alwaysOnTop: v })} />
      </Section>

      <Section id="stt" title="語音辨識" desc="本地 Whisper 完全離線免費；雲端更快更準">
        <div>
          <div className="label">引擎</div>
          <div className="flex gap-2">
            {(
              [
                { id: 'local', label: '本地 Whisper（離線）' },
                { id: 'cloud', label: '雲端 API' }
              ] as const
            ).map((e) => (
              <button
                key={e.id}
                data-effect-id="stt-engine"
                onClick={() => update({ stt: { engine: e.id } })}
                className={cn(
                  'flex-1 rounded-lg border px-3 py-2.5 text-sm transition-colors cursor-pointer',
                  settings.stt.engine === e.id
                    ? 'border-accent-500 bg-accent-500/10 text-ink-100'
                    : 'border-ink-700 text-ink-300 hover:border-ink-600'
                )}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="label">本地模型</div>
            <select
              aria-label="本地模型"
              className="input"
              value={settings.stt.localModel}
              onChange={(e) => update({ stt: { localModel: e.target.value as AppSettings['stt']['localModel'] } })}
            >
              <option value="tiny">tiny — 最快（~75MB）</option>
              <option value="base">base — 均衡（~145MB）</option>
              <option value="small">small — 最準（~500MB）</option>
            </select>
          </div>
          <div>
            <div className="label">語言</div>
            <select
              aria-label="語言"
              className="input"
              value={settings.stt.language}
              onChange={(e) => update({ stt: { language: e.target.value } })}
            >
              <option value="zh">繁體中文</option>
              <option value="en">English</option>
              <option value="auto">自動偵測</option>
            </select>
          </div>
        </div>
        {settings.stt.engine === 'cloud' && (
          <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-850/60 p-4">
            <div className="text-[11px] text-ink-400">
              相容 OpenAI /v1/audio/transcriptions 介面的服務皆可（例如 Groq 免費額度：https://api.groq.com/openai/v1 + whisper-large-v3）
            </div>
            <div>
              <div className="label">API Base URL</div>
              {/*
                data-effect-id:這一頁有**兩組**「API Base URL / API Key / 模型」
                (雲端辨識一組、AI 助理一組),可及名稱完全一樣。
                用名稱當身分的話,探針的 `.first()` 永遠只會拿到前一個 ——
                實際發生過:填進辨識的金鑰、斷言 AI 的金鑰,於是量到「打完金鑰
                資料層還是 null」,一顆好的控制項被記成壞的。
              */}
              <input
                data-effect-id="stt-base-url"
                aria-label="API Base URL" className="input"
                value={settings.stt.cloud.baseUrl}
                onChange={(e) => update({ stt: { cloud: { baseUrl: e.target.value } } })}
                placeholder="https://api.groq.com/openai/v1"
              />
            </div>
            <div>
              <div className="label">API Key</div>
              <input
                data-effect-id="stt-api-key"
                aria-label="API Key" className="input"
                type="password"
                value={sttApiKey}
                disabled={!secureKeysLoaded}
                onChange={(e) => {
                  setSttApiKey(e.target.value)
                  saveSecureKey('sttApiKey', e.target.value)
                }}
                onBlur={(e) => flushSecureKey('sttApiKey', e.target.value)}
                placeholder="gsk_..."
              />
              <KeyStatus loading={!secureKeysLoaded} note={secureKeysNote} />
            </div>
            <div>
              <div className="label">模型</div>
              <input
                data-effect-id="stt-model"
                aria-label="模型" className="input"
                value={settings.stt.cloud.model}
                onChange={(e) => update({ stt: { cloud: { model: e.target.value } } })}
                placeholder="whisper-large-v3"
              />
            </div>
          </div>
        )}
      </Section>

      <Section
        id="preflight"
        title="開始之前"
        desc="這台電腦還差什麼。AI 模型與語音辨識都備妥之前,練習與摘要會失敗 —— 在那之前先講清楚。"
      >
        {/* 「都準備好了」那句話由 PreflightCard 自己畫(見該檔對 visible.length===0
            的處理):本地 STT 的下載提示永遠存在,所以讓呼叫端另外判斷「要不要顯示
            已就緒」會讓兩句互相矛盾的話並排。 */}
        <PreflightCard variant="full" onNavigate={onNavigate} />
      </Section>

      <Section id="ai" title="AI 助理" desc="面試練習出題與反饋、會議摘要生成">
        <div>
          <div className="label">供應商</div>
          <div className="flex gap-2">
            {(
              [
                { id: 'ollama', label: 'Ollama（本地免費）' },
                { id: 'openai-compatible', label: 'OpenAI 相容 API' }
              ] as const
            ).map((p) => (
              <button
                key={p.id}
                data-effect-id="provider"
                onClick={() => update({ ai: { provider: p.id } })}
                className={cn(
                  'flex-1 rounded-lg border px-3 py-2.5 text-sm transition-colors cursor-pointer',
                  settings.ai.provider === p.id
                    ? 'border-accent-500 bg-accent-500/10 text-ink-100'
                    : 'border-ink-700 text-ink-300 hover:border-ink-600'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {settings.ai.provider === 'ollama' ? (
          <div className="space-y-3">
            <div>
              <div className="label">Ollama 位址</div>
              <div className="flex gap-2">
                <input
                  aria-label="Ollama 位址" className="input flex-1"
                  value={settings.ai.ollama.baseUrl}
                  onChange={(e) => update({ ai: { ollama: { baseUrl: e.target.value } } })}
                  placeholder="http://localhost:11434"
                />
                <button className="btn-outline shrink-0 text-xs" onClick={testOllama} disabled={testing}>
                  {testing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  測試連線
                </button>
              </div>
            </div>
            {testError && (
              // 失敗訊息是**行內**的，不是 toast —— 使用者按了「測試連線」之後
              // 畫面上唯一變的是這一行。稽核原本只看 toast，於是量到
              // 「按下去沒有任何失敗訊息」；實際上訊息一直都在。
              // 給它一個穩定 id：文字內容會隨 describeError 改寫，
              // 用 class 或文字比對都不是穩定的身分。
              <div data-effect-id="ollama-test-error" className="text-xs leading-relaxed text-rose-450">
                {testError}
              </div>
            )}
            {models && models.length > 0 && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 text-xs text-emerald-400">
                  <Check size={13} /> Ollama v{ollamaVersion}，{models.length} 個模型
                </div>
                <select
                  // 名稱來自選項(下載了哪些模型),會隨環境變 —— 用穩定 id。
                  data-effect-id="ollama-model"
                  aria-label="Ollama 模型"
                  className="input flex-1"
                  value={settings.ai.ollama.model}
                  onChange={(e) => update({ ai: { ollama: { model: e.target.value } } })}
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-850/60 p-4">
            <div>
              <div className="label">API Base URL</div>
              <input
                data-effect-id="ai-base-url"
                aria-label="API Base URL" className="input"
                value={settings.ai.openaiCompatible.baseUrl}
                onChange={(e) => update({ ai: { openaiCompatible: { baseUrl: e.target.value } } })}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <div className="label">API Key</div>
              <input
                data-effect-id="ai-api-key"
                aria-label="API Key" className="input"
                type="password"
                value={aiApiKey}
                disabled={!secureKeysLoaded}
                onChange={(e) => {
                  setAiApiKey(e.target.value)
                  saveSecureKey('apiKey', e.target.value)
                }}
                onBlur={(e) => flushSecureKey('apiKey', e.target.value)}
              />
              <KeyStatus loading={!secureKeysLoaded} note={secureKeysNote} />
            </div>
            <div>
              <div className="label">模型</div>
              <input
                data-effect-id="ai-model"
                aria-label="模型" className="input"
                value={settings.ai.openaiCompatible.model}
                onChange={(e) => update({ ai: { openaiCompatible: { model: e.target.value } } })}
                placeholder="gpt-4o-mini"
              />
            </div>
          </div>
        )}

        {/* 場景情境(Panic 救援) */}
        <div>
          <div className="label">場景情境</div>
          <div className="grid grid-cols-4 gap-2">
            {(scenes ?? []).map((s) => (
              <button
                key={s.key}
                data-effect-id="scene"
                onClick={() => update({ scenario: { activeScene: s.key } })}
                title={`${s.label} ・ ${s.tone} ・ 風險 ${s.riskLevel}${s.source !== 'builtin' ? ' ・ ' + s.source : ''}`}
                className={cn(
                  'rounded-lg border px-2 py-2 text-xs transition-colors cursor-pointer',
                  settings.scenario.activeScene === s.key
                    ? 'border-accent-500 bg-accent-500/10 text-ink-100'
                    : 'border-ink-700 text-ink-300 hover:border-ink-600'
                )}
              >
                {sceneLabel(s)}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[11px] text-ink-400">
            決定 Panic 救援的語氣、長度與 fallback 模板;場景包來自 assets/packs。
          </div>
        </div>

        <div>
          <div className="label">Panic 提問 framing</div>
          <div className="flex gap-2">
            {(
              [
                { id: 'interview', label: '面試被問倒' },
                { id: 'meeting', label: '會議中斷/卡詞' }
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                data-effect-id="panic-mode"
                onClick={() => update({ scenario: { panicMode: m.id } })}
                className={cn(
                  'flex-1 rounded-lg border px-3 py-2 text-sm transition-colors cursor-pointer',
                  settings.scenario.panicMode === m.id
                    ? 'border-accent-500 bg-accent-500/10 text-ink-100'
                    : 'border-ink-700 text-ink-300 hover:border-ink-600'
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <Switch
          label="AI 即時救援"
          hint="關閉時 Panic 只給場景模板,不呼叫 AI(省 token、斷網可用)"
          checked={settings.scenario.aiModeEnabled}
          onChange={(v) => update({ scenario: { aiModeEnabled: v } })}
        />
      </Section>

      <Section id="hotkeys" title="快速鍵" desc="全域熱鍵，任何應用程式上方都有效；變更後立即生效">
        <div className="flex gap-6 text-sm">
          <div className="flex-1">
            <div className="label">顯示 / 隱藏浮層</div>
            <select
              className="input"
              value={settings.hotkeys.toggleOverlay}
              aria-label="顯示 / 隱藏浮層"
              onChange={(e) => update({ hotkeys: { toggleOverlay: e.target.value } })}
            >
              {['Control+Alt+T', 'Control+Alt+P', 'Control+Shift+Space', 'Control+Alt+0'].map(
                (k) => (
                  <option key={k} value={k}>
                    {k.replaceAll('Control', 'Ctrl')}
                  </option>
                )
              )}
            </select>
          </div>
          <div className="flex-1">
            <div className="label">隱藏浮層</div>
            <select
              className="input"
              value={settings.hotkeys.hideOverlay}
              aria-label="隱藏浮層"
              onChange={(e) => update({ hotkeys: { hideOverlay: e.target.value } })}
            >
              {['Control+Alt+H', 'Control+Shift+H', 'Control+Alt+9'].map((k) => (
                <option key={k} value={k}>
                  {k.replaceAll('Control', 'Ctrl')}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <div className="label">Panic 救援</div>
            <select
              className="input"
              value={settings.hotkeys.panicRescue}
              aria-label="Panic 救援"
              onChange={(e) => update({ hotkeys: { panicRescue: e.target.value } })}
            >
              {['Alt+P', 'Alt+/', 'F9'].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-6 text-sm">
          <div className="flex-1">
            <div className="label">播放 / 暫停</div>
            <select
              className="input"
              value={settings.hotkeys.playPause}
              aria-label="播放 / 暫停"
              onChange={(e) => update({ hotkeys: { playPause: e.target.value } })}
            >
              {['Alt+K', 'Alt+Space', 'Control+Alt+S'].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <div className="label">語速 +/−</div>
            <div className="flex items-center gap-2">
              <select
                className="input"
                value={settings.hotkeys.speedUp}
                aria-label="加快語速"
                onChange={(e) => update({ hotkeys: { speedUp: e.target.value } })}
              >
                {['Alt+Up', 'Control+Alt+Up'].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={settings.hotkeys.speedDown}
                aria-label="減慢語速"
                onChange={(e) => update({ hotkeys: { speedDown: e.target.value } })}
              >
                {['Alt+Down', 'Control+Alt+Down'].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        {(() => {
          // 衝突偵測:兩顆熱鍵設同一組合時,全域註冊會互相覆蓋(後註冊的贏)。
          // 在這裡指出來,勝過使用者發現「按了沒反應」。空字串 = 未設定,不參與。
          const entries = Object.entries(settings.hotkeys).filter(([, v]) => v !== '')
          const seen = new Map<string, string>()
          const dupes: string[] = []
          for (const [name, key] of entries) {
            const prev = seen.get(key)
            if (prev) dupes.push(`${prev} 與 ${HOTKEY_LABELS[name] ?? name}（${key}）`)
            else seen.set(key, HOTKEY_LABELS[name] ?? name)
          }
          if (dupes.length === 0) return null
          return (
            <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              熱鍵衝突：{dupes.join('、')}。衝突時只有一顆會生效,請把其中一顆改成其他組合。
            </div>
          )
        })()}
        {hotkeyConflicts.length > 0 && (
          // 紅色而不是琥珀色：這不是「兩顆熱鍵打架、只有一顆生效」，
          // 是「這顆熱鍵完全沒有作用」。使用者的實際體驗是按了沒反應，
          // 而上面那段重複偵測看不到這種情況(它只比對自己跟自己)。
          <div
            role="alert"
            className="mt-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
          >
            <div className="font-semibold">有 {hotkeyConflicts.length} 顆熱鍵沒有註冊成功，按了不會有反應。</div>
            <ul className="mt-1 space-y-0.5">
              {hotkeyConflicts.map((k) => {
                // 反查是哪個功能 —— 只寫「Alt+P」使用者還要自己猜是哪一顆。
                const owner = Object.entries(settings.hotkeys).find(([, v]) => v === k)
                return (
                  <li key={k}>
                    <span className="font-mono">{k.replaceAll('Control', 'Ctrl')}</span>
                    {owner && <> — {HOTKEY_LABELS[owner[0]] ?? owner[0]}</>}
                  </li>
                )
              })}
            </ul>
            <div className="mt-1 text-rose-200/80">
              這些組合已被其他程式佔用（常見於常駐軟體或視窗管理器）。請把對應的下拉改成**其他**組合 —— 上面列的這幾顆已經按了不會有反應,選它們沒有用。
            </div>
          </div>
        )}
        <div className="mt-1.5 text-[11px] text-ink-400">
          語速步進每次 ±0.1×（0.5–3×）；熱鍵在浮層隱藏或滑鼠穿透時也有效。
        </div>
      </Section>

      {/* 放在備份**之前**:信任問題先於資料操作。
          使用者要先把「這份備份裡會有什麼、會送到哪裡」看清楚,才會按下匯出;
          順序相反時,匯出那顆鈕在畫面上比「資料去了哪裡」更搶眼。 */}
      <Section
        id="data-trust"
        title="你的資料去了哪裡"
        desc="下面每一列都根據目前的設定算出來。改設定之後它會跟著變。"
      >
        <DataTrustPanel variant="full" />
      </Section>

      <Section
        id="backup"
        title="資料備份"
        desc="把講稿、會議紀錄與練習紀錄整份帶走。換電腦或重灌前先匯出一次。"
      >
        <BackupSection />
      </Section>

      <Section id="troubleshoot" title="疑難排解" desc="遇到問題時，日誌是回報與自查的第一手資料">
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-outline text-xs" onClick={() => void window.api.openLogDir()}>
            開啟記錄資料夾
          </button>
          <button
            data-effect-id="copy-diagnostics"
            className="btn-outline text-xs"
            onClick={() => void copyDiagnostics()}
            title="把版本、平台、設定摘要與最近的錯誤碼複製成一段文字,貼到回報問題的地方"
          >
            複製診斷報告
          </button>
        </div>
        <div className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
          main.log 記錄啟動、未捕捉例外、結構化錯誤碼與前端錯誤（輪替保留 3 檔）。
          <span className="mt-0.5 block text-ink-500">
            診斷報告只含版本、平台、設定旗標與錯誤碼 —— <strong className="text-ink-400">不含逐字稿、講稿內容與 API 金鑰</strong>。
            這是刻意的:報告唯一的傳遞方式是貼到公開的問題回報裡,寫進去的東西必須假設它會離開這台電腦。
          </span>
        </div>
      </Section>
    </div>
  )
}
