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
import { cn, formatDateTime } from '../lib/utils'
import type { AppSettings } from '@shared/types'
import type { SceneSummary } from '@shared/api'
import { Segmented } from '../components/Segmented'
import { BackupSection } from '../components/BackupSection'
import { PreflightCard } from '../components/PreflightCard'

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

function Section({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="card p-6">
      <div className="mb-5">
        <div className="eyebrow">{title}</div>
        {desc && <div className="mt-0.5 text-xs text-ink-400">{desc}</div>}
      </div>
      <div className="space-y-5">{children}</div>
    </div>
  )
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
  const [testing, setTesting] = useState(false)
  const [aiApiKey, setAiApiKey] = useState('')
  const [sttApiKey, setSttApiKey] = useState('')
  const [secureKeysLoaded, setSecureKeysLoaded] = useState(false)
  const secureKeysRef = useRef<Record<string, unknown>>({})
  const pendingKeysRef = useRef<Partial<Record<'apiKey' | 'sttApiKey', string>>>({})
  const keyTimersRef = useRef<Partial<Record<'apiKey' | 'sttApiKey', ReturnType<typeof setTimeout>>>>({})
  const keyWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  const [models, setModels] = useState<string[] | null>(null)
  const [ollamaVersion, setOllamaVersion] = useState<string | null>(null)
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null)
  const [simBusy, setSimBusy] = useState(false)
  const [simDataUrl, setSimDataUrl] = useState<string | null>(null)

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
  const [hotkeyConflicts, setHotkeyConflicts] = useState<string[]>([])

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
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api
        .appInfo()
        .then((info) => {
          if (alive) setHotkeyConflicts(info.hotkeyConflicts ?? [])
        })
        .catch(() => {
          if (alive) setHotkeyConflicts([])
        })
    }
    load()
    // 熱鍵任一項改變 → main 重新註冊 → 衝突名單可能完全不同了
    const sig = JSON.stringify(settings?.hotkeys ?? null)
    const id = setTimeout(load, 400) // 等 main 重新註冊完再問
    return () => {
      alive = false
      clearTimeout(id)
      void sig
    }
  }, [settings?.hotkeys])

  // 場景清單(場景情境那張卡片的資料來源)。
  // **這行是被我自己弄丟過的**:加入上面那個 hotkeyConflicts effect 時,
  // 我用它當錨點做替換,把這整個 useEffect 一起刪掉了。型別檢查完全沒報錯
  // (scenes 只是永遠保持 null,`scenes ?? []` 讓它安靜地渲染成空),
  // 是 audit:effects 報「只找到 0 個情境按鈕」才發現。
  // 刪掉別的 effect 時要用「插入」而不是「拿它當替換錨點」。
  useEffect(() => {
    void window.api.sceneList().then(setScenes).catch(() => setScenes([]))
  }, [])

  useEffect(() => {
    if (!settings) return
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
            : settings.ai.openaiCompatible.apiKey
      )
      setSttApiKey(
        typeof pending.sttApiKey === 'string'
          ? pending.sttApiKey
          : typeof stored.sttApiKey === 'string'
            ? stored.sttApiKey
            : settings.stt.cloud.apiKey
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
  }, [settings?.ai.openaiCompatible.apiKey, settings?.stt.cloud.apiKey])
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

  if (!settings) return <div className="p-8 text-sm text-ink-400">載入中…</div>

  const o = settings.overlay
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

      <Section title="個人化校準" desc="以你的眼距與語速自動產生字級、滾動速度與預估時長">
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

      <Section title="提詞浮層" desc="外觀與行為，變更即時生效">
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
        <Slider label="字體大小" value={o.fontSize} min={16} max={72} step={2} unit="px" onChange={(v) => patchO({ fontSize: v })} />
        <Slider label="滾動速度" value={o.speed} min={10} max={600} step={10} unit=" px/s" onChange={(v) => patchO({ speed: v })} />
        <Slider label="語速倍率" value={o.rate} min={0.5} max={3} step={0.1} unit="×" onChange={(v) => patchO({ rate: Math.round(v * 10) / 10 })} />
        <Slider label="行距" value={o.lineHeight} min={1.1} max={2.4} step={0.1} onChange={(v) => patchO({ lineHeight: v })} />
        <Slider label="不透明度" value={o.opacity} min={0.15} max={1} step={0.01} onChange={(v) => patchO({ opacity: v })} />
        <Switch label="鏡像模式" hint="透過反射罩拍攝時使用（左右翻轉）" checked={o.mirror} onChange={(v) => patchO({ mirror: v })} />
        <Switch
          label="毛玻璃質感"
          hint="展開面板啟用 Windows 11 acrylic 毛玻璃;藥丸與貼鏡固定使用內建玻璃質感(避免圓角外露出系統磨砂)。舊系統自動退回半透明"
          checked={o.glass}
          onChange={(v) => patchO({ glass: v })}
        />
        <Switch
          label="該你說話了提示"
          hint="會議轉錄中偵測到對方講完問句或長段時，浮層即時提醒你接話（turn-yield，需搭配錄音轉錄頁的系統音訊）"
          checked={o.turnYield}
          onChange={(v) => patchO({ turnYield: v })}
        />
        <Switch
          label="即時教練"
          hint="會議/練習轉錄中偵測語速過快、填充詞過多、搶話、冷場、獨白過長，浮層即時提醒（語速基準取自個人化校準）"
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

      <Section title="語音辨識" desc="本地 Whisper 完全離線免費；雲端更快更準">
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
        title="開始之前"
        desc="這台電腦還差什麼。AI 模型與語音辨識都備妥之前,練習與摘要會失敗 —— 在那之前先講清楚。"
      >
        {/* 「都準備好了」那句話由 PreflightCard 自己畫(見該檔對 visible.length===0
            的處理):本地 STT 的下載提示永遠存在,所以讓呼叫端另外判斷「要不要顯示
            已就緒」會讓兩句互相矛盾的話並排。 */}
        <PreflightCard variant="full" onNavigate={onNavigate} />
      </Section>

      <Section title="AI 助理" desc="面試練習出題與反饋、會議摘要生成">
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

      <Section title="快速鍵" desc="全域熱鍵，任何應用程式上方都有效；變更後立即生效">
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
              熱鍵衝突：{dupes.join('、')}，衝突時只有一顆會生效，請改開。
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
              這些組合已被其他程式佔用（常見於常駐軟體或視窗管理器）。請把對應的下拉改成上面列的組合。
            </div>
          </div>
        )}
        <div className="mt-1.5 text-[11px] text-ink-400">
          語速步進每次 ±0.1×（0.5–3×）；熱鍵在浮層隱藏或滑鼠穿透時也有效。
        </div>
      </Section>

      <Section
        title="資料備份"
        desc="把講稿、會議紀錄與練習紀錄整份帶走。換電腦或重灌前先匯出一次。"
      >
        <BackupSection />
      </Section>

      <Section title="疑難排解" desc="遇到問題時，日誌是回報與自查的第一手資料">
        <button
          className="btn-outline text-xs"
          onClick={() => void window.api.openLogDir()}
        >
          開啟記錄資料夾
        </button>
        <div className="mt-1.5 text-[11px] text-ink-400">
          main.log 記錄啟動、未捕捉例外與前端錯誤（輪替保留 3 檔）；回報問題時附上最新的它最有幫助。
        </div>
      </Section>
    </div>
  )
}
