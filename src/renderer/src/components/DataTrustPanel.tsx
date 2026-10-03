/**
 * DataTrustPanel.tsx — 「你的資料去了哪裡」(判斷在 lib/dataTrust.ts)。
 *
 * 為什麼獨立元件:它要在設定頁、Dashboard、以及(之後)匯出備份的確認框裡
 * 都可能用到,而那三處的呈現需求不同(完整清單 / 一行摘要 / 確認前提醒)。
 * 狀態與流程在這裡,判斷在 lib。
 *
 * 刻意的三件事:
 *   - **從實際設定推導**,不寫死一句「你的資料只在本地」。寫死的話,使用者在
 *     把 STT 從本地改成雲端之後那句話仍然成立 —— 而它已經不成立了。
 *   - 警示列(會離開這台電腦的)用琥珀色,本機列用灰色。不是全部紅色:
 *     大部分列都是本機的,全部紅色會讓人以為整個 App 有問題。
 *   - 每列的「哪裡」是**主機名**不是完整 URL(見 endpointHost 的理由)。
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Cloud, HardDrive, KeyRound, ScrollText } from 'lucide-react'
import { buildDataTrust, hasExternalTransfer, type TrustKind, type TrustRow } from '../lib/dataTrust'
import { useSettings } from '../lib/store'
import { cn } from '../lib/utils'

const ICONS: Record<TrustKind, typeof HardDrive> = {
  local: HardDrive,
  upload: Cloud,
  credential: KeyRound,
  log: ScrollText
}

const KIND_LABEL: Record<TrustKind, string> = {
  local: '只在本機',
  upload: '會離開這台電腦',
  credential: '憑證與備份',
  log: '記錄'
}

export interface DataTrustPanelProps {
  variant?: 'full' | 'summary'
}

export function DataTrustPanel({ variant = 'full' }: DataTrustPanelProps): JSX.Element | null {
  const settings = useSettings((s) => s.settings)
  const [keys, setKeys] = useState({ stt: false, ai: false, ready: false })

  /**
   * 金鑰狀態要問安全儲存,不是讀 settings。
   *
   * 理由與 PreflightCard 的 refreshKeys 完全相同:settings.stt.cloud.apiKey
   * 是遷移前的舊備援位置,真實來源是 safeStorage。只讀 settings 會在使用者
   * 已經把金鑰搬進安全儲存之後仍然顯示「還沒填」—— 那是在對他說謊。
   */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const k = await window.api?.keysGet?.()
      setKeys({
        stt: !!k?.sttApiKey || !!settings?.stt?.cloud?.apiKey,
        ai: !!k?.apiKey || !!settings?.ai?.openaiCompatible?.apiKey,
        ready: true
      })
    } catch {
      // 讀不到不算錯:兩項都當未填,面板會多問一次,不會少問。
      setKeys({ stt: false, ai: false, ready: true })
    }
  }, [settings?.stt?.cloud?.apiKey, settings?.ai?.openaiCompatible?.apiKey])

  useEffect(() => {
    void refresh()
    const recheck = (): void => void refresh()
    window.addEventListener('ai-tp:keys-changed', recheck)
    return () => window.removeEventListener('ai-tp:keys-changed', recheck)
  }, [refresh])

  if (!settings || !keys.ready) return null
  const rows: TrustRow[] = buildDataTrust({
    settings,
    secureStoreHasSttKey: keys.stt,
    secureStoreHasAiKey: keys.ai
  })
  const external = hasExternalTransfer(rows)

  if (variant === 'summary') {
    return (
      <div data-trust="summary" className="flex items-center gap-2 text-[11px] text-ink-400">
        <span className={cn('shrink-0', external ? 'text-amber-400' : 'text-emerald-400')}>
          {external ? '部分內容會離開這台電腦' : '所有資料都留在這台電腦'}
        </span>
        <span>· 到設定頁看詳細清單</span>
      </div>
    )
  }

  return (
    <div data-trust="panel" data-trust-external={external ? '1' : '0'}>
      {/* 這句話是動態的:「全部都在本機」在使用者改設定之後會變成
          「部分會離開」,而它必須變 —— 否則這裡就在對他說謊。 */}
      <div
        className={cn(
          'mb-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed',
          external ? 'bg-amber-400/10 text-amber-200' : 'bg-emerald-500/10 text-emerald-300'
        )}
      >
        {external ? <Cloud size={13} className="mt-0.5 shrink-0" /> : <HardDrive size={13} className="mt-0.5 shrink-0" />}
        <span>
          {external
            ? '有部分內容會送到你設定的外部服務。逐字稿與講稿本身仍然只留在這台電腦。'
            : '所有內容都留在這台電腦。這個 App 不會把你的對話或講稿送到任何地方。'}
        </span>
      </div>

      <ul className="space-y-2">
        {rows.map((row) => {
          const Icon = ICONS[row.kind]
          return (
            <li
              key={row.id}
              data-trust-row={row.id}
              className="flex items-start gap-2.5 rounded-lg bg-black/20 px-3 py-2"
            >
              <Icon size={13} className={cn('mt-0.5 shrink-0', row.warn ? 'text-amber-400' : 'text-ink-400')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-ink-100">{row.what}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                      row.warn ? 'bg-amber-400/15 text-amber-300' : 'bg-ink-800 text-ink-400'
                    )}
                  >
                    {KIND_LABEL[row.kind]}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-ink-300">{row.where}</div>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
        這一張表是根據你**目前的設定**算出來的。改設定之後它會跟著變 —— 例如把語音辨識從本地改成雲端,
        就會多出一列寫著音訊會送到哪裡。
      </p>
    </div>
  )
}
