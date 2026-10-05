/**
 * overlayMirror.test.ts — 鏡像翻轉樣式的單一出處。
 *
 * 回歸的是 UX_FINDINGS 之六:鏡像模式下正文/說明列/跟讀條有翻轉,而後來加的
 * 救援卡與提示條落在 transform 之外 —— 透過反射罩看全是反字。修法是讓所有
 * 「會被讀的表面」呼叫同一個 helper;這裡釘 helper 本身的兩側。真正的**套用**
 * (哪幾個表面呼叫了它)由真機探針量 computed transform —— 單元測試觸不到渲染。
 */
import { describe, expect, it } from 'vitest'
import { overlayMirrorStyle } from '../../overlay/mirror'

describe('overlayMirrorStyle', () => {
  it('開鏡像 → scaleX(-1)', () => {
    expect(overlayMirrorStyle(true)).toBe('scaleX(-1)')
  })

  it('關鏡像 → undefined(不寫 style,與既有行為一致)', () => {
    // 刻意回 undefined 而不是 'none':內容容器原本就是「關鏡像時不寫 transform」,
    // 換成 'none' 會讓 getComputedStyle 多出一條 no-op 宣告,干擾量測端比較。
    expect(overlayMirrorStyle(false)).toBeUndefined()
  })
})
