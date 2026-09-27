import { describe, it, expect } from 'vitest'
import { findBestMatch } from '../sttAligner'

const SENTENCES = [
  '歡迎大家今天的會議', // index 0
  '今天我們要討論新產品', // index 1
  '接下來交由產品經理說明', // index 2
  '最後請大家填寫回饋表單' // index 3
]

describe('findBestMatch', () => {
  it('輸入缺失/空陣列時回傳 currentIndex', () => {
    expect(findBestMatch('', SENTENCES, 0)).toBe(0)
    expect(findBestMatch('你好', null, 2)).toBe(2)
    expect(findBestMatch('你好', [], 1)).toBe(1)
  })

  it('轉錄字串過短時保持原位', () => {
    expect(findBestMatch('a', SENTENCES, 0)).toBe(0)
    expect(findBestMatch('hi', SENTENCES, 1)).toBe(1)
  })

  it('相似度高時回傳最匹配段落', () => {
    const idx = findBestMatch('今天我們要討論新產品', SENTENCES, 1)
    expect(idx).toBe(1)
  })

  it('相似度不足時維持 currentIndex', () => {
    const idx = findBestMatch('xyzqwertyuiopasdf', SENTENCES, 0)
    expect(idx).toBe(0)
  })

  it('忽略標點與大小寫差異', () => {
    const idx = findBestMatch('今天我們要討論新產品!', SENTENCES, 1)
    expect(idx).toBe(1)
  })
})
