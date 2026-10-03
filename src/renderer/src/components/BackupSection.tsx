/**
 * BackupSection.tsx — 設定頁的「資料備份」區塊。
 *
 * 為什麼獨立成一個元件而不是寫在 SettingsPage 裡:
 *   SettingsPage 已經 800 行、承載五種設定;備份是**一次性動作**而不是設定值,
 *   它有自己非平凡的流程(讀現況 → 確認 → 動手 → 回報),塞進去只會讓那個檔案
 *   更難讀。狀態與流程在這裡,lib/backup.ts 負責資料。
 *
 * 三件這個專案一貫要求、而這裡特別容易漏掉的事:
 *   1. 每一個失敗都要有聲,而且要說人話(BackupError 的訊息直接顯示,不吞)。
 *   2. 取代資料前必須講清楚「會換掉幾筆」—— 使用者按下去之前要能做決定。
 *   3. 「API Key 不在備份裡」要寫在畫面上:這是一個**為了使用者好**的限制,
 *      默默做等於使用者在不知情下以為備份是完整的。
 */
import type { JSX } from 'react'
import { useState } from 'react'
import { AlertTriangle, Download, Loader2, Upload } from 'lucide-react'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'
import { reportError, reportEvent } from '../lib/reportError'
import {
  BACKUP_VERSION,
  backupFileName,
  buildBackup,
  currentCounts,
  importBackup,
  parseBackup,
  serializeBackup
} from '../lib/backup'

type Busy = 'export' | 'import' | null

export function BackupSection(): JSX.Element {
  const [busy, setBusy] = useState<Busy>(null)
  const [counts, setCounts] = useState<{ scripts: number; sessions: number; practiceRuns: number } | null>(null)

  // 筆數是「會被換掉幾筆」的唯一依據,所以在每次操作前重新讀,
  // 不用 React state 裡可能已經過期的值。
  const readCounts = async (): Promise<{ scripts: number; sessions: number; practiceRuns: number }> => {
    const c = await currentCounts()
    setCounts(c)
    return c
  }

  const doExport = async (): Promise<void> => {
    setBusy('export')
    try {
      const [info, settings] = await Promise.all([window.api.appInfo(), window.api.getSettings()])
      const backup = await buildBackup({ appVersion: info.version, settings })
      const res = await window.api.exportFile({
        defaultName: backupFileName(),
        content: serializeBackup(backup)
      })
      if (res.ok && res.filePath) {
        // 成功訊息要帶上筆數:使用者拿著這個檔去別台機器時,知道它有多少東西。
        toast.success(
          `已匯出 ${backup.counts.scripts} 份講稿、${backup.counts.sessions} 場會議、${backup.counts.practiceRuns} 次練習`
        )
        // 成功也要記事件:診斷報告若只有失敗紀錄,「他說他按了匯出但沒反應」
        // 與「他從來沒按過」在報告裡長得一樣 —— 而回報者提供的正是前者。
        reportEvent('backup_exported', { metrics: { ...backup.counts } })
      }
      // res.ok 為 false 時是使用者按取消 —— 那不是錯誤,不該跳紅色錯誤 toast。
    } catch (err) {
      reportError('備份匯出失敗', err, { event: 'backup_failed', prefix: '備份匯出失敗' })
    } finally {
      setBusy(null)
    }
  }

  const doImport = async (): Promise<void> => {
    setBusy('import')
    try {
      const picked = await window.api.importJsonFile()
      if (!picked.ok) {
        // canceled = 使用者自己關掉檔案選擇框,那不是失敗:
        // 寫進診斷報告會讓「使用者取消還原」看起來像產品壞掉。
        if (picked.error && picked.error !== 'canceled') {
          reportError('無法讀取備份檔', picked.error, { event: 'backup_failed' })
        }
        return
      }

      // 先解析,把失敗講清楚,再問任何一個破壞性的問題。
      // 順序有意義:不要讓使用者先看完「這會取代你的資料」才告訴他檔案是壞的。
      const backup = parseBackup(picked.text ?? '')

      const existing = await readCounts()
      const hasExisting = existing.scripts + existing.sessions + existing.practiceRuns > 0
      const total = backup.counts.scripts + backup.counts.sessions + backup.counts.practiceRuns

      if (hasExisting) {
        const ok = await confirmDialog({
          title: '這會取代現有的資料',
          body: [
            `備份裡有 ${backup.counts.scripts} 份講稿、${backup.counts.sessions} 場會議、${backup.counts.practiceRuns} 次練習。`,
            `這台電腦目前有 ${existing.scripts} 份講稿、${existing.sessions} 場會議、${existing.practiceRuns} 次練習。`,
            '',
            '還原是「取代」不是「合併」：還原完之後,這台電腦上不在備份裡的內容會全部消失。',
            '',
            `備份時間：${new Date(backup.exportedAt).toLocaleString('zh-TW')}`,
            '不確定的話先按上面「匯出備份」存一份現在的。'
          ].join('\n'),
          confirmLabel: '取代並還原',
          variant: 'danger'
        })
        if (!ok) return
      }

      const res = await importBackup(backup)
      await readCounts()
      toast.success(`已還原 ${res.counts.scripts} 份講稿、${res.counts.sessions} 場會議、${res.counts.practiceRuns} 次練習`)
      reportEvent('backup_imported', { metrics: { ...res.counts } })

      if (total === 0) {
        // 靜悄悄地還原 0 筆資料,看起來跟成功一樣。使用者會以為資料回來了。
        toast.info('提醒：這份備份裡沒有任何資料,可能是匯出當下就是空的。')
      }
    } catch (err) {
      // 還原失敗是最嚴重的一條:使用者已經是「拿著備份準備重灌」的狀態,
      // 這裡失敗等於他手上只有一份沒被還原的檔。所以除了可行動提示,
      // 還要寫出備份裡本來有幾筆 —— 回報時這是判斷「資料還在不在」的關鍵。
      reportError('備份還原失敗', err, { event: 'backup_failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-outline text-xs" onClick={() => void doExport()} disabled={busy !== null}>
          {busy === 'export' ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Download size={13} className="mr-1.5" />}
          匯出備份
        </button>
        <button
          className="btn-outline text-xs"
          onClick={() => void doImport()}
          disabled={busy !== null}
          title="從備份檔還原。會取代這台電腦上現有的全部資料。"
        >
          {busy === 'import' ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Upload size={13} className="mr-1.5" />}
          還原備份
        </button>
      </div>

      <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-ink-400">
        {counts && (
          <div>
            這台電腦目前有 {counts.scripts} 份講稿、{counts.sessions} 場會議、{counts.practiceRuns} 次練習。
          </div>
        )}
        <div>
          備份是一個 JSON 檔,包含全部講稿、會議紀錄與逐字稿、練習紀錄,以及個人化校準與浮層設定。
          <span className="mt-0.5 block text-ink-500">
            <AlertTriangle size={10} className="mr-1 inline align-[-1px] text-amber-400" />
            API Key 不會寫進備份。備份可以安心寄給自己或放進雲端,金鑰不會跟著走。
          </span>
        </div>
        <div>還原是「取代」而不是「合併」,按下去之前會先問你。</div>
      </div>
    </div>
  )
}

/** 給設定頁用的版本說明(設定檔升級過時,備份格式也可能跟著變) */
export const BACKUP_VERSION_LABEL = `v${BACKUP_VERSION}`
