/**
 * importJsonFile.ts — 讀入使用者選的備份檔,**先驗大小再讀內容**。
 *
 * ## 為什麼要抽出來
 *
 * 這段邏輯原本寫在 ipc.ts 的 ImportJsonFile handler 裡,而 ipcMain.handle 註冊的是
 * 閉包 —— 單元測試根本觸不到它(該檔自己的註解也提過這件事:「ipc.ts 的 handler
 * 是 Electron 註冊的閉包,單元測試觸不到,所以 ollama.ts 的三個函式是唯一能用
 * fake fetch 驗證的接縫」)。留著就只能靠 e2e 點兩下滑鼠來驗證「檔案太大」,
 * 而沒有人會為了測一個分支去造一個 64MB 的檔案 —— 也就是說**這個缺陷之所以能
 * 活到現在,是因為它沒有接縫可測**。抽成純模組是讓它可測的前提。
 *
 * ## 這裡修的是哪一個缺陷
 *
 * 原來的順序是:
 *
 *   const info = await stat(filePath)
 *   const text = await readFile(filePath, 'utf-8')   // ← 整份讀進記憶體
 *   ...
 *   if (info.size > max) return { ok:false, error:'檔案太大…' }
 *
 * 註解說「避免使用者誤選一個巨大的 JSON 而把 renderer 的字串處理拖死」,但程式碼
 * 做的正好相反:**先把整份讀進來,才丟掉**。所以那個上限實際上只擋得住「讀完之後
 * 覺得太大」,擋不住任何記憶體風險 —— 使用者選到一個 2GB 的檔案,main 進程會
 * 先把它整份塞進 heap,然後才回一句「檔案太大」。而在錄音中的話,OOM 會把整場
 * 會議一起帶走。
 *
 * 修法就是把順序倒過來:stat 拿到大小,超標**立刻**回,碰都不碰檔案內容。
 *
 * ## 刻意不做的兩件事
 *
 * 1. **不截斷。** 截斷出來的 JSON 解析失敗,錯誤訊息比「檔案太大」難懂得多。
 * 2. **不用 stream 讀。** 這是備份檔,正常幾百 KB。真正的需求只有「別在超標時
 *    把它讀進來」,stream 會讓這段程式碼複雜到要單獨測 stream 行為,得不償失。
 */
import { readFile, stat } from 'fs/promises'

/** 備份檔大小天花板。正常是幾百 KB;64MB 已經遠超過任何合理的備份。 */
export const DEFAULT_MAX_BACKUP_BYTES = 64 * 1024 * 1024

export interface ImportJsonDeps {
  stat: (p: string) => Promise<{ size: number }>
  readFile: (p: string, enc: 'utf-8') => Promise<string>
}

export type ImportJsonResult =
  | { ok: true; filePath: string; text: string }
  | { ok: false; error: string }

const defaultDeps: ImportJsonDeps = { stat, readFile }

/**
 * 讀入備份檔。超過 maxBytes 時**不會**把內容讀進來。
 *
 * 回傳 { ok:false } 而不是 throw 的有兩種情形:使用者取消對話框(不該是錯誤訊息)
 * 與檔案太大。真正讀不到(檔案被移走/權限不足)才會 throw —— 那是異常,該被
 * 上層轉成「讀取備份檔失敗(…)」。
 */
export async function importJsonFile(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_BACKUP_BYTES,
  deps: ImportJsonDeps = defaultDeps
): Promise<ImportJsonResult> {
  // ── 第一關:大小。在讀任何內容之前。──
  // 順序有意義,這整個模組存在的理由就是它:先 readFile 再檢查 size 等於沒有上限。
  let size: number
  try {
    size = (await deps.stat(filePath)).size
  } catch (err) {
    throw new Error(`讀取備份檔失敗(${err instanceof Error ? err.message : String(err)})`)
  }
  if (size > maxBytes) {
    // 單位刻意用 MB 顯示:使用者看到「檔案太大(2048MB)」比看到位元組數有用。
    return {
      ok: false,
      error: `檔案太大（${Math.round(size / 1024 / 1024)}MB）,這不像是備份檔。`
    }
  }

  // ── 第二關:通過上限才真的讀內容。──
  try {
    return { ok: true, filePath, text: await deps.readFile(filePath, 'utf-8') }
  } catch (err) {
    throw new Error(`讀取備份檔失敗(${err instanceof Error ? err.message : String(err)})`)
  }
}
