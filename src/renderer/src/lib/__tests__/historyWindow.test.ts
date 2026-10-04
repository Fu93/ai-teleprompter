import { describe, expect, it } from 'vitest'
import { historyCountLabel, historyMoreLabel, nextHistoryShown } from '../historyWindow'

describe('historyWindow — 歷史清單的載入視窗', () => {
  it('nextHistoryShown:一次多拿一頁,不超過總數', () => {
    expect(nextHistoryShown(15, 42)).toBe(35)
    expect(nextHistoryShown(15, 20)).toBe(20)
  })

  it('nextHistoryShown:已經到底就不再成長(shown 不會倒退)', () => {
    expect(nextHistoryShown(15, 15)).toBe(15)
    expect(nextHistoryShown(15, 3)).toBe(15)
  })

  it('historyCountLabel:還有沒顯示的才說明;全顯示了不囉嗦', () => {
    expect(historyCountLabel({ shown: 15, total: 42 })).toBe('顯示最近 15 筆 / 共 42 筆')
    expect(historyCountLabel({ shown: 15, total: 15 })).toBeNull()
    expect(historyCountLabel({ shown: 15, total: 2 })).toBeNull()
  })

  it('historyMoreLabel:按鈕文字帶的是這一頁真的拿得到的筆數', () => {
    expect(historyMoreLabel({ shown: 15, total: 42 })).toBe('再載入 20 筆')
    expect(historyMoreLabel({ shown: 15, total: 22 })).toBe('再載入 7 筆')
    expect(historyMoreLabel({ shown: 15, total: 15 })).toBeNull()
    expect(historyMoreLabel({ shown: 15, total: 10 })).toBeNull()
  })
})
