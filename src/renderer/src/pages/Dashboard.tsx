import type { JSX } from "react"
import { useEffect, useState } from 'react'
import { AudioLines, Check, Circle, Eye, GraduationCap, Play, Ruler, ScrollText, TrendingUp } from 'lucide-react'
import { db } from '../lib/db'
import type { MeetingSession, PracticeRun, Script } from '@shared/types'
import { formatDateTime } from '../lib/utils'
import { useSettings } from '../lib/store'
import { analyzePracticeRun } from '../lib/session-intelligence'
import { PreflightCard } from '../components/PreflightCard'

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
      const withReport = scanned.filter((s) => s.report)
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

  const launchLatest = async (): Promise<void> => {
    const s = recent[0]
    if (!s) return
    await db.scripts.update(s.id!, { lastUsedAt: Date.now() })
    await window.api.overlayShow({ title: s.title, content: s.content })
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
        <PreflightCard variant="compact" onNavigate={onNavigate} />
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
          <div className="text-xs text-ink-400">
            還沒有講稿——到「提詞講稿」頁建立第一份吧。
          </div>
        )}
        {settings && (
          <div className="mt-3 border-t border-ink-800 pt-3 text-[11px] text-ink-400">
            浮層熱鍵 {settings.hotkeys.toggleOverlay} · 隱藏 {settings.hotkeys.hideOverlay} ·
            螢幕擷取隱形 {settings.overlay.captureProtected ? '開' : '關'}
          </div>
        )}
      </div>

      {/* 首用三部曲:任一步未完成時顯示 */}
      {(() => {
        const hasScript = recent.length > 0
        const hasProfile = !!settings?.personal?.profile
        const hasRun = totals.sessions > 0 || totals.runs > 0
        if (hasScript && hasProfile && hasRun) return null
        const steps = [
          { done: hasScript, icon: ScrollText, label: '建立第一份講稿', target: 'scripts' as const },
          { done: hasProfile, icon: Ruler, label: '個人化校準(語速+視距)', target: 'calibration' as const },
          { done: hasRun, icon: AudioLines, label: '跑一場錄音轉錄或面試練習', target: 'record' as const }
        ]
        return (
          <div className="mt-8 card p-5">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium">
              <TrendingUp size={15} className="text-accent-400" />
              開始三部曲
            </div>
            <div className="grid grid-cols-3 gap-3">
              {steps.map((s) => (
                <button
                  key={s.label}
                  onClick={() => onNavigate(s.target)}
                  className={
                    s.done
                      ? 'flex items-center gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3 py-3 text-left text-xs text-ink-300 cursor-default'
                      : 'flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/4 px-3 py-3 text-left text-xs text-ink-100 transition-colors hover:border-accent-500/50 hover:bg-accent-500/8 cursor-pointer'
                  }
                >
                  {s.done ? (
                    <Check size={15} className="shrink-0 text-emerald-400" />
                  ) : (
                    <Circle size={15} className="shrink-0 text-ink-400" />
                  )}
                  <s.icon size={14} className="shrink-0 text-ink-300" />
                  <span className="leading-snug">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )
      })()}

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
                  onClick={async () => {
                    await db.scripts.update(s.id!, { lastUsedAt: Date.now() })
                    await window.api.overlayShow({ title: s.title, content: s.content })
                  }}
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
