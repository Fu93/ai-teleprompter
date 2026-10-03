/**
 * quitGuard.ts — App 退出前把「正在錄的會議」救回來。
 *
 * ## 這裡補的是哪一個洞
 *
 * 逐字稿全程住在 renderer 的 React state,只有按下「停止」才寫進 IndexedDB。
 * 而 main 端本來有一道「未存變更」守衛(`state.closeBlocker`),按 X 會問使用者。
 * **但 `before-quit` 會無條件呼叫 `markQuitting()`,直接繞過那道守衛。**
 *
 * 繞過是必要的(OS 關機時沒有人能回答對話框,否則使用者會看到「關機被一個
 * 程式的確認框卡住」),但它的後果是:
 *
 *   - 使用者正在錄音,筆電合蓋 / 選「重新啟動」/ 系統更新 → 整場會議**靜默消失**
 *   - `autoInstallOnAppQuit = true`:自動更新下載完後退出安裝 → 同上
 *
 * 這兩條路徑完全不需要任何「定期草稿」就能堵:我們不需要在錄音期間一直存檔,
 * 只需要在**真的要退出**的那一刻,把手上已有的東西存下來一次。
 *
 * ## 為什麼是「擋一次、存完再退」而不是「同步存」
 *
 * `before-quit` 可以 `preventDefault()`,把退出取消掉,做完工作再 `app.quit()`。
 * 第二次 `app.quit()` 會再觸發一次 `before-quit` —— 那時必須放行,否則無限迴圈。
 * 這個「第二次要放行」是整個模組唯一真正需要小心的地方,所以它是一個明確的
 * 三態機器,而不是幾個散落的布林。
 *
 * ## 逾時一律退出
 *
 * Windows 對 `WM_QUERYENDSESSION` 給的時間很有限,而使用者寧可少救一點資料,
 * 也不要「關機被卡住」。所以 flush 有上限,逾時就直接放行。
 */

export type QuitFlushState =
  /** 還沒人要求退出 */
  | 'idle'
  /** 第一次退出請求被擋下,正在存檔 */
  | 'flushing'
  /** 存檔完成(或逾時放行),接下來是真的退出 */
  | 'flushed'

/** flush 預設上限。夠 IndexedDB 寫一次,不夠就卡住關機。 */
export const QUIT_FLUSH_TIMEOUT_MS = 3000

export interface QuitGuardDeps {
  /** 主進程視角:現在有沒有正在錄音 */
  isRecording: () => boolean
  /** 要 renderer 把目前的逐字稿寫進 IndexedDB */
  flush: () => Promise<unknown>
  /** 標記「接下來是真的退出」,讓視窗關閉守衛讓路 */
  markQuitting: () => void
  /** 再次要求退出。flush 結束後呼叫一次就夠 */
  requestQuit: () => void
  log: (msg: string) => void
  timeoutMs?: number
}

export interface QuitGuard {
  /** 掛到 app.on('before-quit') */
  handleBeforeQuit: (e: { preventDefault: () => void }) => void
  /** 目前狀態(測試與診斷用) */
  state: () => QuitFlushState
}

export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  const timeoutMs = deps.timeoutMs ?? QUIT_FLUSH_TIMEOUT_MS
  let state: QuitFlushState = 'idle'

  /** flush 結束後統一收斂:標記 + 真的要求退出。只會走到一次。 */
  const finish = (how: string): void => {
    if (state === 'flushed') return
    state = 'flushed'
    deps.markQuitting()
    deps.log(`退出前存檔完成(${how})`)
    deps.requestQuit()
  }

  const runFlush = (): void => {
    // 逾時與 flush 本身的完成誰先到誰贏。兩條路都只會呼叫一次 finish。
    const timer = setTimeout(() => finish('逾時'), timeoutMs)

    const settle = (how: string, err?: unknown): void => {
      clearTimeout(timer)
      if (err !== undefined) {
        // 存檔失敗**不能**阻止退出 —— 使用者此刻正要關機,擋住他只會更糟。
        // 失敗要留下痕跡,否則下次看到「少了一場會議」完全無從追查。
        deps.log(`退出前存檔失敗:${err instanceof Error ? err.message : String(err)}`)
      }
      finish(how)
    }

    // **同步呼叫** flush,不要丟進 microtask。
    //
    // 為什麼:handleBeforeQuit 一返回,Electron 就往下走退出流程。把 flush 放在
    // `.then()` 裡等於「請求已經出發」這件事要等到 microtask 清空才成立 ——
    // 而那一刻整個退出路徑可能已經往下走了。同步呼叫讓存檔請求在事件處理
    // 期間就已經在途。(這也是測試逼出來的:寫測試時發現 flush 根本沒被叫到。)
    //
    // 順帶要自己接住**同步**拋錯:renderer 可能已經死掉,那時
    // executeJavaScript 是直接 throw 而不是回一個 rejected promise。
    let p: Promise<unknown>
    try {
      p = Promise.resolve(deps.flush())
    } catch (err) {
      settle('失敗', err)
      return
    }
    p.then(
      () => settle('成功'),
      (err: unknown) => settle('失敗', err)
    )
  }

  const handleBeforeQuit = (e: { preventDefault: () => void }): void => {
    if (state === 'flushing') {
      // 第二次請求:多半是我們自己 flush 完呼叫 requestQuit 觸發的,
      // 也可能是 OS 又要求退出(使用者改了主意)。兩種情況都**不能擋** ——
      // 擋下去就是「關機被卡住」,那比少存一份會議嚴重得多。
      deps.log('退出請求重複:放行(不阻擋關機)')
      deps.markQuitting()
      return
    }
    if (state === 'flushed') {
      deps.markQuitting()
      return
    }
    // state === 'idle'
    if (!deps.isRecording()) {
      // 沒在錄音就維持原本行為:直接退,不增加任何延遲。
      deps.markQuitting()
      return
    }
    e.preventDefault()
    state = 'flushing'
    deps.log('錄音中收到退出請求:先存檔再退')
    runFlush()
  }

  return { handleBeforeQuit, state: () => state }
}
