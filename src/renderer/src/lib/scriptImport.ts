/**
 * scriptImport.ts — 匯入講稿檔案時的「這是合理的講稿嗎」判斷。
 *
 * ── 為什麼需要 ──
 *   講稿匯入原本是 `await file.text()` 然後整份塞進 draft:沒有任何大小上限。
 *   檔案選擇框什麼都收,於是選到一個 800MB 的影片、整包 node_modules,或一份
 *   客戶資料備份時,renderer 會把它整份讀成字串 —— 主執行緒卡住、記憶體被吃掉,
 *   而畫面上唯一能看到的反應是「匯入中」然後整個 App 沒反應。使用者不會知道
 *   自己選錯了檔案,只會知道這個提詞機很脆弱。
 *
 * ── 上限為什麼是 2MB ──
 *   這是**文字稿**的上限,不是任何檔案的上限。2MB 的中文約 60–70 萬字,是一場
 *   四小時的逐字稿再乘兩倍 —— 超過這個量級的東西已經不是一份講稿,使用者多半
 *   是選錯檔案(備份檔、影音、資料庫 dump)。
 *
 *   刻意**不**把這個上限套到備份匯入上:備份本來就會隨使用者的資料量長大,
 *   幾十 MB 很正常,拿講稿的上限去擋它會擋掉真正的備份。兩個入口的合理上限不同,
 *   把它們混成一個共用常數只會讓其中一個錯。
 */
export const MAX_SCRIPT_IMPORT_BYTES = 2 * 1024 * 1024

/** 人話的檔案大小(使用者看到的是 MB,不是 bytes)。 */
function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 檔案太大時要顯示的訊息;在上限之內(或拿不到大小)回傳 null 代表可以匯入。
 *
 * 訊息刻意指出「選錯檔案」這個可能:使用者剛才做的事就是按了檔案選擇框,
 * 而「匯入失敗」對他毫無幫助。
 */
export function describeImportTooLarge(
  size: number | undefined,
  max: number = MAX_SCRIPT_IMPORT_BYTES
): string | null {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= max) return null
  return `這個檔案是 ${mb(size)},超過講稿匯入的上限 ${mb(max)}。講稿是文字稿 —— 大到這種程度通常不是選錯了檔案(例如影片或資料備份)。請確認後再匯入一次。`
}