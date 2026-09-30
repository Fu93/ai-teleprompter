import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 圖層順序:toast 必須在確認對話框之上。
 *
 * 為什麼這需要一條測試:
 *   ToastHost 與 ConfirmDialog 各自帶著 z-index class,沒有任何東西把它們綁在一起。
 *   ConfirmDialog 的遮罩是滿版 `fixed inset-0` + `bg-black/55`,一旦它的 z-index 比
 *   toast 高,「對話框開著時發出的錯誤提示」就會被壓到陰影裡 —— 而把錯誤 toast
 *   停留拉到 12 秒的全部理由就是「錯誤不能被錯過」,被自己家的對話框蓋掉就白留了。
 *
 * 為什麼讀原始碼而不是算 DOM:
 *   z-index 必須是 Tailwind 認得的字面值(z-[90]),不能從常數插值出來,
 *   所以沒有辦法在 runtime 比較兩層的實際堆疊順序。斷言原始碼裡的數字是
 *   這個專案唯一能真正釘住契約的方式,錯了就是錯了,不會有例外。
 */
// __tests__ → lib → src → renderer → src → repo root
const root = join(__dirname, '..', '..', '..', '..', '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

/** 檔案裡出現的所有 z-[N] 數字 */
function zIndicesOf(src: string): number[] {
  return [...src.matchAll(/z-\[(\d+)\]/g)].map((m) => Number(m[1]))
}

describe('toast 與確認對話框的圖層順序', () => {
  const toast = read('src/renderer/src/components/ToastHost.tsx')
  const confirm = read('src/renderer/src/components/ConfirmDialog.tsx')

  it('toast 的 z-index 高於確認對話框的 z-index', () => {
    const toastZ = Math.max(...zIndicesOf(toast))
    const confirmZ = Math.max(...zIndicesOf(confirm))
    expect(toastZ).toBeGreaterThan(confirmZ)
    // 把實際數字寫出來:改錯時這個訊息會直接告訴你現在是幾
    expect({ toastZ, confirmZ }).toEqual({ toastZ: 90, confirmZ: 80 })
  })

  it('兩個檔案都還找得到 z-[N](有人把 class 改掉時這裡會先爆)', () => {
    expect(zIndicesOf(toast).length).toBeGreaterThan(0)
    expect(zIndicesOf(confirm).length).toBeGreaterThan(0)
  })

  it('確認對話框的遮罩是滿版半透明 —— 這就是 toast 必須在其上的原因', () => {
    expect(confirm).toMatch(/fixed inset-0/)
    expect(confirm).toMatch(/bg-black\/\d+/)
  })
})
