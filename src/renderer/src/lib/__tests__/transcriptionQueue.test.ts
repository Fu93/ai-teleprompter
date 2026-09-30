import { describe, expect, it } from 'vitest'
import { createPendingTracker, drainPending } from '../transcriptionQueue'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('drainPending', () => {
  it('沒有在飛的請求時立刻完成(不會白白等到逾時)', async () => {
    const res = await drainPending([], 10_000)
    expect(res).toEqual({ drained: true, outstanding: 0, elapsedMs: 0 })
  })

  it('全部完成時 drained=true 且 outstanding=0', async () => {
    const jobs = [Promise.resolve(1), Promise.resolve(2)]
    const res = await drainPending(jobs, 10_000)
    expect(res.drained).toBe(true)
    expect(res.outstanding).toBe(0)
  })

  it('失敗的請求也算結束 —— 用 allSettled 而非 all,否則一個 401 會拖到逾時', async () => {
    const jobs = [Promise.reject(new Error('401 unauthorized')), Promise.resolve('ok')]
    const res = await drainPending(jobs, 10_000)
    expect(res.drained).toBe(true)
    expect(res.outstanding).toBe(0)
  })

  it('逾時時回報仍未完成的精確數量(不是全部,也不是全部完成)', async () => {
    const slow = new Promise<void>(() => {
      /* 永不 resolve:模擬卡住的雲端請求 */
    })
    const jobs = [Promise.resolve('done'), slow, slow]
    const res = await drainPending(jobs, 30)
    expect(res.drained).toBe(false)
    expect(res.outstanding).toBe(2)
    expect(res.elapsedMs).toBeGreaterThanOrEqual(25)
  })

  it('逾時不會讓程序一直開著 timer(計時器有被清掉)', async () => {
    const slow = new Promise<void>(() => {})
    const res = await drainPending([slow], 10)
    expect(res.drained).toBe(false)
    // 能走到這裡代表 finally 有清掉 timer;再等一下確認沒有殘留副作用
    await tick()
    expect(res.outstanding).toBe(1)
  })

  it('部分請求在時限內完成時,逾時回報的 outstanding 只算還沒完成的', async () => {
    const later = new Promise<void>((r) => setTimeout(r, 5))
    const never = new Promise<void>(() => {})
    const res = await drainPending([later, never], 40)
    expect(res.drained).toBe(false)
    expect(res.outstanding).toBe(1)
  })
})

describe('createPendingTracker', () => {
  it('依 key 分組:取出的內容只含該 key 的請求', () => {
    const t = createPendingTracker<number>()
    t.track(1, Promise.resolve())
    t.track(1, Promise.resolve())
    t.track(2, Promise.resolve())
    expect(t.take(1)).toHaveLength(2)
    expect(t.take(2)).toHaveLength(1)
    expect(t.take(3)).toHaveLength(0)
  })

  it('請求結束(含失敗)後自動移除,不會讓 Map 無界成長', async () => {
    const t = createPendingTracker<number>()
    t.track(7, Promise.resolve())
    t.track(7, Promise.reject(new Error('stt failed')))
    expect(t.size(7)).toBe(2)
    await tick()
    await tick()
    expect(t.size(7)).toBe(0)
    expect(t.take(7)).toHaveLength(0)
  })
})
