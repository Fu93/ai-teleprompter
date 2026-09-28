import { describe, it, expect } from 'vitest'
import { degrade } from '../utils'

/** 回歸:藥丸「下一個關鍵詞」從句中切字,曾顯示「，今天想跟」以逗號開頭 */
describe('degrade(漸進揭露)', () => {
  it('剝掉前導標點:從句中切出的關鍵詞不以標點開頭', () => {
    expect(degrade('，今天想跟大家分享三個重點', 4)).toBe('今天想跟')
    expect(degrade('。下一句是什麼', 3)).toBe('下一句')
  })

  it('切後結果若以標點開頭(切點落在標點),再剝一次', () => {
    // 「嗯，今天」→ trim 後切 2 = 「嗯，」?不:degrade 先剝前導再切;
    // 直接驗證不變量:結果永不以標點/空白開頭
    for (const input of ['，今天想跟大家說', '、其次是', '：結論如下', ' 嗯，好']) {
      expect(degrade(input, 3)).not.toMatch(/^[，。、；：！？．,\\.:;!?\\s]/)
    }
  })

  it('不影響正常輸入與原有行為', () => {
    expect(degrade('今天想跟大家分享', 4)).toBe('今天想跟')
    expect(degrade('短詞', 6)).toBe('短詞')
  })
})
