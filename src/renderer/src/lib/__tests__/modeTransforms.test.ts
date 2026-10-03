import { describe, expect, it } from 'vitest'
import { buildKaraokeChunks, tokenGapAt, tokenizeForKaraoke } from '../teleprompter/modeTransforms'

describe('tokenizeForKaraoke 逐詞切分', () => {
  it('連續 3 字以上的中文片段逐字一塊', () => {
    expect(tokenizeForKaraoke('大家好')).toEqual(['大', '家', '好'])
  })

  it('雙字詞保持完整(逐字會把「走吧」的節奏切碎)', () => {
    expect(tokenizeForKaraoke('走吧')).toEqual(['走吧'])
  })

  it('拉丁/數字連續串是一個詞,小數點不拆(1.4 是一個 tick 的詞)', () => {
    expect(tokenizeForKaraoke('做到了 1.4 秒')).toEqual(['做', '到', '了', '1.4', '秒'])
  })

  it('句尾半形句點掛前一塊尾巴,不自己吃一個 tick', () => {
    expect(tokenizeForKaraoke('Nice check.')).toEqual(['Nice', 'check.'])
  })

  it('標點掛在前一塊尾巴(高亮停在標點上 = 一次換氣)', () => {
    expect(tokenizeForKaraoke('走吧,該出發了。')).toEqual(['走吧,', '該', '出', '發', '了。'])
  })

  it('行首標點不成孤兒掛下一塊開頭,雙字詞仍完整', () => {
    expect(tokenizeForKaraoke('…好吧')).toEqual(['…好吧'])
  })

  it('中英混稿:英文單字整詞、中文雙字詞整塊、長句逐字', () => {
    expect(tokenizeForKaraoke('把 latency 壓到 200ms 以內')).toEqual([
      '把',
      'latency',
      '壓到',
      '200ms',
      '以內'
    ])
  })

  it('空白全部丟掉,不產生空 token', () => {
    const tokens = tokenizeForKaraoke('  a  b  測  試  ')
    expect(tokens).toEqual(['a', 'b', '測', '試'])
    expect(tokens.every((t) => t.length > 0)).toBe(true)
  })
})

describe('buildKaraokeChunks 逐詞塊', () => {
  it('無斜線時以換行分塊,每塊再做逐詞切分', () => {
    const { chunks, wordChunks } = buildKaraokeChunks('第一行文字\n第二行')
    expect(chunks).toEqual(['第一行文字', '第二行'])
    expect(wordChunks[0]).toEqual(['第', '一', '行', '文', '字'])
    expect(wordChunks[1]).toEqual(['第', '二', '行'])
  })

  it('有斜線時以斜線分塊', () => {
    const { chunks, wordChunks } = buildKaraokeChunks('開場/重點一/結語')
    expect(chunks).toEqual(['開場', '重點一', '結語'])
    expect(wordChunks).toHaveLength(3)
  })

  it('中文不再整行一詞(回歸:split(" ") 時 30 字的行只有 1 個詞)', () => {
    const { wordChunks } = buildKaraokeChunks('這是一段三十個字左右的中文提詞內容,用來驗證逐詞高亮的粒度是否合理。')
    expect(wordChunks[0].length).toBeGreaterThan(10)
  })
})

describe('tokenGapAt 詞距判斷', () => {
  const spacing = [true, false, true]

  it('索引 0 一律沒有詞距(前面沒有塊)', () => {
    expect(tokenGapAt(spacing, 0)).toBe(false)
  })

  it('有資料時照表;false = 中文逐字序列不拉開字距', () => {
    expect(tokenGapAt(spacing, 1)).toBe(false)
    expect(tokenGapAt(spacing, 2)).toBe(true)
  })

  it('缺資料時回到「有詞距」的舊語意,不靜默黏成整串', () => {
    expect(tokenGapAt(undefined, 3)).toBe(true)
    expect(tokenGapAt([], 1)).toBe(true)
    expect(tokenGapAt(spacing, 99)).toBe(true)
  })
})
