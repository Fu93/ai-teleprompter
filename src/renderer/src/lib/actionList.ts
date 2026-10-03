/**
 * actionList.ts — 會後摘要的「可複製行動清單」。
 *
 * ── 為什麼需要 ──
 *   會後報告現在是**報告**:發言佔比、語速、冷場次數、幾句建議。使用者看完
 *   知道「我今天講太多了」,然後呢?他得自己從「建議」裡挑出要做的事、
 *   記到某個地方去。這一步是這個產品**最常被放棄**的一段:沒有任何一步是
 *   帶著他去做的。
 *
 *   而資料其實已經齊了 —— `summary.todos`、`summary.followUps`、
 *   `report.suggestions` 三樣都在手上,只是它們各自呈現在報告的不同角落,
 *   沒有被組裝成一份「明天要做的事」。
 *
 * ── 為什麼「下一次練習建議」要從數字算出來 ──
 *   直接把 `suggestions` 複製過來會是偷懶:那些建議是「你冷場 3 次」這種
 *   **觀察**,而使用者要的是「下次練習時刻意把每次發言壓在 90 秒以內」這種
 *   **練習**。兩者之間的轉換就是這個產品提供的價值 —— 沒有它的話,
 *   使用者只是拿到了一份他本來就有的數字。
 *
 * ── 純函式 ──
 *   不碰 React、不碰 DB、不碰剪貼簿:所以能被單元測試餈假的 session 與
 *   report 進去,驗證每一種數字組合都產生合理的建議。而「每一種組合」正是
 *   這個函式最容易出錯的地方(除以零、沒有建議時該不該給文字)。
 */
import type { MeetingSession, SessionReport, SessionSuggestion } from '@shared/types'

/** 一次練習的目標:從觀察推導出的、可被刻意執行的一句話。 */
export interface PracticeTarget {
  /** 標題,例:「壓住單次發言長度」 */
  title: string
  /** 具體到可以在計時器上驗收的目標 */
  goal: string
  /** 這個目標是從哪個數字來的(讓使用者知道它不是憑空說的) */
  because: string
}

/**
 * 從量化報告推導一個練習目標。
 *
 * 挑「最高嚴重度的那一條」而不是「挑最容易量的一條」:使用者只有時間做
 * 一件事,那件事應該是他最需要改的。
 *
 * 回傳 null 的情況只有一個:報告裡沒有任何觀察(例如十秒鐘的會議)。
 * 那時硬擠一句練習建議會是編造 —— 使用者會照著一個不存在的目標練習。
 */
export function derivePracticeTarget(report: SessionReport | null | undefined): PracticeTarget | null {
  if (!report || report.suggestions.length === 0) return null
  const worst = pickWorst(report.suggestions)
  if (!worst) return null

  // 每種建議對應一個可驗收的練習目標。
  // 用數字而不是形容詞:「把每次發言壓在 90 秒內」可以被計時器驗收,
  // 「多注意場合奏」不能 —— 而不能被驗收的目標,三場之後就沒有人再做了。
  switch (worst.severity) {
    case 'high':
      if (worst.message.includes('冷場')) {
        return {
          title: '不要讓停頓留給對方',
          goal: '每次發完一句,先停 1 秒再繼續 —— 讓對方有插話的空間',
          because: `這場冷場 ${report.gapCount} 次,共 ${Math.round(report.gapTotalSec)} 秒`
        }
      }
      if (worst.message.includes('搶話') || worst.message.includes('打斷')) {
        return {
          title: '讓對方講完',
          goal: '對方發言時先記在紙上不插話,等停頓再接',
          because: '這場偵測到打斷對方'
        }
      }
      if (worst.message.includes('語速')) {
        return {
          title: '把語速拉回能聽的速度',
          goal: `刻意放慢到每分鐘 ${Math.max(100, Math.round(report.myCpm * 0.8))} 字,朗讀一段並錄下來對照`,
          because: `這場平均每分鐘 ${Math.round(report.myCpm)} 字`
        }
      }
      break
    default:
      break
  }

  // 單口相長與其他 medium/low 建議:用最容易量的一個。
  if (report.longestMyTurnSec >= 120) {
    return {
      title: '把長段拆成幾段',
      goal: '每次連續講不超過 90 秒就停一下,讓對方有接話的點',
      because: `這場最長的一段連續講了 ${Math.round(report.longestMyTurnSec)} 秒`
    }
  }
  if (report.turnCount > 0 && report.avgMyTurnSec > 90) {
    return {
      title: '每次講短一點',
      goal: '練習時刻意把每次發言壓在 60 秒以內',
      because: `這場平均每次講 ${Math.round(report.avgMyTurnSec)} 秒`
    }
  }
  if (report.myUnits > 0 && report.talkRatio < 0.35) {
    return {
      title: '多說一點',
      goal: '練習時刻意讓自己講到至少一半的時間',
      because: `這場你只講了 ${Math.round(report.talkRatio * 100)}% 的時間`
    }
  }

  // 有建議但沒有任何一個可量化的:給最嚴重那一條的原文,
  // 並明說它是「觀察」而不是練習目標 —— 假裝它是目標就是編造。
  return {
    title: '先處理這一項',
    goal: worst.message,
    because: '這是這場報告裡最需要留意的一項'
  }
}

