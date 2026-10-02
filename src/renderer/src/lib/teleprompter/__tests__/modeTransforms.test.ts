import { describe, it, expect } from 'vitest'
import {
  buildKaraokeChunks,
  buildBulletFallback,
  splitSingleBullet,
  tokenizeForKaraoke,
  tokenizeKaraokeChunk,
  tokenGapAt
} from '../modeTransforms'

describe('buildKaraokeChunks', () => {
  it('含 "/" 時以 "/" 分塊', () => {
    const { chunks, wordChunks } = buildKaraokeChunks('甲 / 乙 丙 / 丁')
    expect(chunks).toEqual(['甲', '乙 丙', '丁'])
    expect(wordChunks).toEqual([['甲'], ['乙', '丙'], ['丁']])
  })

  it('不含 "/" 時以換行分塊並過濾空白行', () => {
    const { chunks, wordChunks } = buildKaraokeChunks('第一 行\n\n第二 行')
    expect(chunks).toEqual(['第一 行', '第二 行'])
    expect(wordChunks).toEqual([['第一', '行'], ['第二', '行']])
  })

  it('去除每 chunk 的多餘空白詞', () => {
    const { chunks } = buildKaraokeChunks('  hello   world  ')
    expect(chunks).toEqual(['hello   world'])
  })

  it('spacing 與 wordChunks 對齊:每塊的邊界數 = 詞數', () => {
    const { wordChunks, spacing } = buildKaraokeChunks('第一 行\n這是一段沒有空白的中文句子')
    expect(spacing).toHaveLength(wordChunks.length)
    spacing.forEach((s, i) => expect(s).toHaveLength(wordChunks[i].length))
  })
})

describe('tokenGapAt（渲染層的詞距判斷,資料缺漏時的降級方向）', () => {
  it('spacing 齊全時照 spacing 回應', () => {
    // spaceBefore = [true, true, false, false]:
    // token 1 前有空白(詞距)、token 2 前沒有(貼著)、token 3 前沒有
    expect(tokenGapAt([true, true, false, false], 0)).toBe(false)
    expect(tokenGapAt([true, true, false, false], 1)).toBe(true)
    expect(tokenGapAt([true, true, false, false], 2)).toBe(false)
    expect(tokenGapAt([true, true, false, false], 3)).toBe(false)
  })

  /**
   * 這條是降級方向的缺陷記錄。舊的渲染語意是「每個詞之間都有詞距」,而
   * `model.karaokeTokenSpacing[i] ?? []` 在資料缺漏時會讓**每一個**邊界都變成
   * 「沒有詞距」:英文逐詞高亮整串黏在一起、看不到分隔,而且沒有任何錯誤訊息。
   * 寧可退回舊語意(多一點詞距,只是醜)也不要靜默降級成不可讀。
   */
  it('spacing 缺漏時回到「每個詞都有詞距」的舊語意,而不是全部沒有', () => {
    // 索引 0 沒有前一塊,詞距由前一個 token 承擔
    expect(tokenGapAt(undefined, 0)).toBe(false)
    expect(tokenGapAt([], 3)).toBe(true)
    // 短陣列:超出長度的索引同樣退回舊語意
    expect(tokenGapAt([true], 5)).toBe(true)
  })
})

describe('tokenizeForKaraoke(空白優先的逐詞切分)', () => {
  it('空白 = 詞邊界;三字以上的連續中文才逐字切', () => {
    expect(tokenizeForKaraoke('第一 行')).toEqual(['第一', '行'])
    expect(tokenizeForKaraoke('這是一段中文')).toEqual(['這', '是', '一', '段', '中', '文'])
    expect(tokenizeForKaraoke('hello world')).toEqual(['hello', 'world'])
  })

  it('全形標點掛前一塊尾巴,不自己吃一個 tick', () => {
    expect(tokenizeForKaraoke('你好，世界！')).toEqual(['你好，', '世界！'])
    expect(tokenizeForKaraoke('今天天氣不錯。明天呢？')).toEqual([
      '今', '天', '天', '氣', '不', '錯。', '明', '天', '呢？'
    ])
  })

  it('百分比不被拆開(% 要在收尾標點表裡)', () => {
    expect(tokenizeForKaraoke('成長 50%')).toEqual(['成長', '50%'])
  })

  it('開引號掛下一塊開頭,與其內容同進退', () => {
    expect(tokenizeForKaraoke('（你好）')).toEqual(['（你好）'])
    expect(tokenizeForKaraoke('他說「hi」')).toEqual(['他說', '「hi」'])
  })

  /**
   * 這條是句首標點的缺陷記錄。`TRAILING_PUNCT && tokens.length > wordStart` 在
   * 標點位於**詞首**時不成立,於是落到 `emit(ch)` 產生一個獨立的符號 token ——
   * 高亮停在「，」上就是一格 280ms 的 tick,而不是一次換氣。
   * 修法:詞首沒有「前一塊」可掛時,與開引號同命運地掛到**下一塊開頭**。
   */
  it('句首的收尾標點不自己吃一個 tick（跨詞與句內兩種位置）', () => {
    // 句內、跨詞:掛到前一個詞的尾巴
    expect(tokenizeForKaraoke('你好 世界。')).toEqual(['你好', '世界。'])
    // 句首:前面沒有詞可掛,必須掛到下一個詞開頭,不能自己成塊
    // （逐字序列會切開,所以是掛在第一字上 —— 關鍵是「，」不獨立成塊）
    expect(tokenizeForKaraoke('，你好世界')).toEqual(['，你', '好', '世', '界'])
    // 省略號同理(兩個都沒被獨立成 token)
    expect(tokenizeForKaraoke('……好')).toEqual(['……好'])
  })

  it('spaceBefore 只在原文真的有空白的邊界為 true', () => {
    const { tokens, spaceBefore } = tokenizeKaraokeChunk('甲 乙丙丁')
    expect(tokens).toEqual(['甲', '乙', '丙', '丁'])
    expect(spaceBefore).toEqual([true, true, false, false])
    // 逐字切出來的中文序列:只有第一字承接詞邊界,後面全 false(渲染層不加詞距)
    const zh = tokenizeKaraokeChunk('這是一段中文')
    expect(zh.spaceBefore.every((s, i) => s === (i === 0))).toBe(true)
  })
})

describe('buildBulletFallback', () => {
  // 移植調整:統一為 Bullet 形狀 { text, detail, title, subPoints }
  it('以換行切分為句點式 bullet', () => {
    const out = buildBulletFallback('甲\n乙\n\n丙')
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ text: '甲', detail: '', title: '', subPoints: [] })
  })

  it('空腳本回傳空陣列', () => {
    expect(buildBulletFallback('')).toEqual([])
    expect(buildBulletFallback('  \n  ')).toEqual([])
  })
})

describe('splitSingleBullet', () => {
  it('可拆分出 >=2 句時回傳新 bullet 陣列(最多 12 個)', () => {
    const out = splitSingleBullet('這是一段非常有意義而且十分詳盡的第一個重點說明。這是一段包含第二個重點且字數足夠長度達標的詳細內容說明。')
    expect(out).not.toBeNull()
    expect(out!.length).toBeGreaterThanOrEqual(2)
    expect(out!.length).toBeLessThanOrEqual(12)
    out!.forEach((b) => expect(b).toHaveProperty('text'))
  })

  it('不足 2 句回傳 null', () => {
    expect(splitSingleBullet('只有一句話。')).toBeNull()
  })
})
