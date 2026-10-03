import type { JSX } from "react"
import { useEffect, useState } from 'react'
import { AudioLines, Eye, GraduationCap, Play, ScrollText, Sparkles, TrendingUp } from 'lucide-react'
import { db } from '../lib/db'
import type { MeetingSession, PracticeRun, Script } from '@shared/types'
import { formatDateTime } from '../lib/utils'
import { useSettings } from '../lib/store'
import { analyzePracticeRun } from '../lib/session-intelligence'
import { toast } from '../lib/toast'
import { markPromptSucceeded } from '../lib/onboarding'
import { DEMO_SCRIPT_CONTENT, DEMO_SCRIPT_TITLE } from '../lib/demoScript'
import { PreflightCard } from '../components/PreflightCard'
import { FirstRunSteps } from '../components/FirstRunSteps'
import type { PreflightResult } from '../lib/preflight'

interface Props {
  onNavigate: (page: 'dashboard' | 'scripts' | 'record' | 'practice' | 'calibration' | 'settings') => void
}

/**
 * 累計統計的掃描上限。
 *
 * 為什麼不能直接用「最近 10 場」那一份算:整頁原本只查 limit(10),場數、總分鐘、
 * 練習次數全部從它推導 —— 於是第 11 場之後「會議場數」就固定在 10,「共 N 分鐘」
 * 只算最近 10 場,「共 N 次練習」永遠顯示 10,趨勢圖也靜默地丟掉更早的紀錄。
 * 這是儀表板平靜地顯示錯誤歷史的那一種 bug:數字看起來很正常,只是不再變了。
 *
  * 個人使用的量級十年也到不了 500,所以用「精確 count() + 有上限的掃描」就足夠,
 * 不必為此新增索引欄位;真的超過時文案會自己改成「最近 500 場」而不是說謊。
 */
const HISTORY_CAP = 500

const MODES = [
  {
    id: 'scripts' as const,
    icon: ScrollText,
    title: '提詞浮層',
    desc: '講稿平滑滾動、置頂顯示、可隱形於螢幕分享',
    tint: 'from-accent-500 to-accent-600'
  },
  {
    id: 'record' as const,
    icon: AudioLines,
    title: '錄音轉錄',
    desc: '會議即時逐字稿，AI 自動生成摘要與待辦',
    tint: 'from-emerald-500 to-teal-600'
  },
  {
    id: 'practice' as const,
    icon: GraduationCap,
    title: '面試練習',
    desc: 'AI 出題並朗讀，針對你的回答給出反饋評分',
    tint: 'from-orange-500 to-rose-500'
  }
]

