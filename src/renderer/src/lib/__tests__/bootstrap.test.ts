/**
 * 啟動時序的測試。
 *
 * ── 這條測試要擋住的具體失效 ──
 *   main.tsx 原本是:
 *     void window.api?.appInfo()?.then((info) => { installE2EFaults(...) })
 *     ReactDOM.createRoot(...).render(<App />)
 *
 *   註解宣稱「要在 React 掛載之前完成」,程式碼沒有做到 —— appInfo() 是一次
 *   IPC 往返,render 緊接著同步跑。症狀不會讓任何測試變紅:注入晚到時麥克風
 *   拒絕路徑就量不到,而測試會**照樣綠**(量到的是正常路徑)。這是本專案
 *   記錄過最貴的一種失敗:一個看起來在保護你的測試,實際上什麼都沒檢查。
 *
 *   當時讓它綠的東西是 e2e 裡的 `waitForTimeout(1200)` —— 用 sleep 蓋住競態。
 *   所以這裡測的不是「注入有沒有生效」,而是**順序**:bootstrap 還沒 resolve 時
 *   就去掛 React,注入必須已經完成。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runBootstrap } from '../bootstrap'
import { __resetE2EFaults } from '../e2eFaults'
import type { AppInfo } from '@shared/types'

/** 一個可控的 appInfo():想多久才回,就多久才回。 */
function deferredInfo<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 型別明確標成 AppInfo —— 否則 e2eEnv 會被推成 string 而過不了 typecheck。 */
function fakeInfo(over: Partial<Pick<AppInfo, 'audit' | 'e2eEnv'>> = {}): AppInfo {
  return {
    version: '0.2.0',
    platform: 'win32',
    userDataPath: 'C:/tmp',
    debug: false,
    audit: false,
    hotkeyConflicts: [],
    e2eEnv: { mic: 'ok', ollama: 'ok' },
    ...over
  } as AppInfo
}

/**
 * vitest 跑在 node 環境(見 vitest.config.ts),沒有 window。
 * 這裡補一個假的:它同時釘住 bootstrap 對 `window` 的存在與否都有防護 ——
 * 「瀏覽器直開時不該炸」是這個檔案的第四條測試。
 */
function stubWindow(): { w: Record<string, unknown> } {
  const w: Record<string, unknown> = {}
  vi.stubGlobal('window', w)
  return { w }
}

describe('renderer bootstrap', () => {
  const originalMediaDevices = globalThis.navigator?.mediaDevices

  beforeEach(() => {
    __resetE2EFaults()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (originalMediaDevices) {
      Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: originalMediaDevices, configurable: true })
    }
  })

  it('注入在 bootstrap resolve 之前就完成 —— 掛載時麥克風已經是拒絕狀態', async () => {
    const { w } = stubWindow()
    const original = vi.fn().mockResolvedValue({} as MediaStream)
    const md = { getUserMedia: original }
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: md, configurable: true })

    const info = deferredInfo<ReturnType<typeof fakeInfo>>()

    // 掛載點:在 bootstrap 之後才會發生(這正是修好之後的順序)
    let micWasPatchedAtMount = false
    const boot = runBootstrap(() => info.promise)
    void boot.then(() => {
      micWasPatchedAtMount = md.getUserMedia !== original
    })

    // 這一段是重點:appInfo 還沒回,不可能有任何注入發生
    expect(micWasPatchedAtMount).toBe(false)
    expect(md.getUserMedia).toBe(original)

    info.resolve(fakeInfo({ audit: true, e2eEnv: { mic: 'denied', ollama: 'ok' } }))
    const result = await boot

    expect(result.applied).toContain('getUserMedia → NotAllowedError')
    expect(result.toastBridge).toBe(true)
    // 掛載那一刻(bootstrap 之後)麥克風必須已經被換掉
    expect(micWasPatchedAtMount).toBe(true)
    expect(md.getUserMedia).not.toBe(original)
    // e2e 靠這個旗標取代原本的 waitForTimeout(1200)——它必須在注入後可查
    expect(w['__injectedFaults']).toContain('getUserMedia → NotAllowedError')
  })

  it('乾淨環境不注入任何東西(正式使用者的情況)', async () => {
    const { w } = stubWindow()
    const md = { getUserMedia: vi.fn().mockResolvedValue({} as MediaStream) }
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: md, configurable: true })
    const before = md.getUserMedia

    const result = await runBootstrap(async () => fakeInfo())

    expect(result.applied).toEqual([])
    expect(result.toastBridge).toBe(false)
    expect(md.getUserMedia).toBe(before)
    // 乾淨環境下**不該**掛旗標 —— 它是「跑在假世界裡」的標記
    expect(w['__injectedFaults']).toBeUndefined()
  })

  it('appInfo 掛掉時以乾淨環境啟動,而不是讓整個入口檔中止', async () => {
    const md = { getUserMedia: vi.fn().mockResolvedValue({} as MediaStream) }
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: md, configurable: true })
    const before = md.getUserMedia
    const warn = vi.fn()

    const result = await runBootstrap(async () => {
      throw new Error('ipc down')
    }, warn)

    expect(result.applied).toEqual([])
    expect(md.getUserMedia).toBe(before)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ipc down'))
  })

  it('window.api 不存在(瀏覽器直開)時也不會拋', async () => {
    stubWindow()
    const result = await runBootstrap(() => undefined)
    expect(result.applied).toEqual([])
    expect(result.toastBridge).toBe(false)
  })
})
