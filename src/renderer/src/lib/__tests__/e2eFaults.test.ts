/**
 * e2eFaults.test.ts — 環境故障注入器的**邊界行為**。
 *
 * 這組測試測的是注入器本身(不是 e2e):e2e/mic-denied.spec.ts 驗「使用者
 * 真的看到那句話」,而這裡驗「注入出去的錯誤形狀**完全**與 Chromium 一致」——
 * 因為 describeError 是靠 err.name 比對的,注入器只要把名字打錯一個字母,
 * e2e 就會測到「錯誤訊息完全沒有變」,然後失敗 —— 而那個失敗看起來像產品缺陷。
 *
 * 兩條斷言都刻意写成「反向」:不斷言「有安裝」,而是斷言「名字是對的」
 * 與「預設世界是乾淨的」。前者擋得住形狀漂移,後者擋得住「忘了加旗標」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseMicScenario,
  parseOllamaScenario,
  isFaultInjected,
  describeEnv,
  E2E_ENV_DEFAULT
} from '@shared/e2eEnv'
import { installE2EFaults, __resetE2EFaults } from '../e2eFaults'

describe('情境解析:預設必須是乾淨的', () => {
  it('未設定、大小寫不同、亂打的值都退回 ok', () => {
    // 預設乾淨是安全邊界:打包版與所有沒有明確要求的 e2e 都必須走真實路徑。
    // 而「打錯一個字」不該讓整條 e2e 掛掉 —— 但也不該靜默地測成正常路徑,
    // 所以診斷訊息會印出實際套用的情境(見 helpers/env.ts 的 envSummary)。
    for (const bad of [undefined, null, '', '  ', 'DENIED_', 'yes', 'false', '1']) {
      expect(parseMicScenario(bad as string | undefined)).toBe('ok')
      expect(parseOllamaScenario(bad as string | undefined)).toBe('ok')
    }
  })

  it('大小寫與空白不影響結果(避免 CI 上手滑就變成另一個世界)', () => {
    expect(parseMicScenario('DENIED')).toBe('denied')
    expect(parseMicScenario('  Busy ')).toBe('busy')
    expect(parseMicScenario('not-found')).toBe('not-found')
    expect(parseOllamaScenario('DOWN')).toBe('down')
    expect(parseOllamaScenario(' No-Model ')).toBe('no-model')
  })

  it('isFaultInjected 只在真的有注入時為 true', () => {
    expect(isFaultInjected(E2E_ENV_DEFAULT)).toBe(false)
    expect(isFaultInjected({ mic: 'denied', ollama: 'ok' })).toBe(true)
    expect(isFaultInjected({ mic: 'ok', ollama: 'down' })).toBe(true)
  })

  it('describeEnv 兩個情境都出現(失敗訊息靠它辨識世界)', () => {
    const s = describeEnv({ mic: 'busy', ollama: 'no-model' })
    expect(s).toContain('mic=busy')
    expect(s).toContain('ollama=no-model')
  })
})

describe('installE2EFaults —— 注入出去的形狀必須與 Chromium 一致', () => {
  /** vitest 的 jsdom 環境**沒有** navigator.mediaDevices,所以要自己造一個。 */
  const mediaDevices = { getUserMedia: vi.fn() } as unknown as MediaDevices
  let hadMediaDevices = false

  beforeEach(() => {
    __resetE2EFaults()
    hadMediaDevices = 'mediaDevices' in navigator
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      writable: true,
      value: mediaDevices
    })
    // 每次測試都重置 spy 的實作,避免前一個測試的包裝留在後面一個。
    // 這一點很重要:getUserMedia 是**同一個物件上的同一個屬性**,
    // 不還原的話測試順序會決定結果,而「測試順序決定結果」是最難查的一種失敗。
    mediaDevices.getUserMedia = vi.fn(async () => ({}) as unknown as MediaStream)
  })

  afterEach(() => {
    if (hadMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, writable: true, value: undefined })
    } else {
      delete (navigator as { mediaDevices?: unknown }).mediaDevices
    }
  })

  const call = (): Promise<MediaStream> => mediaDevices.getUserMedia({ audio: true })

  it('預設世界:完全不改變 getUserMedia', async () => {
    const applied = installE2EFaults(E2E_ENV_DEFAULT)
    expect(applied).toEqual([])
    // 乾淨世界的斷言是「照樣能用」,不是「沒有安裝」——
    // 因為一個「什麼都沒做」的注入器與一個「安裝失敗」的注入器長得一模一樣。
    await expect(call()).resolves.toBeDefined()
  })

  it('denied → NotAllowedError(權限被拒的那一個名稱)', async () => {
    installE2EFaults({ mic: 'denied', ollama: 'ok' })
    await expect(call()).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('busy → NotReadableError(被占用與被拒是不同的診斷)', async () => {
    // 這一條是本組最重要的斷言:兩者若都丟 NotAllowedError,使用者會被
    // 導去「Windows 設定 → 麥克風權限」—— 而他真正的問題是另一個程式
    // 占著麥克風。診斷錯了,代價是他的時間。
    installE2EFaults({ mic: 'busy', ollama: 'ok' })
    await expect(call()).rejects.toMatchObject({ name: 'NotReadableError' })
  })

  it('not-found → DevicesNotFoundError', async () => {
    installE2EFaults({ mic: 'not-found', ollama: 'ok' })
    await expect(call()).rejects.toMatchObject({ name: 'DevicesNotFoundError' })
  })

  it('安裝了什麼會被回報出來(讓失敗訊息看得出這是注入而不是缺陷)', () => {
    expect(installE2EFaults({ mic: 'denied', ollama: 'ok' })).toEqual([
      'getUserMedia → NotAllowedError'
    ])
  })

  it('重複安裝不會疊兩層(React 掛兩次是常見的)', async () => {
    installE2EFaults({ mic: 'denied', ollama: 'ok' })
    // 第二次必須是 no-op:否則第二層包裝會 reject 掉「已經是 Promise.reject
    // 的錯誤」,而那種錯誤在堆疊裡看不出是注入來的。
    expect(installE2EFaults({ mic: 'denied', ollama: 'ok' })).toEqual([])
    await expect(call()).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('只有 Ollama 情境時不動麥克風', async () => {
    // Ollama 的注入在 main 端(見 src/main/ollama.ts)。這裡確保 renderer
    // 不會多管閒事 —— 一個「順便也擋掉麥克風」的注入器會讓 Ollama 測試
    // 順帶測到麥克風,失敗時診斷方向就錯了。
    installE2EFaults({ mic: 'ok', ollama: 'down' })
    await expect(call()).resolves.toBeDefined()
  })
})