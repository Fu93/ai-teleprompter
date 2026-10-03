/**
 * update.test.ts — 「有更新待安裝」的提示為什麼必須能補問。
 *
 * 回歸的是這一輪修掉的缺陷:`update-downloaded` 是**一次性事件**,而原本的
 * 訂閱長在設定頁 mount 時 —— 更新預設在啟動 30 秒後下載完,那時使用者多半
 * 在別的頁,事件送達時沒有任何訂閱者,就永遠丟了。而 `autoInstallOnAppQuit`
 * 會在他下次關閉 App 時默默換掉版本,正是那段註解要避免的事。
 *
 * 所以這裡釘兩件事:
 *   1. 晚到的訂閱者能從 `appInfo().updateInfo` 把錯過的提示補回來
 *   2. 新到的事件會重置「稍後」的 dismiss(換了版本就該重新提醒)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/** 把假的 window.api 掛上去,並回傳「模擬事件到達」的陣列 */
function installApi(info: unknown, failure = false): { emit: () => void } {
  const emitFns: Array<() => void> = []
  const api = {
    appInfo: vi.fn(async () => {
      if (failure) throw new Error('ipc 沒回應')
      return { updateInfo: info }
    }),
    onUpdateDownloaded: (cb: (i: { version: string; releaseNotes: string }) => void): (() => void) => {
      emitFns.push(() => cb({ version: '9.9.9', releaseNotes: '' }))
      return () => undefined
    }
  }
  ;(globalThis as Record<string, unknown>).window = { api }
  return { emit: () => emitFns.forEach((f) => f()) }
}

describe('更新提示的補問與事件', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('事件已經錯過時,補問能把提示帶回來(這就是原本壞掉的那條路)', async () => {
    installApi({ version: '0.3.0', releaseNotes: '修好了' })
    const { hydrateUpdate, useUpdate } = await import('../update')

    expect(useUpdate.getState().info).toBeNull()
    await hydrateUpdate()
    expect(useUpdate.getState().info?.version).toBe('0.3.0')
    expect(useUpdate.getState().dismissed).toBe(false)
  })

  it('appInfo 失敗不丟例外 —— 拿不到更新資訊不該讓 App 起不來', async () => {
    installApi(null, true)
    const { hydrateUpdate, useUpdate } = await import('../update')
    await expect(hydrateUpdate()).resolves.toBeUndefined()
    expect(useUpdate.getState().info).toBeNull()
  })

  it('沒有待安裝更新時補問不會憑空生出一則', async () => {
    installApi(null)
    const { hydrateUpdate, useUpdate } = await import('../update')
    await hydrateUpdate()
    expect(useUpdate.getState().info).toBeNull()
  })

  it('按過「稍後」之後,同一個版本不再打擾;換了版本要重新提醒', async () => {
    const { emit } = installApi(null)
    const { watchUpdate, useUpdate } = await import('../update')

    const off = watchUpdate()
    emit()
    expect(useUpdate.getState().info?.version).toBe('9.9.9')

    useUpdate.getState().dismiss()
    expect(useUpdate.getState().dismissed).toBe(true)

    // 同一版本的重播不該把 dismiss 打掉(啟動時 hydrate 與事件可能都到)
    useUpdate.getState().set({ version: '9.9.9', releaseNotes: '' })
    expect(useUpdate.getState().dismissed).toBe(true)

    // 換了版本 = 一件新的事,必須重新提醒
    useUpdate.getState().set({ version: '10.0.0', releaseNotes: '' })
    expect(useUpdate.getState().dismissed).toBe(false)

    expect(typeof off).toBe('function')
    off()
  })
})
