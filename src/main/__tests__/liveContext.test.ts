import { describe, it, expect } from 'vitest'
import { pushTranscript, getRecentContext, clearContext, contextSize } from '../liveContext'

describe('liveContext 環形緩衝', () => {
  it('空時回 no recent speech 標記', () => {
    clearContext()
    expect(getRecentContext()).toMatch(/^\(no recent speech/)
  })

  it('推入與合併順序', () => {
    clearContext()
    pushTranscript('第一句', 'them', 1000)
    pushTranscript('second line', 'me', 2000)
    expect(contextSize()).toBe(2)
    const ctx = getRecentContext(2000)
    expect(ctx).toContain('第一句')
    expect(ctx).toContain('second line')
  })

  it('時間窗內優先取 them + me 各自的最後幾段', () => {
    clearContext()
    pushTranscript('q1', 'them', 1000)
    pushTranscript('q2', 'them', 2000)
    pushTranscript('q3', 'them', 3000)
    pushTranscript('q4', 'them', 4000)
    pushTranscript('q5', 'them', 5000)
    pushTranscript('q6', 'them', 6000)
    pushTranscript('q7', 'them', 7000)
    pushTranscript('my speech', 'me', 8000)
    const ctx = getRecentContext(9000)
    // them 最多取最後 6 段、me 最後 4 段;them 6 段 + me 1 段
    expect(ctx).toContain('q2')
    expect(ctx).not.toContain('q1')
    expect(ctx).toContain('my speech')
  })

  it('超量時裁切(>500 觸發裁到 200,穩態介於兩者之間)', () => {
    clearContext()
    for (let i = 0; i < 600; i++) {
      pushTranscript(`line ${i}`, 'me', i)
    }
    // v3 語意:超過 500 才裁到 200;600 次推入後 = 200 + 99 = 299,仍在軟上限內
    expect(contextSize()).toBe(299)
    expect(contextSize()).toBeLessThanOrEqual(500)
  })

  it('空白推入被忽略', () => {
    clearContext()
    pushTranscript('   ')
    expect(contextSize()).toBe(0)
  })
})
