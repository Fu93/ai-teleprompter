import { describe, it, expect, beforeEach } from 'vitest'
import { useToasts, toast } from '../toast'

describe('toast store', () => {
  beforeEach(() => {
    useToasts.setState({ items: [] })
  })

  it('push 新增至堆疊頂部,success/error/info 分型', () => {
    toast.error('A')
    toast.success('B')
    const items = useToasts.getState().items
    expect(items.map((t) => [t.kind, t.message])).toEqual([
      ['success', 'B'],
      ['error', 'A']
    ])
    expect(items[0].remainingMs).toBe(4000)
    expect(items[0].running).toBe(true)
  })

  it('tick 到期移除,暫停中不倒數', () => {
    toast.info('X')
    const id = useToasts.getState().items[0].id
    useToasts.getState().tick(3000)
    expect(useToasts.getState().items).toHaveLength(1)
    useToasts.getState().setPaused(id, true)
    useToasts.getState().tick(5000) // 暫停中:不消耗
    expect(useToasts.getState().items).toHaveLength(1)
    useToasts.getState().setPaused(id, false)
    useToasts.getState().tick(1500) // 恢復後走完剩餘 1s
    expect(useToasts.getState().items).toHaveLength(0)
  })

  it('重複訊息不堆疊,重設計時', () => {
    toast.error('same')
    useToasts.getState().tick(3500)
    toast.error('same')
    const items = useToasts.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].remainingMs).toBe(12000)
  })

  it('錯誤比資訊久:使用者看到權限被拒後要離開 App 去改設定,4 秒不夠', () => {
    toast.info('即將消失')
    toast.error('需要你去做點什麼')
    const byKind = Object.fromEntries(
      useToasts.getState().items.map((t) => [t.kind, t.remainingMs] as const)
    )
    expect(byKind.info).toBe(4000)
    expect(byKind.error).toBe(12000)
    // 資訊到點消失時,錯誤訊息必須還在——否則使用者根本來不及讀完
    useToasts.getState().tick(4000)
    const kinds = useToasts.getState().items.map((t) => t.kind)
    expect(kinds).toEqual(['error'])
  })

  it('上限 3 則,超額丟最舊', () => {
    toast.info('1')
    toast.info('2')
    toast.info('3')
    toast.info('4')
    const msgs = useToasts.getState().items.map((t) => t.message)
    expect(msgs).toEqual(['4', '3', '2'])
  })

  it('dismiss 手動移除', () => {
    toast.info('Y')
    const id = useToasts.getState().items[0].id
    useToasts.getState().dismiss(id)
    expect(useToasts.getState().items).toHaveLength(0)
  })
})