/** 最高嚴重度;同級取第一個(建議本身是依嚴重度產生的,順序有意義)。 */
function pickWorst(suggestions: SessionSuggestion[]): SessionSuggestion | undefined {
  const rank: Record<SessionSuggestion['severity'], number> = { high: 3, medium: 2, low: 1 }
  return [...suggestions].sort((a, b) => rank[b.severity] - rank[a.severity])[0]
}

export interface ActionList {
  /** 可以直接複製的完整文字 */
  text: string
  /** 待辦(來自 AI 摘要) */
  todos: string[]
  /** 建議跟進(來自 AI 摘要) */
  followUps: string[]
  /** 下一次練習建議(可能為 null:沒有觀察就不編造) */
  target: PracticeTarget | null
  /** 這份清單是不是只有量化建議、沒有 AI 產出的待辦 */
  aiMissing: boolean
}

/**
 * 組出可複製的行動清單。
 *
 * **不要**因為沒有 AI 摘要就拒絕產出:量化報告的建議同樣是行動項。
 * 反過來也一樣:AI 產不出待辦不代表使用者該什麼都拿不到。
 */
export function buildActionList(session: MeetingSession): ActionList {
  const todos = session.summary?.todos ?? []
  const followUps = session.summary?.followUps ?? []
  const target = derivePracticeTarget(session.report)

  const lines: string[] = [`# ${session.title} — 行動清單`, '']

  lines.push('## 待辦事項')
  if (todos.length > 0) todos.forEach((t) => lines.push(`- [ ] ${t}`))
  else lines.push('- [ ] （這場沒有產生待辦;可以在「AI 摘要」重跑一次,或自己補上）')

  if (followUps.length > 0) {
    lines.push('', '## 需要追問或確認')
    followUps.forEach((f) => lines.push(`- [ ] ${f}`))
  }

  if (target) {
    lines.push('', '## 下一次練習')
    lines.push(`目標：${target.title}`)
    lines.push(`做法：${target.goal}`)
    lines.push(`根據：${target.because}`)
  }

  if (session.report && session.report.suggestions.length > 0) {
    lines.push('', '## 這場的觀察')
    session.report.suggestions.forEach((s) => {
      const tag = s.severity === 'high' ? '重要' : s.severity === 'medium' ? '建議' : '參考'
      lines.push(`- [${tag}] ${s.message}`)
    })
  }

  // 結尾必須說明這份清單**不含**什麼。理由:它的目的地是使用者的待辦工具、
  // 專案管理軟體或聊天視窗 —— 也就是離開這個 App 的地方。使用者需要知道
  // 貼出去的東西會不會把他整場會議的逐字稿帶走(不會),而那個保證如果
  // 只存在於設定頁,他在按「複製」的當下是看不到的。
  lines.push('', '（由 AI 提詞機產生。這份清單只含待辦與建議,不含逐字稿;完整逐字稿留在「錄音轉錄」頁。）')

  return {
    text: lines.join('\n'),
    todos,
    followUps,
    target,
    aiMissing: todos.length === 0
  }
}
