/**
 * scriptDraft.ts — 「新講稿」按鈕的空稿重用規則(純函式,給單元測試釘住)。
 *
 * 為什麼要抽出來:
 *   「新講稿」原本每按一下就 db.scripts.add() 一筆 —— 連點兩下就是兩份
 *   「未命名講稿」,而且**兩份都是空的**。對照範例稿那顆鈕(loadDemo)有
 *   demoBusy 連點防護,這裡卻沒有:同一頁同一種動作,兩種標準。
 *   而空稿會一直留在清單裡(「未命名講稿 · (空白)」),清單越用越髒。
 *
 * 規則只有一條主軸:目前這份稿還是一份「還沒開始寫」的空稿時,
 * 「新講稿」不該另建 —— 使用者要的東西已經在畫面上了。
 */

/** 與 newScript 建立新稿時寫入的標題一致(見 pages/Scripts.tsx) */
export const UNTITLED_TITLE = '未命名講稿'

export interface DraftLike {
  title: string
  content: string
}

/**
 * 目前的草稿是否就是一份「還沒開始寫」的空稿 —— 是的話「新講稿」直接重用它。
 *
 * @param dirty 有未存變更。true 一律不重用:呼叫端此時剛問過「放棄變更並新增」,
 *              那是一個明確的「我要一份新的」,重用會把那個決定吃掉。
 */
export function shouldReuseEmptyDraft(draft: DraftLike, dirty: boolean): boolean {
  if (dirty) return false
  const title = draft.title.trim()
  return draft.content.trim() === '' && (title === '' || title === UNTITLED_TITLE)
}
