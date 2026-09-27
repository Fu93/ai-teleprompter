import { describe, it, expect } from 'vitest'
import { splitIntoSentences } from '../sentenceSplitter'

describe('splitIntoSentences — 基本斷句', () => {
  it('無效輸入回傳空陣列', () => {
    expect(splitIntoSentences(null)).toEqual([])
    expect(splitIntoSentences(undefined)).toEqual([])
    expect(splitIntoSentences('')).toEqual([])
    expect(splitIntoSentences('   ')).toEqual([])
  })

  it('依換行切分並去除空白行', () => {
    expect(splitIntoSentences('第一句。\n第二句！\n\n第三句？')).toEqual(['第一句。', '第二句！', '第三句？'])
  })

  it('中文標點(無空白)在預設 token 化下視為單句', () => {
    expect(splitIntoSentences('你好嗎？我很好。謝謝！')).toEqual(['你好嗎？我很好。謝謝！'])
  })

  it('英文句點/驚嘆號/問號斷句', () => {
    expect(splitIntoSentences('Hello world. This is fun! Is it?')).toEqual(['Hello world.', 'This is fun!', 'Is it?'])
  })

  it('保留內嵌數字與小數點不誤切', () => {
    const out = splitIntoSentences('Pi is 3.14 ok. Next here.')
    expect(out.length).toBe(2)
  })
})

describe('splitIntoSentences — 縮寫保護', () => {
  it('保留英文縮寫(Mr. / Dr. / etc.)不誤切', () => {
    const out = splitIntoSentences('Mr. Smith is here. Dr. Jones agrees.')
    expect(out).toEqual(['Mr. Smith is here.', 'Dr. Jones agrees.'])
  })

  it('保留單字母大寫縮寫(J. Smith)', () => {
    const out = splitIntoSentences('J. Smith came. Then left.')
    expect(out).toEqual(['J. Smith came.', 'Then left.'])
  })

  it('多標點縮寫(U.S.A.)為既有限制,行為忠實保留', () => {
    expect(splitIntoSentences('U.S.A. is big. So is Canada.')).toEqual(['U.S.A.', 'is big.', 'So is Canada.'])
  })

  it('縮寫位於句末時仍可切句', () => {
    const out = splitIntoSentences('See you at 5 p.m. tomorrow. Great.')
    expect(out).toEqual(['See you at 5 p.m.', 'tomorrow.', 'Great.'])
  })
})
