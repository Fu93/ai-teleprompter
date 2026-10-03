/**
 * overlayScript.test.ts — 「主視窗改稿後,浮層要不要跟著換稿」的規則。
 *
 * 這條規則決定了兩件使用者會直接感受到的事:
 *   1. 站在台上講的是不是他剛剛改的那段(改了沒同步 = 講舊稿)。
 *   2. 他編輯 A 稿時存檔 B 稿,浮層**不會**被換掉(被換掉 = 講到別人的稿)。
 * 兩件都不能錯,所以規則是純函式、在這裡被釘住,而不是靠「開 App 試試看」。
 */
import { describe, it, expect } from 'vitest'
import { canSyncOverlayScript } from '../overlayScript'

describe('canSyncOverlayScript', () => {
  it('浮層正在講同一份稿 → 同步', () => {
    expect(canSyncOverlayScript({ scriptId: 5 }, { scriptId: 5 })).toBe(true)
  })

  it('正在講別的稿 → 不同步(存 B 稿不該把 A 稿的舞台搶走)', () => {
    expect(canSyncOverlayScript({ scriptId: 5 }, { scriptId: 6 })).toBe(false)
  })

  it('這次存檔沒有帶 scriptId → 不同步(無法證明是同一份)', () => {
    expect(canSyncOverlayScript({ scriptId: 5 }, {})).toBe(false)
  })

  it('浮層從沒載過稿 → 沒有舞台要更新', () => {
    expect(canSyncOverlayScript(null, { scriptId: 5 })).toBe(false)
    expect(canSyncOverlayScript(undefined, { scriptId: 5 })).toBe(false)
  })

  it('兩邊都沒有 scriptId → 不同步(不能把「內容碰巧一樣」當成同一份)', () => {
    expect(canSyncOverlayScript({}, {})).toBe(false)
  })
})
