/**
 * closeGuard.ts — 「現在關掉會丟東西」的宣告與關閉確認流程。
 *
 * 為什麼需要:
 *   側欄切頁有未存變更的確認,但**關閉視窗沒有**。講稿編輯到一半、或正在錄音
 *   時直接關掉,內容靜默消失(Record 的 unmount 只做 stopAll,不寫 DB)。
 *   後者損失更徹底:切頁只是換畫面,關窗是整場會議沒了。
 *
 * 方向為什麼是 renderer → main:
 *   main 沒有辦法同步查詢 renderer 的狀態,所以由 renderer 主動上報
 *   `state.closeBlocker`(src/main/state.ts);main 的 close 事件只讀那個值。
 *   使用者回答後再走 confirmClose / cancelClose 回到 main。
 *
 * 與 ToastHost / ConfirmHost 同一套分工:狀態與流程在這裡,畫面在元件裡。
 */
import { useEffect } from 'react'
import { confirmDialog } from './confirm'

const guards = new Map<string, () => string | null>()
/** 上一次上報給 main 的值,避免每次 render 都打一次 IPC */
let reported: string | null = null

function currentBlocker(): string | null {
  for (const fn of guards.values()) {
    const msg = fn()
    if (msg) return msg
  }
  return null
}

function report(): void {
  const next = currentBlocker()
  if (next === reported) return
  reported = next
  void window.api?.setCloseBlocker?.(next)
}

/**
 * 同步讀取「此刻會丟什麼」。
 *
 * 為什麼需要同步版本(而且不能走 IPC):
 *   ErrorBoundary 的復原畫面要回答「你剛剛正在錄音 / 講稿沒存」。它若在
 *   `componentDidCatch` 之後才去問 main,拿到的一定是 null —— 因為崩潰時
 *   useCloseGuard 的 effect cleanup 會跟著跑,而 cleanup 的動作正是
 *   `report()` 把它清成 null。**這不是猜的:e2e 實測過,走 IPC 讀回來是空的。**
 *
 *   而 componentDidCatch 執行的當下,`reported` 還holding著真正的值。所以正確
 *   的做法是同步取,存在邊界的 state 裡,而不是事後再去查一個已經被清掉的來源。
 *
 * 這裡刻意不導出 currentBlocker(會即時問所有守衛):那在 cleanup 跑完之後
 * 同樣是 null。`reported` 是「上一次回報給 main 的值」,它的語意正好是
 * 「崩潰發生時,App 認為自己手上有什麼」。
 */
export function peekCloseBlocker(): string | null {
  return reported
}

/**
 * React 端的註冊方式。blocker 為 null 表示目前沒有阻擋。
 *
 * 用 hook 而不是叫呼叫端自己寫 useEffect,是因為「取消註冊」很容易寫錯
 * (條件式 `if (!blocker) return` 忘了回傳 undefined 就會在卸載時留著舊守衛)。
 */
export function useCloseGuard(name: string, blocker: string | null): void {
  useEffect(() => {
    if (!blocker) {
      // 沒有阻擋時也要確保清掉同名的舊守衛
      guards.delete(name)
      report()
      return undefined
    }
    guards.set(name, () => blocker)
    report()
    return () => {
      guards.delete(name)
      report()
    }
  }, [name, blocker])
}

/**
 * main 送來「有人想關視窗」時,顯示 App 內確認對話框。
 * 由 main.tsx 在啟動時安裝一次。
 */
export function installCloseGuard(): void {
  if (typeof window === 'undefined') return

  // 每次 renderer 啟動都先把 main 端殘留的 blocker 清掉。
  //
  // 為什麼需要:report() 只在 useCloseGuard 掛載/卸載時才會呼叫,而重載之後
  // 停在總覽頁時一個守衛都沒有 —— 此時 main 端的 state.closeBlocker 還是上一次
  // 的值。症狀是:錄音中按了 F5,接著按視窗的 X,跳出一個「正在錄音。請先按
  // 「停止並儲存」再關閉」但畫面上根本沒在錄音,而且只能選「放棄並關閉」才關得掉。
  //
  // 放在 installCloseGuard 而不是某個元件裡:它必須比任何 useCloseGuard 更早跑。
  if (window.api?.setCloseBlocker) {
    reported = null
    void window.api.setCloseBlocker(null)
  }

  if (!window.api?.onCloseRequested) return
  window.api.onCloseRequested((blocker) => {
    void confirmDialog({
      title: '結束前確認',
      body: `${blocker}\n\n繼續關閉會失去這些內容。`,
      confirmLabel: '放棄並關閉',
      variant: 'danger'
    }).then((ok) => {
      // 一定回覆一邊:main 那邊正在等,不回覆的話視窗要等到超時才關得掉
      if (ok) void window.api.confirmClose()
      else void window.api.cancelClose()
    })
  })
}
