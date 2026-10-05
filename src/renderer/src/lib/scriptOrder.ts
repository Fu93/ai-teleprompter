/**
 * scriptOrder.ts — 講稿清單的兩種排序(純函式,給單元測試釘住)。
 *
 * ## 為什麼需要這個
 *
 * `lastUsedAt` 從資料模型存在的那天起就被**寫進四個地方**(`pages/Scripts.tsx`
 * 三處、`pages/Dashboard.tsx` 一處)而**從來沒有被讀過** —— 也就是說,這個
 * 產品一直在收集「哪一份稿子剛剛被用過」的資訊,然後丟掉。
 *
 * 這不是無害的浪費。使用者開一個演講 App 的典型動作是:回到上次講的那一份。
 * 清單目前只按 `updatedAt` 排(最後編輯),於是「我上週改過但上個月講過的稿」
 * 會排在「我上個月改過但剛剛講過的稿」前面 —— 而後者才是他要的。
 *
 * ## 為什麼不直接在元件裡 sort
 *
 * 兩個原因,都是這個專案反覆記錄過的:
 *   1. **沒用過的稿怎麼排是規則,不是實作細節。** `lastUsedAt` 是 optional,
 *      所以有一整類「從來沒被用過」的稿。把 `undefined` 當 0 排,它們會全部
 *      擠在最後(對)但彼此之間的順序會退化成 `updatedAt`(不直覺)。這個判斷
 *      必須有人明確決定過,而不是看起來合理就對了。
 *   2. 元件裡 sort 沒辦法測。`pages/Scripts.tsx` 有 1156 行、依賴十幾個
 *      ref 與 effect,為了驗一個排序規則去 mount 它是錯的。
 */

/** 清單排序方式 */
export type ScriptOrder = 'edited' | 'used'

/**
 * 排序規則的輸入只要用到排序鍵,不需要整筆 Script。
 * 這樣測試可以用最小物件驅動,不必造出完整資料模型。
 */
export interface OrderableScript {
  updatedAt: number
  lastUsedAt?: number
}

/**
 * 依 `order` 排序講稿清單。**回傳新陣列**,不改動輸入。
 *
 * 兩種模式的完整規則:
 *
 * - `edited`(預設,維持原本的行為):依 `updatedAt` 由新到舊。
 *   與原本 `db.scripts.orderBy('updatedAt').reverse()` 的結果一致 ——
 *   這一點是刻意維持的,切換排序不該順便改掉預設順序。
 *
 * - `used`:依 `lastUsedAt` 由新到舊,**從沒用過的稿排在最後**。
 *   最後那群內部再依 `updatedAt` 由新到舊,理由見上:那是他唯一還有的時間訊號,
 *   而且「最近寫的」對「最近寫但還沒講」的稿是合理的預設。
 *
 * 為什麼不用 `lastUsedAt ?? 0` 一行解決:那會讓所有沒用過的稿**並列在最後**,
 * 而它們的相對順序會是 `Array.prototype.sort` 在同值時的穩定序 —— 也就是
 * `updatedAt` 查詢的順序。實測上那確實等於 `updatedAt` 由新到舊,所以結果
 * 「看起來」對;但那是**依賴查詢順序的巧合**,不是規則。明確寫出來才不會在
 * 有人改查詢順序時無聲地退化。
 *
 * 穩定性:同鍵時保持輸入順序,與 `Array.prototype.sort` 的規範一致。
 * 這讓「清單順序在重新整理前後不會跳動」成為可預期的行為。
 */
export function sortScripts<T extends OrderableScript>(scripts: T[], order: ScriptOrder): T[] {
  return [...scripts].sort((a, b) => {
    if (order === 'edited') return b.updatedAt - a.updatedAt
    const aUsed = a.lastUsedAt != null
    const bUsed = b.lastUsedAt != null
    // 用過的永遠排前面 —— 這是這個排序存在的理由。
    if (aUsed !== bUsed) return aUsed ? -1 : 1
    if (aUsed && bUsed) return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
    return b.updatedAt - a.updatedAt
  })
}

/**
 * 給清單列顯示的「最後使用」相對時間。
 *
 * 為什麼不用現成的 `formatDateTime`(`2026/10/05 14:32`):清單欄只有 247px,
 * 而那一列已經放了「內容前 40 字 · 日期」。再塞一個完整日期會把日期擠到看不見。
 * 使用者在這裡要問的問題是「這是不是我剛剛講的那份」,**相對時間直接回答它**。
 *
 * 回傳 `null` 代表「從沒用過」—— 呼叫端應該完全不顯示這一段,而不是顯示
 * 「從未使用」:那四個字會佔掉半個欄位寬度,對一個大多數時候是預期狀態的
 * 事情說得太大聲。
 *
 * 邊界值刻意寫死並附理由(見單元測試):這些數字是「使用者會不會覺得奇怪」的
 * 分界,不是從任何規格推導出來的。
 */
export function formatLastUsed(lastUsedAt: number | undefined, now: number): string | null {
  if (lastUsedAt == null) return null
  const diff = now - lastUsedAt
  // 未来時間(時鐘被調過、或測試資料寫錯)不顯示「-3 分鐘」那種看不懂的東西。
  if (diff < 0) return '剛剛'
  const minute = 60_000
  if (diff < minute) return '剛剛'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分鐘前`
  const hour = 60 * minute
  if (diff < 24 * hour) return `${Math.floor(diff / hour)} 小時前`
  const day = 24 * hour
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  // 超過一週之後相對時間開始變得冗長而且要心算,改回絕對日期。
  const d = new Date(lastUsedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}
