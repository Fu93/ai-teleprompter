/**
 * hotkey-override.mjs — 「把熱鍵衝突警示收回來」的正確呼叫序列。
 *
 * ## 這支存在的理由:兩個值長得幾乎一樣,意思完全不同
 *
 * `src/renderer/src/lib/hotkeys.ts` 的 store 有兩個欄位:
 *
 *     conflicts  main 回報的**真實**衝突名單
 *     forced     稽核覆寫值;`currentHotkeyConflicts()` 回傳 `forced ?? conflicts`
 *
 * 所以對稽核橋來說:
 *
 *     __auditForce('app.hotkeyConflicts', [])    → forced = []      → 畫面**清空**
 *     __auditForce('app.hotkeyConflicts', null)  → forced = null    → 畫面回到**真實**名單
 *
 * 「清空畫面」與「解除覆寫」在乾淨的機器上**看起來一模一樣**(真實名單是空的),
 * 於是前者被寫成後者並且通過了 —— 這是本專案的第五個假綠燈。
 * 而在真的有衝突的機器上,解除覆寫會讓警示**長回來**:audit:states 長期回報
 * `hotkey-conflict-stale`(衝突清單清空後畫面上還留著警示),
 * 看上去像產品的過期警示缺陷,實際上是量測端量錯了東西。
 *
 * 這正是 `scripts/lib/effect-inventory.mjs` 裡 `preflight.models` 那條註解
 * 記過的同一個坑:覆寫的清理語意必須**明確**,不能靠「解除之後看起來沒事」
 * 來驗。
 *
 * ## 為什麼要抽成一支可測的函式
 *
 * 這兩行原本內嵌在 `audit-states.mjs` 的 `phaseHotkeys()` 裡。內嵌的時候
 * 它不可能有測試 —— 而「量測端自己錯了」正是最需要測試、卻最容易被漏掉的
 * 那一類。抽出來之後,`__tests__/hotkey-override.test.mjs` 可以真的驅動
 * **產品自己的 store**,在一台「真的有衝突」的機器上驗證:
 * 傳 `null` 收不回畫面,傳 `[]` 才收得回來。
 */

/**
 * 把熱鍵衝突的稽核覆寫設成「空」,量測畫面,然後把覆寫**解除**掉。
 *
 * 順序有意義:量測必須發生在「forced = []」與「forced = null」之間。
 * 先解除再量,量到的就是真實衝突 —— 也就是這支函式要修的那個錯誤。
 *
 * @param {(arg: string[] | null) => Promise<{ ok?: boolean, error?: string } | undefined>} force
 *        稽核橋的呼叫端(page.evaluate 的結果)。傳 null = 解除覆寫。
 * @param {() => unknown} measure
 *        在「畫面應該是空的」那一刻做量測;回傳值原封不動交還給呼叫端。
 * @returns {Promise<{cleared: boolean, released: boolean, observed: unknown, error: string|null}>}
 */
export async function clearHotkeyOverride(force, measure) {
  // 第一步:明確覆寫成空清單。這才是「清空畫面」。
  const cleared = await force([])
  if (!cleared?.ok) {
    return { cleared: false, released: false, observed: null, error: cleared?.error ?? 'ok=false' }
  }

  // 第二步:趁畫面應該是空的時候量。
  const observed = await measure()

  // 第三步:解除覆寫,讓後續狀態回到這台機器的**真實**情況。
  // 少了這一步,後面每一個狀態都會在一個「假裝沒有衝突」的世界裡被量 ——
  // 那正是另一種形式的假綠燈,而且看不出來。
  const released = await force(null)
  return {
    cleared: true,
    released: released?.ok === true,
    observed,
    error: released?.ok === true ? null : (released?.error ?? 'ok=false')
  }
}