/**
 * mirror.ts — 浮層鏡像模式的翻轉樣式(單一出處)。
 *
 * 為什麼需要它:鏡像模式是給**反射罩提詞器**用的(設定頁:「透過反射罩拍攝時
 * 使用(左右翻轉)」)。光路是「螢幕顯示反字 → 玻璃反射回正字」,所以凡是
 * 使用者會**讀**的文字都必須跟著翻轉;任何沒有翻轉的文字,透過玻璃看就是反的字。
 *
 * 這個前提在程式碼裡已經有一半被實現:工具列說明列與跟讀狀態條都在正文容器
 * 的 `scaleX(-1)` 內;但後來加的救援卡、提示條、讀數 chip 落在 transform 之外
 * (見 UX_FINDINGS 之六)。「某處忘了翻」要能被測,翻轉的決定就必須只有一份 ——
 * 全部呼叫同一個函式,拿掉任何一處的套用,真機探針才會紅在正確的地方。
 *
 * 為什麼不放在 @shared/overlayShapes:那個檔是幾何常數(尺寸/門檻),而且
 * renderer 與 main 共用;翻轉樣式只有 renderer 的 OverlayApp 與 RescueCard 用,
 * 放在 overlay 目錄裡離它的兩個消費者最近。
 *
 * 為什麼工具列**不**套用:按鈕是滑鼠操作(視覺位置=命中位置,翻轉會打掉
 * 肌肉記憶),說明列由 hover 觸發(直視螢幕,不是透過玻璃)。
 */
export function overlayMirrorStyle(mirror: boolean): string | undefined {
  return mirror ? 'scaleX(-1)' : undefined
}
