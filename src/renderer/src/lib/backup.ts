/**
 * backup.ts — 把使用者累積的東西整份倒出來,以及從備份還原。
 *
 * 為什麼需要(這是「明天要給人用」的三個缺口裡,資料損失最大的一個):
 *   講稿、會議紀錄與逐字稿、練習紀錄全部住在 renderer 的 IndexedDB
 *   (`lib/db.ts` 的三個 store)。重灌系統、清理 App 資料、換電腦、userData
 *   被防毒軟體隔離 —— 任何一個都會讓這些東西**整份消失,而且沒有任何地方找得回**。
 *   對一個提詞機來說,累積的講稿與會議紀錄就是使用者的實際產出;一個只會產生
 *   資料、卻不給人帶走的工具,等於一台會定期吃掉自己產品的機器。
 *
 * 三個刻意的決定:
 *
 * 1. **API Key 不進備份。**
 *    `AppSettings` 裡有 `apiKey` 欄位,而且它不一定永遠是空字串(main 會把
 *    settings 裡的舊值當作 secure store 的備援,見 ipc.ts 的 secureAiKey)。
 *    使用者願意把備份丟進 Dropbox / 隨身碟 / 傳給自己 —— 但那不等於他同意
 *    自己的金鑰跟著走。用「欄位名稱」遞迴剝除而不是「目前是不是空字串」,
 *    理由是後者會在設定改了之後某一天靜默失效,而前者擋的是形狀不是狀態。
 *    這件事必須在畫面上講出來,不能默默做(見 BackupSection.tsx)。
 *
 * 2. **匯入是「取代」而不是「合併」,而且事前要講清楚會換掉幾筆。**
 *    合併聽起來比較安全,但匯入一份備檔的語意就是「回到那個時間點」;
 *    合併會產生同一份講稿兩份、id 衝突、逐字稿片段錯位。使用者按下去之前
 *    必須知道自己在做的是取代(見 SettingsPage 的確認對話框)。
 *
 * 3. **格式帶版本,而且不符要給人話錯誤。**
 *    匯入端不吞掉錯誤 —— 上一輪最貴的一個教訓就是「靜默失敗」:使用者以為
 *    資料回來了,實際上什麼都沒發生,還要等下一次用到才發現。
 */
import { db } from './db'
import type { MeetingSession, PracticeRun, Script } from '@shared/types'

export const BACKUP_FORMAT = 'ai-teleprompter-backup'
export const BACKUP_VERSION = 1

/** 檔名用的時間戳:20260930-1432。本地時間,不帶時區尾巴(備份通常在同一部電腦上看)。 */
function fileStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function backupFileName(d = new Date()): string {
  return `ai-teleprompter-backup-${fileStamp(d)}.json`
}

export interface BackupCounts {
  scripts: number
  sessions: number
  practiceRuns: number
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  /** 匯出時的 App 版本:還原到舊版時至少知道資料是誰寫的 */
  appVersion: string
  exportedAt: string
  counts: BackupCounts
  data: {
    scripts: Script[]
    sessions: MeetingSession[]
    practiceRuns: PracticeRun[]
  }
  /** 個人化校準與浮層設定。API Key 已被剝除(見檔頭)。 */
  settings: unknown
}

/** 欄位名命中就整個丟掉,不管值是不是空字串。 */
const SECRET_FIELD = /^(apiKey|sttApiKey|token|secret|password|authorization)$/i

/**
 * 遞迴剝除金鑰。
 *
 * 為什麼不只處理已知的兩個欄位:設定的形狀會長,今天多一個 provider 明天可能
 * 多一個欄位,而漏掉的那一個會安靜地跟著備份離開這台電腦。擋形狀比擋值可靠。
 * 只丟「值」不丟「鍵」:留一個空字串回去,匯入後設定頁不會出現 undefined。
 */
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(k)) out[k] = ''
      else out[k] = stripSecrets(v)
    }
    return out as unknown as T
  }
  return value
}

/** 統計各 store 筆數 —— 匯入前的確認對話框要靠它說清楚「會換掉幾筆」。 */
export async function currentCounts(): Promise<BackupCounts> {
  const [scripts, sessions, practiceRuns] = await Promise.all([
    db.scripts.count(),
    db.sessions.count(),
    db.practiceRuns.count()
  ])
  return { scripts, sessions, practiceRuns }
}

export interface BuildOptions {
  appVersion: string
  settings: unknown
  now?: Date
}

