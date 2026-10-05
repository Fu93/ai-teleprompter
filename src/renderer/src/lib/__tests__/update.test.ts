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

  it('「稍後」之後復原入口必須看得到:App 用的是同一個渲染條件函式,拿掉它就是拿掉功能', async () => {
    const { emit } = installApi(null)
    const { watchUpdate, useUpdate, updateEntryVisible } = await import('../update')

    const off = watchUpdate()
    emit()

    // 渲染條件是 lib/update.ts 的 updateEntryVisible:App.tsx 呼叫它,
    // 所以「拿掉呼叫」與「函式本身壞掉」都會在這裡紅。
    // (元件渲染本身由 audit-effects 的真探針量 —— 兩層各守一半。)
    const s = useUpdate.getState()
    // 橫幅在場(dismissed=false):入口必須隱藏 —— 兩個「重新啟動」會互搶焦点
    expect(updateEntryVisible(s), '橫幅在場時側欄不該再出現入口').toBe(false)
    // 按「稍後」:橫幅消失,入口必須接手 —— 否則整個 App 沒有任何地方
    // 再看得到「已下載更新」,而它是 autoInstallOnAppQuit 的唯一提醒
    useUpdate.getState().dismiss()
    expect(updateEntryVisible(useUpdate.getState()), 'dismiss 後側欄入口必須成立,否則「已下載更新」從畫面徹底消失').toBe(true)
    // 入口點下去之後 dismissed 仍應是 true:使用者已說過「別擋路」,
    // 入口只是把它收進側欄,不該反悔成全螢幕橫幅
    expect(useUpdate.getState().dismissed).toBe(true)
    // 版本清掉(例如更新已安裝、main 不再回報)時入口跟著消失
    useUpdate.setState({ info: null, dismissed: false })
    expect(updateEntryVisible(useUpdate.getState())).toBe(false)
    off()
  })
})
