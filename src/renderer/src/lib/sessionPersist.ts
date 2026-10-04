/**
 * sessionPersist.ts — 把一場會議的逐字稿寫進 IndexedDB(**只寫一次**)。
 *
 * ## 為什麼獨立成一個模組
 *
 * 這段邏輯有兩條呼叫路徑:使用者按下「停止」,以及 App 退出前由 main 端用
 * executeJavaScript 觸發的存檔(見 src/main/quitGuard.ts)。它們必須寫出
 * **同一份東西** —— 兩條路各寫一份的話,改了一邊忘記改另一邊,結果就是
 * 「退出時存的那份沒有報告」或「兩份內容不一致」。而這種缺陷在正常使用下
 * 完全看不出來,只有出事那天才會發現。
 *
 * 它也不能留在 Record.tsx 裡:元件內的函式沒有可測的接縫,而這段的正確性
 * 正是「會不會靜默吃掉一整場會議」那個等級。
 *
 * ## 「只寫一次」為什麼需要一個明確的守衛
 *
 * 兩條路徑可能同時成立:使用者按停止的同時 Windows 正在關機。兩邊都寫的話
 * 會產生兩場幾乎一樣的會議紀錄 —— 使用者看到的是「我明明只開了一次會,
 * 為什麼有兩筆」。這比少一筆更難解釋。
 *
 * 反過來,守衛也必須能重置:第二場會議不能因為第一場存過就被判定成
 * 「已經存過」而拒絕寫入 —— 那是更糟的靜默資料遺失。
 */
import type { CoachingKind, MeetingSession, SessionReport, TranscriptSegment } from '@shared/types'
import { db } from './db'
import { buildSessionReport } from './session-intelligence'

/**
 * 沒命名時的會議標題。
 *
 * 為什麼**不含時間戳**(第四輪 P1-2):原本是 `會議 ${formatDateTime(startedAt)}`,
 * 而清單列的標題下方又印一次 `{formatDateTime(s.startedAt)} · N 段 · …`。
 * 兩處各自都合理,合起來每一場沒命名的會議都變成
 * `會議 2026/10/04 12:48 2026/10/04 12:48 · 1 段 · 未摘要` —— 同一個時間戳
 * 印兩次,看起來像渲染壞掉。而「不命名」是多數人的預設路徑,所以整排清單
 * 長這樣。
 *
 * 時間由下方那行負責,這裡只負責「這場沒有名字」這件事。
 *
 * 與講稿的 UNTITLED_SCRIPT_TITLE 分開定義:兩者的顯示情境不同(講稿在編輯器
 * 標題欄,會議在歷史清單),共用一個常數會讓兩個不相干的字串綁在一起。
 */
export const UNTITLED_SESSION_TITLE = '未命名會議'

export interface PersistSessionInput {
  segments: TranscriptSegment[]
  startedAt: number
  endedAt: number
  title?: string
  speakerAvailability?: { me: boolean; them: boolean }
  personalCpm?: number | null
  /** 教練觸發計數;取不到就省略,不影響報告本體。
   *  用 Partial 因為 SessionReport.coachingCounts 本來就是 Partial(未觸發者不列) */
  coachingCounts?: Partial<Record<CoachingKind, number>>
}

export interface SessionPersister {
  /**
   * 寫入這場會議,回傳存進去的那一筆(含 Dexie 發的 id 與算好的 report)。
   *
   * 回傳 session 而不是 boolean,是為了讓呼叫端**重用同一份報告**:
   * Record 頁的會後報告卡與寫進 db 的必須是同一份,否則同一場會議會有兩種
   * 統計(而且只在某一次退出路徑上不一致 —— 那是最難重現的那種)。
   * 已經寫過或沒有段落時回 null。
   */
  persist: (input: PersistSessionInput) => Promise<MeetingSession | null>
  /** 新的一場開始時呼叫,清掉「已寫入」的事實 */
  reset: () => void
  /** 測試與診斷用 */
  hasPersisted: () => boolean
}

export function createSessionPersister(): SessionPersister {
  let persisted = false
  return {
    hasPersisted: () => persisted,
    reset: () => {
      persisted = false
    },
    persist: async (input: PersistSessionInput): Promise<MeetingSession | null> => {
      // 沒有段落就不寫:那代表「使用者沒說話」或「辨識全失敗」,兩者在
      // Record 頁各有不同的提示(見 stop() 的分支)。寫一個空會議進去只會
      // 讓歷史列表出現一筆沒有內容的幽靈紀錄。
      if (input.segments.length === 0) return null
      if (persisted) return null

      const report: SessionReport = buildSessionReport(input.segments, {
        // 上限 24 小時:buildSessionReport 假設 durationSec 與最後一段時間
        // 對得上,而退出前存檔的 endedAt 是當下 —— 這裡夾住是為了不讓
        // 「停了三小時才關機」變成一段荒謬的會議長度。
        durationSec: Math.min((input.endedAt - input.startedAt) / 1000, 24 * 60 * 60),
        speakerAvailability: input.speakerAvailability,
        personalCpm: input.personalCpm ?? null
      })
      if (input.coachingCounts) report.coachingCounts = input.coachingCounts

      // id 省略讓 Dexie 發號(與 backup 匯入的 strip() 同一個理由:帶著舊 id
      // 寫回去會讓「下次新增」拿到一個已存在的鍵)。
      const session: MeetingSession = {
        title: input.title?.trim() || UNTITLED_SESSION_TITLE,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        segments: input.segments,
        report
      }
      const id = await db.sessions.add(session)
      // 只有**真的寫進去**才標記完成。寫入丟錯時 persisted 維持 false,
      // 讓呼叫端(退出流程)知道這場沒存成,而不是以為已經存好了。
      persisted = true
      return { ...session, id }
    }
  }
}
