/**
 * sessionToScript.ts — 「把這場會議的逐字稿存成一份講稿」的資料層。
 *
 * 為什麼要這條轉換:這個 App 的主功能是提詞,而錄音產出的是會議紀錄。
 * 開完會最自然的下一步是「把這段變成我下次要用的講稿」(見 Record.tsx
 * 原本的 saveTranscriptAsScript 說明)。
 *
 * 防重複放在**資料層**而不是畫面 state:
 *   「已存成講稿」原本只活在 Record 頁的 Set<number> 裡,切頁/重啟就歸零,
 *   再按一次會產生兩份一模一樣的講稿。存在 MeetingSession.savedAsScriptId
 *   上,「存過了」才是一個跨頁、跨重啟都成立的事實。
 *
 * 反過來也要成立(2026-10-03):參照指向的講稿消失時,「存過了」就必須一併失效 ——
 * 否則 Record 頁的按鈕會永遠停在 disabled 的「已存成講稿」,使用者既看不到那份稿,
 * 也再也存不成。參照的兩條生命週期(刪除 / 備份還原)都在這個模組裡收掉。
 *
 * 只取**我方**的發言(提詞是給自己講的);沒有我方段落時退回全部。
 * 段落前保留時間戳 —— 講稿需要能對照原文位置。
 */
import { db } from './db'
import type { MeetingSession } from '@shared/types'
import { formatDuration } from './utils'

export type SaveSessionAsScriptResult =
  | { ok: true; scriptId: number; created: boolean }
  | { ok: false; reason: 'empty' }

export function transcriptToScriptBody(s: MeetingSession): string {
  const mine = s.segments.filter((seg) => seg.speaker === 'me')
  return (mine.length ? mine : s.segments)
    .map((seg) => `[${formatDuration(seg.start)}] ${seg.text}`)
    .join('\n')
}

/**
 * 存成講稿。重複呼叫是冪等的:session 已帶 savedAsScriptId 時直接回傳
 * 既有講稿(created: false),不會再建一份。寫入失敗照樣往外拋 ——
 * 「存檔失敗」必須有聲,由呼叫端決定怎麼報(見 reportError)。
 */
export async function saveSessionAsScript(s: MeetingSession): Promise<SaveSessionAsScriptResult> {
  const claimed = claimSavedScriptId(s)
  if (claimed != null) {
    return { ok: true, scriptId: claimed, created: false }
  }
  const body = transcriptToScriptBody(s)
  if (!body.trim()) return { ok: false, reason: 'empty' }
  const now = Date.now()
  const scriptId = await db.scripts.add({
    title: `${s.title}（講稿）`,
    content: body,
    createdAt: now,
    updatedAt: now
  })
  if (s.id != null) await db.sessions.update(s.id, { savedAsScriptId: scriptId })
  return { ok: true, scriptId, created: true }
}

/**
 * 「這場會議真的已經存成一份**還在的**講稿了嗎?」—— 沒有的話回傳 undefined。
 *
 * 為什麼不能只看 savedAsScriptId:那份講稿是可以不見的(講稿頁有刪除鈕),
 * 而參照會留在 session 上。結果是 Record 頁的按鈕永遠停在「已存成講稿」且 disabled,
 * 使用者既看不到那份稿,也不能再存一次 —— 一個沒有任何復原路徑的死路。
 * 備份還原也會造成同樣的結果(見 backup.ts 的 remapSavedAsScriptIds)。
 *
 * `knownScriptIds` 為 null 表示「還沒問過資料庫」:那時一律當成已存過,
 * 因為寧可讓按鈕不可按,也不要讓使用者按兩次做出兩份一樣的稿。
 */
function claimSavedScriptId(
  s: MeetingSession,
  knownScriptIds: Set<number> | null = null
): number | undefined {
  if (s.savedAsScriptId == null) return undefined
  if (knownScriptIds === null) return s.savedAsScriptId
  return knownScriptIds.has(s.savedAsScriptId) ? s.savedAsScriptId : undefined
}

/** 給 Record 頁按鈕用的判斷(純函式,單元測試直接餈假資料)。 */
export function isSessionSavedAsScript(
  s: MeetingSession,
  knownScriptIds: Set<number> | null,
  justSavedSessionIds?: ReadonlySet<number>
): boolean {
  // 畫面快取:這一頁剛存過的(事實寫在 DB,但按鈕要立即反映使用者剛做的動作)
  if (s.id != null && justSavedSessionIds?.has(s.id) === true) return true
  return claimSavedScriptId(s, knownScriptIds) != null
}

/**
 * 刪掉講稿時,把所有指向它的 session 參照清掉。回傳受影響的筆數。
 *
 * 必須與刪講稿一起做(見 Scripts.tsx 的 remove):參照是「存過了」的證據,
 * 證據指向的東西不見了,證據就失效 —— 讓它繼續留著只會把使用者鎖死在
 * 「已存成講稿」的按鈕上。
 *
 * 實作上只能掃描:savedAsScriptId 沒有索引,而會議數量是使用者級的(個位數到
 * 幾十場),一次 toArray 比為它加一個 Dexie 版本(需要 migration)划算得多。
 */
export async function unlinkScriptFromSessions(scriptId: number): Promise<number> {
  const sessions = await db.sessions.toArray()
  let touched = 0
  for (const s of sessions) {
    if (s.id == null || s.savedAsScriptId !== scriptId) continue
    // Dexie update 寫 undefined 會讓欄位回到「沒有值」的狀態,
    // 與沒有這個鍵在行為上相同(全部判斷都用 != null)。
    await db.sessions.update(s.id, { savedAsScriptId: undefined })
    touched += 1
  }
  return touched
}
