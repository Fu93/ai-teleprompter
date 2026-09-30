import { useEffect } from 'react'

/**
 * useEscape — 統一的 Esc 處理。
 *
 * 為什麼需要這支:
 *   這個 App 在這一輪之前**完全沒有** Escape 處理(全 renderer 0 處)。
 *   後果是:除錯面板只能用標題列的 ✕ 關、元素挑選器一旦開啟就必須用滑鼠點完,
 *   校準頁的相機沒有鍵盤退出路徑,浮層的救援卡也關不掉 —— 對只用鍵盤的人來說
 *   這些都是死路。
 *
 * 為什麼集中一份而不是各處 addEventListener:
 *   已經開啟的浮層(救援卡、對話框)在上層時,下層的 Esc 不該同時生效。
 *   統一寫法 + `active` 參數讓「誰該吃這個 Esc」變成呼叫端明確的決定。
 *
 * 為什麼是 stopImmediatePropagation 而不是 stopPropagation:
 *   這裡的 handler 全部掛在 `window` 上 —— 同一個 target。DOM 的規則是
 *   `stopPropagation()` 只阻止事件「往其他節點」傳播,**對同一個節點上
 *   已經註冊的其他 listener 一點影響都沒有**。也就是說原本的寫法完全沒有
 *   分層效果:按一次 Esc 會把「取消確認對話框」與「關掉底下的除錯面板」
 *   一起觸發,使用者只想取消,面板卻跟著消失。
 *   `stopImmediatePropagation()` 才會擋下同 target 後面註冊的 listener;
 *   註冊順序即優先順序:**先註冊的先拿到 Esc**,後註冊的會被擋掉。
 *   App.tsx 裡 ConfirmHost 排在 DebugRoot 之前,所以「上層的對話框」正好先拿到 ——
 *   但這個順序是隱含契約,調換兩元件的 JSX 位置就會把優先級翻過來。
 */
export function useEscape(onEscape: () => void, active = true): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onEscape()
    }
    // capture:面板/對話框裡的子元素若也監聽 keydown,上層要能優先處理
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onEscape, active])
}