export async function buildBackup({ appVersion, settings, now }: BuildOptions): Promise<BackupFile> {
  const [scripts, sessions, practiceRuns] = await Promise.all([
    db.scripts.toArray(),
    db.sessions.toArray(),
    db.practiceRuns.toArray()
  ])
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    exportedAt: (now ?? new Date()).toISOString(),
    counts: { scripts: scripts.length, sessions: sessions.length, practiceRuns: practiceRuns.length },
    data: { scripts, sessions, practiceRuns },
    settings: stripSecrets(settings)
  }
}

export function serializeBackup(b: BackupFile): string {
  // 縮排 2:這是給人看的檔案(萬一要手動檢查或救部分資料),不是給機器壓縮的。
  return JSON.stringify(b, null, 2)
}

/** 驗證並解析。每一種失敗都給人話 —— 呼叫端直接把訊息顯示出來,不吞。 */
export class BackupError extends Error {}

export function parseBackup(text: string): BackupFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupError('這不是一個 JSON 檔。請確認選到的是「ai-teleprompter-backup-*.json」。')
  }
  if (!raw || typeof raw !== 'object') throw new BackupError('備份檔的內容不是一個物件,可能選錯檔案了。')
  const b = raw as Partial<BackupFile>
  if (b.format !== BACKUP_FORMAT) {
    throw new BackupError('這不是 AI 提詞機的備份檔(缺少 format 標記)。')
  }
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) {
    throw new BackupError(
      `備份檔的版本是 ${String(b.version)},比這個 App 能讀的 ${BACKUP_VERSION} 新。請先更新 App 再還原。`
    )
  }
  const d = b.data
  if (!d || !Array.isArray(d.scripts) || !Array.isArray(d.sessions) || !Array.isArray(d.practiceRuns)) {
    throw new BackupError('備份檔缺少資料內容(data.scripts / sessions / practiceRuns)。檔案可能損毀。')
  }
  return b as BackupFile
}

export interface ImportResult {
  counts: BackupCounts
}

/**
 * 還原。**取代**,不是合併(理由見檔頭)。
 *
 * 逐 store 先清空再寫入,而且不保留原 id —— id 是 IndexedDB 的自增鍵,
 * 帶著舊 id 寫回去會讓「下次新增」拿到一個已存在的鍵。改成讓 Dexie 重新發號。
 */
export async function importBackup(b: BackupFile): Promise<ImportResult> {
  const counts: BackupCounts = {
    scripts: b.data.scripts.length,
    sessions: b.data.sessions.length,
    practiceRuns: b.data.practiceRuns.length
  }

  // 一個 store 寫到一半失敗會留下「清空但沒寫回」的狀態。Dexie 的 transaction
  // 讓三個 store 要嘛全成要嘛全不成 —— 這是唯一能防止「還原之後資料變少」
  // 的做法,而那正是使用者最不能接受的結果。
  //
  // 三個實作細節都是被測試逼出來的,不是風格選擇:
  //   1. **不能用 Promise.all**。Dexie 靠追蹤 promise 來維持交易脈絡,
  //      而 Promise.all 會把後續操作丟出那個追蹤範圍。實測結果:三個 clear
  //      一起發出去時,交易會在它們生效前就結束 —— 資料沒被清掉,而函式回報成功。
  //      這正是最壞的一種失敗:靜默地什麼都沒做。
  //   2. **空陣列不呼叫 bulkAdd**。bulkAdd([]) 會讓交易裡沒有任何待寫入的操作,
  //      Dexie 會把它當成唯讀交易而回滾,連帶把 clear 取消。
  //   3. 逐個 await,順序固定。
  const strip = <T extends { id?: number }>(rows: T[]): T[] => rows.map(({ id: _id, ...rest }) => rest as T)

  await db.transaction('rw', [db.scripts, db.sessions, db.practiceRuns], async () => {
    await db.scripts.clear()
    await db.sessions.clear()
    await db.practiceRuns.clear()
    if (b.data.scripts.length) await db.scripts.bulkAdd(strip(b.data.scripts) as Script[])
    if (b.data.sessions.length) await db.sessions.bulkAdd(strip(b.data.sessions) as MeetingSession[])
    if (b.data.practiceRuns.length) await db.practiceRuns.bulkAdd(strip(b.data.practiceRuns) as PracticeRun[])
  })

  return { counts }
}
