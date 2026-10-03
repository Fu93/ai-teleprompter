/**
 * update.ts — 「有更新待安裝」的單一出處。
 *
 * 為什麼不能像原本那樣把狀態放在設定頁的 useState:
 *
 *   1. **它是一次性事件。** main 在 `update-downloaded` 廣播,而 renderer 的
 *      訂閱是在 mount 時才建立的。更新預設在啟動 30 秒後下載完,那時使用者
 *      幾乎一定在總覽頁或別的頁 —— 事件送達時沒有任何訂閱者,就永遠丟了。
 *      之後才進設定頁的人看到的是空白,而 `autoInstallOnAppQuit` 會在他下次
 *      關閉 App 時默默換掉版本。
 *
 *   2. **主視窗可能根本不在。** 浮層模式下關掉主視窗是正常用法,那時
 *      `state.mainWindow` 是 null,廣播直接沒有收件人。
 *
 * 所以兩條路都要走:訂閱事件(即時)+ 掛載時回 `appInfo().updateInfo`(補問)。
 * 後者是這個模組存在的主要理由 —— 沒有它,「錯過了」與「沒有更新」不可分辨。
 */
import { create } from 'zustand'
import type { UpdateDownloadedInfo } from '@shared/types'

interface UpdateStore {
  info: UpdateDownloadedInfo | null
  /** 使用者按過「稍後」:同一次待安裝更新不再重複打擾 */
  dismissed: boolean
  set(info: UpdateDownloadedInfo | null): void
  dismiss(): void
}

export const useUpdate = create<UpdateStore>((set) => ({
  info: null,
  dismissed: false,
  set: (info) => set((s) => (s.info?.version === info?.version ? s : { info, dismissed: false })),
  dismiss: () => set({ dismissed: true })
}))

/**
 * 掛載時補問一次 main。
 *
 * 只在 mount 時呼叫一次:更新下載完成與畫面掛載沒有因果關係,而這是一個
 * 每次 render 都打一次 IPC 的東西 —— 放在 render 裡等於每秒打幾十次。
 */
export async function hydrateUpdate(): Promise<void> {
  try {
    const app = await window.api.appInfo()
    if (app.updateInfo) useUpdate.getState().set(app.updateInfo)
  } catch {
    // appInfo 失敗不阻擋啟動:拿不到更新資訊的最壞後果是看不到橫幅,
    // 而為它讓 App 起不來是典型的撿芝麻丟西瓜
  }
}

/** 訂閱即時事件;回傳解除訂閱函式。必須在 hydrateUpdate 之前呼叫,否則中間那段是空窗 */
export function watchUpdate(): () => void {
  return window.api.onUpdateDownloaded((info) => useUpdate.getState().set(info))
}
