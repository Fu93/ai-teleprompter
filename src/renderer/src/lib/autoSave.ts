/**
 * autoSave.ts — 「停止輸入 N 秒後自動存檔」的純邏輯。
 *
 * ## 為什麼不能只是把 save() 塞進 setTimeout
 *
 * 兩件事:
 *
 * 1. **自動存檔不能推內容到浮層。** 浮層同步是「改一句稿 → 立刻上台」這個
 *    明確動作的結果;沿用它的話,使用者每打完一個 debounce tick,浮層上正在
 *    講的那份稿就會跟著他的游標跳動。那不是自動存檔,那是持續打斷。
 *
 * 2. **自動存檔不能重新載入整個清單。** 那會在輸入停止後把整頁重排一次,
 *    使用者只看到列表閃一下。
 *
 * 所以「安靜寫入」和「正式儲存」是兩條路:前者只落盤,後者才連動清單與浮層。
 *
 * ## 為什麼這個模組特別在意 undo
 *
 * 自動存檔最直覺的寫法是「存完把正規化的標題 set 回去」,但**任何**寫回
 * 受控欄位的動作都可能把原生 Ctrl+Z 的堆疊截斷 —— 使用者按一次 Ctrl+Z,
 * 整段剛才打的字不見了,那是比沒有自動存檔更嚴重的體驗災難。
 *
 * 因此這個模式的唯一職責是「算時間」,不碰任何欄位值。
 */
export const AUTOSAVE_DELAY_MS = 1500

/**
 * 產生一個 debounce 函式。
 *
 * 刻意不提供 flush/cancel 的複雜生命週期:呼叫端只需要
 * 「改變 → 重設計時」與「卸載 → 取消」兩個動作,而後者可以靠回傳的 cancel。
 */
export function createAutosave(delayMs: number, run: () => void | Promise<unknown>): {
  /** 有變動時呼叫:重設計時。連續呼叫會不斷往後推。 */
  schedule: () => void
  /** 卸載或切換選取時呼叫:取消還沒落地的寫入。 */
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    cancel,
    schedule: () => {
      cancel()
      timer = setTimeout(() => {
        timer = null
        // **同步呼叫** run,不要丟進 microtask。
        //
        // 為什麼:debounce 到點的那一刻就該把寫入發出去。包成
        // Promise.resolve().then(run) 會讓「寫入已開始」這件事延後一個
        // microtask,而那個空窗裡呼叫端可能已經切換選取 —— 於是寫進去的
        // 是舊稿。(這是寫測試時發現的:run 根本沒被叫到。)
        //
        // 同步與非同步兩種失敗都要吃掉:同步丟錯若不接住會變成
        // setTimeout 回呼裡的例外(連呼叫端的 try/catch 都接不到),
        // 非同步的則會變成未處理的 rejection。兩者都只留在 console 裡,
        // 使用者看到的是「好像存了」。錯誤的顯示由呼叫端自己負責。
        try {
          void Promise.resolve(run()).catch(() => undefined)
        } catch {
          /* 見上 */
        }
      }, delayMs)
    }
  }
}