/** 輕量 SVG 折線(無圖表庫依賴);value 範圍自動正規化 */
function Sparkline({ values, stroke }: { values: number[]; stroke: string }): JSX.Element | null {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 120
  const h = 32
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - 3 - ((v - min) / span) * (h - 6)}`)
    .join(' ')
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export default function Dashboard({ onNavigate }: Props): JSX.Element {
  const [recent, setRecent] = useState<Script[]>([])
  /** 最近的會議紀錄(趨勢圖用) */
  const [sessions, setSessions] = useState<MeetingSession[]>([])
  /** 最近的練習紀錄(趨勢圖用) */
  const [runs, setRuns] = useState<PracticeRun[]>([])
  /** 累計統計:與上面的「最近 N 筆」分開,見 HISTORY_CAP 的説明 */
  const [totals, setTotals] = useState({
    sessions: 0,
    runs: 0,
    minutes: 0,
    minutesCapped: false,
    avgTalkRatio: null as number | null
  })
  /**
   * preflight 的判定結果,餵給「3 分鐘上手」卡片。
   *
   * 放在這裡而不是讓上手卡片自己去查:preflight 的探測邏輯(連 Ollama、
   * 讀 safeStorage)已經有一份實作,再寫一份一定會漂移。理由見
   * PreflightCardProps.onResult 的註解。
   */
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null)
  /** 範例稿正在建立中:擋連點(建立講稿 + 開浮層是兩次 IPC,連點會建出兩份) */
  const [demoBusy, setDemoBusy] = useState(false)
  const { settings, overlayVisible } = useSettings()

  useEffect(() => {
    void (async () => {
      const [recentScripts, recentSessions, recentRuns, sessionCount, runCount] = await Promise.all([
        db.scripts.orderBy('updatedAt').reverse().limit(4).toArray(),
        db.sessions.orderBy('startedAt').reverse().limit(10).toArray(),
        db.practiceRuns.orderBy('createdAt').reverse().limit(10).toArray(),
        db.sessions.count(),
        db.practiceRuns.count()
      ])
      setRecent(recentScripts)
      setSessions(recentSessions)
      setRuns(recentRuns)
      const scanned = await db.sessions.orderBy('startedAt').reverse().limit(HISTORY_CAP).toArray()
      const withReport = scanned.filter((s) => s.report && s.report.talkRatioAvailable !== false)
      setTotals({
        sessions: sessionCount,
        runs: runCount,
        minutes: Math.round(scanned.reduce((a, s) => a + (s.report?.durationSec ?? 0), 0) / 60),
        minutesCapped: sessionCount > scanned.length,
        avgTalkRatio:
          withReport.length > 0
            ? Math.round((withReport.reduce((a, s) => a + (s.report?.talkRatio ?? 0), 0) / withReport.length) * 100)
            : null
      })
    })()
  }, [])

  /**
   * 開浮層的唯一入口:總覽頁有兩個地方會開(上方「開始提詞」與下方清單每列的
   * 「提詞」),行為必須一致 —— 空稿(例如剛建立的「未命名講稿」)不開空浮層,
   * 引導回講稿頁先寫內容。原本只有 launchLatest 有檢查,清單那排照樣開出空浮層。
   */
  const launchScript = async (s: Script): Promise<void> => {
    if (!s.content.trim()) {
      toast.info('這份講稿還是空的——先到「提詞講稿」寫點內容再開始提詞。')
      onNavigate('scripts')
      return
    }
    await db.scripts.update(s.id!, { lastUsedAt: Date.now() })
    await window.api.overlayShow({ scriptId: s.id, title: s.title, content: s.content })
    // 第一段提詞成功。標記在**真的 show 成功之後**,不是按下鈕時 ——
    // 這個旗標是「達成」的證明,提前寫等於把一次失敗也算成完成。
    markPromptSucceeded()
  }

  const launchLatest = async (): Promise<void> => {
    const s = recent[0]
    if (!s) return
    await launchScript(s)
  }

  /**
   * 首用入口:用內建範例稿開一次浮層(與講稿頁空狀態那顆同一件事)。
   *
   * 為什麼總覽頁也要有:沒有講稿時,這張卡片原本只寫「到『提詞講稿』頁建立
   * 第一份吧」—— 而浮層需要一份**有內容**的講稿才會出現(空稿刻意不開)。
   * 於是這個產品的門面在「使用者自己寫出一份稿」之前是看不到的,而那與
   * preflight.ts / onboarding.ts 檔頭寫的「不擋只想看看浮層長什麼樣的人」
   * 直接衝突:不擋路的代價不該是「看不到」。
   */
  const loadDemoScript = async (): Promise<void> => {
    if (demoBusy) return
    setDemoBusy(true)
    try {
      const now = Date.now()
      const id = await db.scripts.add({
        title: DEMO_SCRIPT_TITLE,
        content: DEMO_SCRIPT_CONTENT,
        createdAt: now,
        updatedAt: now
      })
      // 走既有那條「開浮層」的路(守衛、lastUsedAt、里程碑旗標都在裡面),
      // 不另外寫一份 —— 兩份開浮層的程式碼遲早分叉。
      await launchScript({
        id,
        title: DEMO_SCRIPT_TITLE,
        content: DEMO_SCRIPT_CONTENT,
        createdAt: now,
        updatedAt: now
      })
      // 導到講稿頁:範例稿是一份真的稿子,使用者會在那裡找到它並改成自己的內容。
      onNavigate('scripts')
      toast.info('已建立範例講稿 —— 它是真的稿子,可以直接改成你自己的內容。')
    } finally {
      setDemoBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">歡迎回來</h1>
        <p className="mt-1 text-sm text-ink-300">三大模式，隨時待命。</p>
      </div>

      {/* 第一次使用前就把「這台電腦還差什麼」講出來。
          為什麼在總覽頁而不是入口的強制精靈:`ollama pull qwen2.5:7b` 這句話
          原本只在**失敗之後**才出現,而這是個桌面 App —— 看到一句要他在終端機
          打的指令、而前面沒有任何說明,他就再也不會打開了。
          而擋路的精靈會讓只想看浮層長什麼樣的人永遠進不去,所以這裡是提示、
          不是關卡。判斷在 lib/preflight.ts。 */}
      <div className="mb-5">
        <PreflightCard variant="compact" onNavigate={onNavigate} onResult={setPreflightResult} />
      </div>

      {/* 首用「3 分鐘上手」:三步全部可見、可完成,但不擋路。
          位置在 preflight **之下**是刻意的:preflight 講的是「AI 還差什麼」
          (一個問題清單),上手卡片講的是「你走到第幾步」(一個進度)。先讓
          使用者看見缺什麼(那是阻擋級),再看見自己走了多遠。
          判斷在 lib/onboarding.ts,為什麼不做成精靈見該檔檔頭第一點。 */}
      <div className="mb-5">
        <FirstRunSteps
          micEverWorked={totals.sessions > 0 || totals.runs > 0}
          preflight={preflightResult}
          hasScript={recent.some((s) => !!s.content.trim())}
          // 校準不在三步裡,但它決定字級與滾動速度 —— 沒有它,浮層會用手感
          // 不對的預設值跑(原本這是「開始三部曲」的第二張卡在提醒的事)。
          needsCalibration={!settings?.personal?.profile}
          onNavigate={onNavigate}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        {MODES.map((m) => (
          <button
            key={m.id}
            // data-effect-id:這張卡的可及名稱是「標題 + 說明」的長字串,而說明文案
            // 改一次就會讓稽核的控制項 key 換一個。覆蓋率檢查需要穩定的身分,
            // 否則它會永遠紅著,而永遠紅的檢查等於沒有檢查(見 effect-inventory.mjs)。
            data-effect-id="mode-card"
            onClick={() => onNavigate(m.id)}
            className="card group p-5 text-left transition-all hover:border-ink-600 hover:bg-ink-850 cursor-pointer"
          >
            <div
              className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${m.tint} text-white`}
            >
              <m.icon size={19} />
            </div>
            <div className="font-semibold">{m.title}</div>
            <div className="mt-1 text-xs leading-relaxed text-ink-300">{m.desc}</div>
          </button>
        ))}
      </div>

      <div className="mt-8 card p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Eye size={15} className="text-accent-400" />
            提詞浮層
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              overlayVisible ? 'bg-emerald-500/15 text-emerald-400' : 'bg-ink-800 text-ink-400'
            }`}
          >
            {overlayVisible ? '顯示中' : '隱藏中'}
          </span>
        </div>
        {recent.length > 0 ? (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="truncate text-sm" title={recent[0].title}>
                {recent[0].title}
              </div>
              <div className="text-[11px] text-ink-400">
                最近編輯 {formatDateTime(recent[0].updatedAt)}
              </div>
            </div>
            <button className="btn-primary shrink-0" onClick={launchLatest}>
              <Play size={14} /> 開始提詞
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="text-xs leading-relaxed text-ink-400">
              還沒有講稿 —— 浮層需要一份有內容的講稿才會出現,所以先用範例稿看它長什麼樣吧。
            </div>
            <button
              data-effect-id="demo-script"
              className="btn-primary text-xs"
              disabled={demoBusy}
              onClick={() => void loadDemoScript()}
            >
              <Sparkles size={14} /> 載入範例講稿並試提詞
            </button>
          </div>
        )}
        {settings && (
          <div className="mt-3 border-t border-ink-800 pt-3 text-[11px] text-ink-400">
            {/* 熱鍵正規化與其他頁一致(Control→Ctrl):同一個 App 不要讓
                總覽頁顯示「Control+Alt+T」、其他頁顯示「Ctrl+Alt+T」 */}
            浮層熱鍵 {settings.hotkeys.toggleOverlay.replaceAll('Control', 'Ctrl')} · 隱藏{' '}
            {settings.hotkeys.hideOverlay.replaceAll('Control', 'Ctrl')} ·
            螢幕擷取隱形 {settings.overlay.captureProtected ? '開' : '關'}
          </div>
        )}
      </div>

      {/* 成長軌跡(session intelligence) */}
      {(sessions.length > 0 || runs.length > 0) && (
        <div className="mt-8 card p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium">
            <TrendingUp size={15} className="text-emerald-400" />
            成長軌跡
          </div>
          <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
            <div>
              <div className="text-[10px] text-ink-400">會議場數</div>
              <div className="mt-1 text-2xl font-semibold">{totals.sessions}</div>
              <div className="text-[10px] text-ink-400">
                共 {totals.minutes} 分鐘{totals.minutesCapped ? `（最近 ${HISTORY_CAP} 場）` : ''}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-ink-400">平均發言佔比</div>
              <div className="mt-1 text-2xl font-semibold">
                {totals.avgTalkRatio != null ? `${totals.avgTalkRatio}%` : '—'}
              </div>
              <div className="text-[10px] text-ink-400">目標約 4–6 成</div>
            </div>
            <div>
              <div className="text-[10px] text-ink-400">語速趨勢(字/分)</div>
              <div className="mt-1 flex items-end gap-2">
                <span className="text-2xl font-semibold">
                  {sessions.find((s) => s.report?.myCpm)?.report?.myCpm ?? '—'}
                </span>
                <Sparkline
                  values={[...sessions].reverse().map((s) => s.report?.myCpm ?? 0).filter((v) => v > 0)}
                  stroke="#8f8cfa"
                />
              </div>
              <div className="text-[10px] text-ink-400">最近 {Math.min(sessions.length, 10)} 場</div>
            </div>
            <div>
              <div className="text-[10px] text-ink-400">練習分數趨勢</div>
              {(() => {
                const oldestFirst = [...runs].reverse()
                const scores = oldestFirst.map((r) => analyzePracticeRun(r.answers).scores).filter((s) => s.length > 0).map((s) => Math.round(s.reduce((a, b) => a + b, 0) / s.length))
                const latest = scores.length > 0 ? scores[scores.length - 1] : null
                return (
                  <div className="mt-1 flex items-end gap-2">
                    <span className="text-2xl font-semibold">{latest ?? '—'}</span>
                    <Sparkline values={scores} stroke="#2dd4a7" />
                  </div>
                )
              })()}
              <div className="text-[10px] text-ink-400">共 {totals.runs} 次練習</div>
            </div>
          </div>
        </div>
      )}

      {recent.length > 1 && (
        <div className="mt-8">
          <div className="mb-3 text-sm font-medium text-ink-200">最近的講稿</div>
          <div className="space-y-2">
            {recent.slice(1).map((s) => (
              <div
                key={s.id}
                className="card flex items-center justify-between px-4 py-3 hover:bg-ink-850"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm" title={s.title}>
                    {s.title}
                  </div>
                  <div className="text-[11px] text-ink-400">{formatDateTime(s.updatedAt)}</div>
                </div>
                <button
                  className="btn-ghost shrink-0 text-xs"
                  onClick={() => void launchScript(s)}
                >
                  <Play size={13} /> 提詞
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
