import { describe, it, expect } from 'vitest'
import { buildKaraokeChunks, buildBulletFallback, splitSingleBullet } from '../modeTransforms'

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
