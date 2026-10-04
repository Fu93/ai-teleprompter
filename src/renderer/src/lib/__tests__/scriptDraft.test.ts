import { describe, expect, it } from 'vitest'
import { shouldReuseEmptyDraft, UNTITLED_TITLE } from '../scriptDraft'

describe('shouldReuseEmptyDraft — 「新講稿」的空稿重用規則', () => {
  it('空白草稿(沒有內容也沒有標題)重用,不另建', () => {
    expect(shouldReuseEmptyDraft({ title: '', content: '' }, false)).toBe(true)
  })

  it('剛建立的「未命名講稿」還是空的 → 重用', () => {
    expect(shouldReuseEmptyDraft({ title: UNTITLED_TITLE, content: '' }, false)).toBe(true)
  })

  it('有內容就另建(使用者真的要第二份)', () => {
    expect(shouldReuseEmptyDraft({ title: UNTITLED_TITLE, content: '各位好' }, false)).toBe(false)
  })

  it('有自訂標題就另建(就算內容是空的 —— 那是一份有名字的稿)', () => {
    expect(shouldReuseEmptyDraft({ title: '季度報告', content: '' }, false)).toBe(false)
  })

  it('未存變更不重用:呼叫端剛明確決定「放棄變更並新增」', () => {
    expect(shouldReuseEmptyDraft({ title: '', content: '' }, true)).toBe(false)
  })

  it('全形空白視為還沒開始寫(使用者按了空白鍵就離開)', () => {
    expect(shouldReuseEmptyDraft({ title: '　 ', content: '　' }, false)).toBe(true)
  })
})
