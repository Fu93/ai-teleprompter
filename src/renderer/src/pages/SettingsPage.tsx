import type { JSX } from "react"
import { useEffect, useState } from 'react'
import { Check, Loader2, RefreshCw } from 'lucide-react'
import { useSettings } from '../lib/store'
import { cn } from '../lib/utils'
import type { AppSettings } from '@shared/types'
import type { SceneSummary } from '@shared/api'

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
        <div className="text-sm font-semibold">{title}</div>
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
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between text-left cursor-pointer"
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
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <div>
      <div className="mb-2 flex justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono text-xs text-ink-300">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
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
  const [models, setModels] = useState<string[] | null>(null)
  const [ollamaVersion, setOllamaVersion] = useState<string | null>(null)
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null)

  useEffect(() => {
    void window.api.sceneList().then(setScenes).catch(() => setScenes([]))
  }, [])
  const [testError, setTestError] = useState<string | null>(null)

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
      setTestError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-8 py-8">
      <h1 className="text-xl font-bold">設定</h1>

      <Section title="提詞浮層" desc="外觀與行為，變更即時生效">
        <div>
          <div className="label">顯示模式</div>
          <div className="flex gap-2">
            {(
              [
                { id: 'scroll', label: '連續捲動' },
                { id: 'phrase', label: '逐句短語' },
                { id: 'bullet', label: '重點要點' },
                { id: 'karaoke', label: '逐詞高亮' }
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                onClick={() => patchO({ displayMode: m.id })}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs transition-colors cursor-pointer',
                  o.displayMode === m.id
                    ? 'bg-accent-600 text-white'
                    : 'border border-ink-700 text-ink-300 hover:border-ink-600 hover:bg-ink-850'
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[11px] text-ink-400">
            逐句/逐詞以 120 WPM 為基準推進;重點要點自動切出 Markdown 大綱或段落,手動(← →)翻頁。
          </div>
        </div>
        <Slider label="字體大小" value={o.fontSize} min={16} max={72} step={2} unit="px" onChange={(v) => patchO({ fontSize: v })} />
        <Slider label="滾動速度" value={o.speed} min={10} max={600} step={10} unit=" px/s" onChange={(v) => patchO({ speed: v })} />
        <Slider label="語速倍率" value={o.rate} min={0.5} max={3} step={0.1} unit="×" onChange={(v) => patchO({ rate: Math.round(v * 10) / 10 })} />
        <Slider label="行距" value={o.lineHeight} min={1.1} max={2.4} step={0.1} onChange={(v) => patchO({ lineHeight: v })} />
        <Slider label="不透明度" value={o.opacity} min={0.15} max={1} step={0.01} onChange={(v) => patchO({ opacity: v })} />
        <Switch label="鏡像模式" hint="透過反射罩拍攝時使用（左右翻轉）" checked={o.mirror} onChange={(v) => patchO({ mirror: v })} />
        <Switch label="螢幕擷取隱形" hint="開啟後，視訊軟體分享畫面與錄影都看不到浮層" checked={o.captureProtected} onChange={(v) => window.api.overlaySetCaptureProtection(v)} />
        <Switch label="滑鼠穿透" hint="滑鼠點擊直接穿過浮層操作底下的視窗" checked={o.clickThrough} onChange={(v) => window.api.overlaySetClickThrough(v)} />
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
              className="input"
              value={settings.stt.language}
              onChange={(e) => update({ stt: { language: e.target.value } })}
            >
              <option value="zh">中文</option>
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
              <input
                className="input"
                value={settings.stt.cloud.baseUrl}
                onChange={(e) => update({ stt: { cloud: { baseUrl: e.target.value } } })}
                placeholder="https://api.groq.com/openai/v1"
              />
            </div>
            <div>
              <div className="label">API Key</div>
              <input
                className="input"
                type="password"
                value={settings.stt.cloud.apiKey}
                onChange={(e) => update({ stt: { cloud: { apiKey: e.target.value } } })}
                placeholder="gsk_..."
              />
            </div>
            <div>
              <div className="label">模型</div>
              <input
                className="input"
                value={settings.stt.cloud.model}
                onChange={(e) => update({ stt: { cloud: { model: e.target.value } } })}
                placeholder="whisper-large-v3"
              />
            </div>
          </div>
        )}
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
                  className="input flex-1"
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
            {testError && <div className="text-xs leading-relaxed text-rose-450">{testError}</div>}
            {models && models.length > 0 && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 text-xs text-emerald-400">
                  <Check size={13} /> Ollama v{ollamaVersion}，{models.length} 個模型
                </div>
                <select
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
                className="input"
                value={settings.ai.openaiCompatible.baseUrl}
                onChange={(e) => update({ ai: { openaiCompatible: { baseUrl: e.target.value } } })}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <div className="label">API Key</div>
              <input
                className="input"
                type="password"
                value={settings.ai.openaiCompatible.apiKey}
                onChange={(e) => update({ ai: { openaiCompatible: { apiKey: e.target.value } } })}
              />
            </div>
            <div>
              <div className="label">模型</div>
              <input
                className="input"
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
      </Section>
    </div>
  )
}
