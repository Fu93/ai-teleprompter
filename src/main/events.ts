/**
 * events.ts — 結構化事件紀錄(純本機)。
 *
 * 與 logging.ts 的分工:
 *   logging.ts 是**檔案**:崩潰與未捕捉例外的落盤,輪替保留 3 檔。
 *   這裡是**結構**:把事件寫成單行 JSON,並在記憶體裡保留最近 N 筆,
 *   讓「複製診斷報告」不必去解析自由文字。
 *
 * 為什麼要在記憶體裡留一份而不是每次去讀檔:
 *   診斷報告要在**沒有權限讀 userData 的情況下**也能產出(例如 renderer
 *   發起、主進程直接組裝後回傳)。讀檔需要在 main 端做一次 sync I/O,
 *   那在啟動早期(視窗還沒起來)是可行的,但會讓一個純查詢的操作有 I/O 失敗
 *   的可能 —— 而診斷報告失敗時使用者手上正好是壞的狀態,那是最不該再失敗的
 *   時刻。記憶體裡的一份是有界的(N 筆),不會變成無上限的記憶體成長。
 *
 * 有界是硬性的:appendFileSync 寫不動時(磁碟滿)整個流程都會被 IO 包住,
 * 而 3 個 rotation 檔加起來撐死 3MB,事件本身是細的,真正會撐爆的是
 * 「每幀記一筆」的那種呼叫端 —— 所以這裡的介面刻意不接受批次以外的東西,
 * 而且下面有 rateLimit。
 */
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { redactEventFields, type EventName, type EventPayload } from '@shared/observability'
import { logFile, rotateIfLarge } from './logging'

/** 記憶體裡保留的事件筆數上限。 */
const MEMORY_CAP = 200

interface StoredEvent {
  at: string
  name: EventName
  code?: string
  message?: string
  /** 已遮蔽的欄位 */
  fields?: Record<string, string | number | boolean | null>
  /**
   * 數值指標。**只留有限數字**,非數字一律丟棄。
   *
   * 為什麼要過濾:`metrics` 在型別上是 `Record<string, number>`,而型別在執行期
   * 不存在。沒有這道過濾,未來有人寫 `metrics: { text: '逐字稿片段' }`(或把
   * 使用者輸入字串化塞進來)時,它會**跳過 redactEventFields** 直接進到報告裡 ——
   * 而報告預設會離開這台電腦。
   *
   * 數字不可能是秘密:這與 observability.test.ts 釘住的那條契約
   * (「敏感命名的欄位只准放布林或數字」)是同一個推理。
   */
  metrics?: Record<string, number>
}

const recent: StoredEvent[] = []

/**
 * 相同 (name, code) 的事件在這段時間內只寫一次。
 *
 * 為什麼需要:轉錄失敗在「麥克風被占用」的情況下會**每一段都失敗**,
 * 一場會議下來可能是幾十筆完全相同的錯誤。全部寫進去,診斷報告會被
 * 同一件事洗掉 —— 而「重複了 40 次」這個事實本身才是診斷重點。
 * 抑制成第一筆 + 計數,資訊沒有損失,檔案小了一個數量級。
 */
const RATE_LIMIT_MS = 5_000
const lastSeen = new Map<string, { at: number; suppressed: number }>()

/** 錯誤碼統計(診斷報告用)。只統計 E_* 開頭的碼。 */
const errorCounts = new Map<string, { count: number; lastAt: string }>()

function dir(): string {
  return join(app.getPath('userData'), 'logs')
}

/**
 * 寫一筆事件。
 *
 * 整支函式包在 try/catch 裡,理由與 logging.ts 相同:**觀測不該成為故障源**。
 * 一次磁碟寫入失敗若拋出去,會讓「摘要失敗」變成「摘要失敗之後整個頁面也壞了」
 * —— 而後者嚴重得多,也難查得多。
 */
