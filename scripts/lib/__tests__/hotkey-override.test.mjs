/**
 * hotkey-override.test.mjs — 量測端自己的正確性。
 *
 * 這組測試守的是一個已經實際發生過的錯誤:`audit:states` 長期回報
 * `hotkey-conflict-stale`,看上去像產品的「過期警示」缺陷,實際上是
 * **稽核腳本清錯了東西** —— 它傳 `null`(解除覆寫)而不是 `[]`(清空),
 * 而在真的有熱鍵被佔走的機器上,警示會如實長回來。
 *
 * ## 為什麼這件事值得測
 *
 * 「量測端量錯了」是所有假綠燈裡最難抓到的一種:規則有測試、規則有實作、
 * 報告裡有問題 —— 每一格看起來都是對的,只有結論是錯的。
 * 而且它有個很舒服的掩護:**在乾淨的機器上,`null` 和 `[]` 的效果完全一樣。**
 * 所以本地跑會綠,量測端的錯只有在一顆熱鍵真的被別的程式佔走時才現形。
 *
 * ## 這組測試刻意用真的 store,不用 stub
 *
 * 「stub 必須是規則實際讀的那個 API」:這裡規則讀的是
 * `currentHotkeyConflicts()`,也就是 `forced ?? conflicts`。如果測試自己刻一份
 * 「null 代表清空」,那它會照著錯誤的假設轉綠,量到一個不存在的世界。
 * 所以這裡 import 產品自己的 hotkeys store,用 `forceAuditState` 當稽核橋,
 * 並且**先把真實衝突設成非空** —— 那才是會現形的那台機器。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { clearHotkeyOverride } from '../hotkey-override.mjs'

const HOTKEYS = '../../../src/renderer/src/lib/hotkeys'
const BRIDGE = '../../../src/renderer/src/lib/auditBridge'

/**
 * 真實的稽核橋:`forceAuditState` 就是頁面上 `window.__auditForce` 的本體。
 * 回傳包成 Promise,模擬 Playwright `evaluate` 的行為(一定吃 await)。
 */
function makeForce(bridge) {
  return async (arg) => {
    const r = await bridge.forceAuditState('app.hotkeyConflicts', arg)
    return { ok: r?.ok === true, error: r?.error }
  }
}

describe('熱鍵衝突覆寫的清空序列', () => {
  let hotkeys
  let bridge
  let off

  beforeEach(async () => {
    vi.resetModules()
    hotkeys = await import(HOTKEYS)
    bridge = await import(BRIDGE)
    off = hotkeys.installHotkeyConflictBridge()
  })

  afterEach(() => {
    off?.()
  })

  /**
   * 關鍵測試:在一台**真的有衝突**的機器上清空畫面。
   * 真實名單非空是這條規則的全部難度 —— 空名單時 `null` 與 `[]` 等價。
   */
  it('在真的有衝突的機器上,清空後畫面上的警示必須消失', async () => {
    hotkeys.useHotkeyConflictStore.setState({ conflicts: ['Alt+K'] })
    expect(hotkeys.currentHotkeyConflicts()).toEqual(['Alt+K'])

    let observed = null
    const result = await clearHotkeyOverride(makeForce(bridge), () => {
      observed = hotkeys.currentHotkeyConflicts()
      return { notice: observed.length > 0 }
    })

    expect(result.cleared).toBe(true)
    expect(result.released).toBe(true)
    expect(
      observed,
      '清空之後畫面上還看得到警示 —— 傳 null 只是解除覆寫,不是清空'
    ).toEqual([])
    expect(result.observed).toEqual({ notice: false })
  })

  it('量測發生在「清空」與「解除」之間(先解除再量,量到的就是真實衝突)', async () => {
    hotkeys.useHotkeyConflictStore.setState({ conflicts: ['Alt+K'] })
    const seen = []
    const force = async (arg) => {
      seen.push(arg)
      return await makeForce(bridge)(arg)
    }

    await clearHotkeyOverride(force, () => {
      // 記下量測那一刻的狀態,而不是事後回頭看
      seen.push(['measured', hotkeys.currentHotkeyConflicts()])
      return null
    })

    expect(seen[0]).toEqual([])
    expect(seen[1]).toEqual(['measured', []])
    expect(seen[2]).toBe(null)
  })

  it('結束後一定要解除覆寫 —— 否則後續狀態都在「假裝沒有衝突」的世界裡被量', async () => {
    hotkeys.useHotkeyConflictStore.setState({ conflicts: ['Alt+K'] })
    const result = await clearHotkeyOverride(makeForce(bridge), () => null)

    expect(result.released).toBe(true)
    // 解除之後回到的是真實名單(這台機器真的有 Alt+K 被佔走)
    expect(hotkeys.useHotkeyConflictStore.getState().forced).toBe(null)
    expect(hotkeys.currentHotkeyConflicts()).toEqual(['Alt+K'])
  })

  it('清空失敗時不量測、也不解除,並把原因交回呼叫端(避免報出一個沒量過的「沒問題」)', async () => {
    const force = async () => ({ ok: false, error: '沒有名為 app.hotkeyConflicts 的控制項' })
    let measured = false

    const result = await clearHotkeyOverride(force, () => {
      measured = true
      return null
    })

    expect(result.cleared).toBe(false)
    expect(result.released).toBe(false)
    expect(measured).toBe(false)
    expect(result.error).toContain('app.hotkeyConflicts')
  })

  it('稽核橋整個不存在(undefined)時算失敗,不算成功', async () => {
    const result = await clearHotkeyOverride(async () => undefined, () => null)
    expect(result.cleared).toBe(false)
    expect(result.error).toBe('ok=false')
  })

  it('解除失敗會被回報(留著空覆寫,後續每一格都不可信)', async () => {
    const calls = []
    const force = async (arg) => {
      calls.push(arg)
      return calls.length === 1 ? { ok: true } : { ok: false, error: 'unregister 失敗' }
    }

    const result = await clearHotkeyOverride(force, () => '量到了')

    expect(result.cleared).toBe(true)
    expect(result.released).toBe(false)
    expect(result.error).toBe('unregister 失敗')
    expect(result.observed).toBe('量到了')
  })
})