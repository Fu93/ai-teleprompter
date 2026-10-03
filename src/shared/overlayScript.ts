/**
 * overlayScript.ts — 「主視窗改稿之後,浮層要不要跟著換稿」的規則。
 *
 * ── 為什麼需要這個檔 ──
 *   這個 App 的主流程是「改一句稿 → 立刻上台講」。而浮層內容只會在
 *   OverlayShow 的那一刻收到一次:使用者在講稿頁存檔,浮層還在講三十分鐘前的
 *   舊版,而且沒有任何提示。提詞機最不能出錯的就是「螢幕上不是我剛才改的那段」。
 *
 * ── 為什麼不是「每次存檔都推送」 ──
 *   因為使用者同時在編輯 A 稿(浮層正在講 A)時,存檔 B 稿是很正常的操作
 *   (例如把另一場會議的逐字稿存成新講稿)。那時把浮層換成 B 稿,是**沒人要的
 *   內容搶走舞台** —— 比不同步更糟:上台講到別人的稿。
 *   所以判斷依據是「同一份稿」,而那需要一個身分,所以 payload 多了 scriptId。
 *
 * ── 為什麼規則住在 shared ──
 *   判斷在 main 端做(它才知道浮層此刻載入的是什麼),但規則本身是純函式:
 *   放這裡才能被單元測試釘住,而不是只能靠「開 App 試試看」。
 */
export interface OverlayScriptIdentity {
  scriptId?: number
}

/**
 * 這次存檔要不要推給浮層。
 *
 * 規則只有一條,但每一個分支都有理由:
 *   - 沒有 scriptId → 不同步。使用者是從別的地方存檔(備份還原、內建示範稿)，
 *     無法證明它就是浮層正在講的那一份,寧可不同步。
 *   - 浮層沒載過稿(last 為 null)→ 不同步。沒有舞台要更新。
 *   - 兩邊 scriptId 不同 → 不同步(使用者正在編輯別的稿)。
 *   - 兩邊相同 → 同步,這是使用者要的那件事。
 */
export function canSyncOverlayScript(
  last: OverlayScriptIdentity | null | undefined,
  next: OverlayScriptIdentity | null | undefined
): boolean {
  if (!last || next?.scriptId == null) return false
  return last.scriptId === next.scriptId
}