export function recordEvent(payload: EventPayload): void {
  try {
    const at = new Date().toISOString()
    const key = `${payload.name}|${payload.code ?? ''}`

    // 計數**先做**,再做抑制:被抑制的事件也要計數,否則「重複 40 次」
    // 這個診斷重點會隨著抑制一起消失。
    if (payload.code) {
      const cur = errorCounts.get(payload.code)
      if (cur) {
        cur.count += 1
        cur.lastAt = at
      } else {
        errorCounts.set(payload.code, { count: 1, lastAt: at })
      }
    }

    const prev = lastSeen.get(key)
    if (prev && Date.now() - prev.at < RATE_LIMIT_MS) {
      prev.suppressed += 1
      return
    }
    const suppressed = prev?.suppressed ?? 0
    lastSeen.set(key, { at: Date.now(), suppressed: 0 })

    // 遮蔽在**這裡**,不是寫入之後:唯一保證敏感欄位不落盤的地方。
    const fields = redactEventFields(payload.fields)
    // 只留有限數字。見 StoredEvent.metrics 的註解:型別在執行期不存在,
    // 而 metrics 這條路徑**不會**經過 redactEventFields。
    const metrics = payload.metrics
      ? Object.fromEntries(
          Object.entries(payload.metrics).filter(
            ([, v]) => typeof v === 'number' && Number.isFinite(v)
          )
        )
      : undefined
    const stored: StoredEvent = { at, name: payload.name }
    if (payload.code) stored.code = payload.code
    if (payload.message) stored.message = payload.message.slice(0, 500)
    if (fields) stored.fields = fields
    // 之前 metrics 只寫進檔案、不進記憶體 —— 而診斷報告是**從記憶體組的**。
    // 後果:「啟動花了 4.2 秒」這種資訊寫進了日誌檔,使用者複製診斷報告時卻看不到,
    // 而那份報告才是他會貼給我們的東西。
    if (metrics && Object.keys(metrics).length > 0) stored.metrics = metrics

    recent.unshift(stored)
    // 記憶體有界。slice(0, N) 產生新陣列,舊的讓 GC 收走。
    if (recent.length > MEMORY_CAP) recent.length = MEMORY_CAP

    // 落盤:與一般日誌同一個檔案,單行 JSON。寫在 renderer 訊息之後,
    // 讓時間順序與閱讀順序一致(先看到崩潰、再看到後續的事件)。
    // 輪替直接呼叫 logging.ts 那一份 —— 門檻與保留檔數不該在兩個地方各寫一次。
    mkdirSync(dir(), { recursive: true })
    rotateIfLarge()
    const parts: string[] = [`[${at}] [EVENT] ${payload.name}`]
    if (payload.code) parts.push(`code=${payload.code}`)
    if (payload.message) parts.push(`msg=${JSON.stringify(payload.message.slice(0, 300))}`)
    if (payload.metrics) {
      for (const [k, v] of Object.entries(payload.metrics)) parts.push(`${k}=${v}`)
    }
    if (fields && Object.keys(fields).length > 0) {
      parts.push(`fields=${JSON.stringify(fields)}`)
    }
    if (suppressed > 0) parts.push(`(suppressed ${suppressed} similar)`)
    appendFileSync(logFile(), parts.join(' ') + '\n', 'utf-8')
  } catch {
    /* 觀測不該成為故障源:見函式註解 */
  }
}

/** 最近的錯誤碼統計(給診斷報告)。 */
export function recentErrorCounts(): Array<{ code: string; count: number; lastAt: string }> {
  return [...errorCounts.entries()]
    .map(([code, v]) => ({ code, count: v.count, lastAt: v.lastAt }))
    .sort((a, b) => b.count - a.count)
}

/** 最近的事件(給診斷報告)。 */
export function recentEvents(limit = 40): StoredEvent[] {
  return recent.slice(0, limit)
}

/**
 * 供測試用:清空記憶體狀態。
 *
 * 為什麼需要:這是模組層級的單例,而單元測試跑在**同一個 Node 程序**裡 ——
 * 沒有這支,第一個測試記的事件會出現在第二個測試的報告裡,而測試仍然全綠。
 * 那正是「量測層在說謊」的其中一種:報告看起來對,但內容是上一輪的殘留。
 */
export function __resetEventState(): void {
  recent.length = 0
  errorCounts.clear()
  lastSeen.clear()
}
