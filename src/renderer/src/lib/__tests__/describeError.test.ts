import { describe, it, expect } from 'vitest'
import { classifyError, describeError, isActionable } from '../describeError'

// 這組測試的價值在於「不要給錯誤的診斷」。
// 反例:Record 停止時原本把「辨識失敗」說成「沒有偵測到語音」,
// 使用者會跑去查麥克風硬體 —— 診斷錯了,代價是他的時間。
describe('describeError', () => {
  it('麥克風權限被拒:給出 Windows 設定路徑', () => {
    const e = new Error('Permission denied')
    e.name = 'NotAllowedError'
    const m = describeError(e)
    expect(m).toContain('權限')
    // 必須告訴他要去哪裡改,否則等於沒回答
    expect(m).toContain('隱私權')
  })

  it('跨 IPC 的錯誤只剩字串時仍能辨識(名字已遺失)', () => {
    expect(describeError('Permission denied')).toContain('權限')
    expect(describeError('NotAllowedError: Permission denied')).toContain('權限')
  })

  it('API 金鑰錯誤指向設定頁', () => {
    expect(describeError('401 Unauthorized')).toContain('API 金鑰')
    expect(describeError('Invalid API key provided')).toContain('API 金鑰')
  })

  it('Ollama 沒開時說明怎麼啟動', () => {
    const m = describeError('fetch failed', { provider: 'ollama' })
    expect(m).toContain('Ollama')
    expect(m).toContain('ollama serve')
  })

  it('用雲端 API 時連線失敗不得叫人去啟動 Ollama', () => {
    // 回帰:這條規則原本只看訊息,而 Ollama 沒開與雲端被防火牆擋掉丟出的
    // 都是同一句 `fetch failed`(ECONNREFUSED 藏在 cause,過了 IPC 就沒了)。
    // 少了 provider,唯一的出路就是猜 —— 而猜錯等於把使用者的網路問題
    // 說成「去開 Ollama」,正是這支檔案自己說不可以犯的錯。
    const ai = describeError('fetch failed', { provider: 'openai-compatible' })
    expect(ai).not.toContain('Ollama')
    expect(ai).toContain('AI API')
    const stt = describeError('fetch failed', { provider: 'cloud-api' })
    expect(stt).not.toContain('Ollama')
    expect(stt).toContain('雲端語音 API')
  })

  it('沒有情境時只給中性的網路訊息,不臆測供應商', () => {
    const m = describeError('fetch failed')
    expect(m).toContain('網路')
    expect(m).not.toContain('Ollama')
  })

  it('找不到麥克風與麥克風被占用是不同問題', () => {
    expect(describeError('NotFoundError: Requested device not found')).toContain('找不到')
    expect(describeError('NotReadableError: Could not start audio source')).toContain('占用')
  })

  it('不認得的錯誤回退到原文,不臆測診斷', () => {
    // 寧可顯示真實的英文原文,也不要自信地給錯的原因
    expect(describeError('Something totally unexpected happened')).toBe(
      'Something totally unexpected happened'
    )
  })

  it('認得的錯誤不會洩漏原始英文給使用者', () => {
    const e = new Error('Permission denied')
    e.name = 'NotAllowedError'
    const m = describeError(e)
    expect(m).not.toContain('Permission denied')
    expect(m).not.toContain('NotAllowedError')
  })

  it('isActionable 只對認得的錯誤為 true', () => {
    const e = new Error('Permission denied')
    e.name = 'NotAllowedError'
    expect(isActionable(e)).toBe(true)
    expect(isActionable('random failure')).toBe(false)
  })

  it('空值不會拋錯,給出可讀訊息', () => {
    expect(describeError(new Error(''))).toBe('發生未預期的錯誤')
  })
})

/**
 * 跨 realm 的錯誤 —— 這組是實測出來的缺陷的回歸測試。
 *
 * 現場:校準頁的相機開不起來時,使用者看到的是
 *
 *     攝影機不可用（{"isTrusted":true}）。
 *
 * 一句零資訊的錯,而它出現在**最常見的第一個牆**上。原因不是亂碼,是
 * `instanceof`:Electron 的 preload 與頁面是兩個 JS realm,兩邊的 `Error`
 * 是不同的建構子,所以從那邊過來的錯誤在這邊 `instanceof Error` 是 false,
 * 原先的寫法就掉進 JSON.stringify —— 而 name/message 都是 prototype 上的
 * getter,stringify 只看得到 own property,於是什麼都沒留下。
 *
 * 這些測試用「原型上放 getter」的物件模擬跨 realm:own property 裡
 * 沒有 name/message,只有走原型鏈才拿得到 —— 這正是 JSON.stringify 看不見的原因。
 */
describe('describeError 對跨 realm 錯誤的處理', () => {
  /** 造一個 name/message 只在原型上、own property 為空的物件(= 跨 realm 的樣子) */
  function crossRealmError(name: string, message: string): object {
    const proto = { name, message }
    return Object.create(proto)
  }

  it('prototype 上的 name + message 讀得到,而且能認出是權限問題', () => {
    const e = crossRealmError('NotAllowedError', 'Permission denied')
    // 認得出來才會給中文指引 —— 這是這一條存在的理由
    expect(classifyError(e)).toBe('E_MIC_PERMISSION_DENIED')
    expect(describeError(e)).toContain('權限')
  })

  it('認不出來時至少給得出英文原文,而不是 {"isTrusted":true}', () => {
    const e = crossRealmError('SomethingNobodyKnows', 'a message a human wrote')
    const m = describeError(e)
    expect(m).not.toContain('isTrusted')
    expect(m).not.toContain('{"')
    expect(m).toContain('SomethingNobodyKnows')
    expect(m).toContain('a message a human wrote')
  })

  it('只有 type 沒有 message 的 Event:認得出權限錯誤就給中文指引', () => {
    // 這一條比「讀得出 type」更有價值:純粹的 type 字串也足以走完整條分類。
    // 瀏覽器把權限拒絕也會用 Event 的形式送出,只有 type 沒有 message。
    const e = Object.create({ type: 'notallowederror' })
    expect(classifyError(e)).toBe('E_MIC_PERMISSION_DENIED')
    expect(describeError(e)).toContain('權限')
  })

  it('只有 type 而認不出來:至少不要變成空字串或 JSON', () => {
    const e = Object.create({ type: 'weird-media-event' })
    const m = describeError(e)
    expect(m).toContain('weird-media-event')
    expect(m).not.toContain('{"')
  })

  it('真的認不出來時回退到原本的行為(JSON 原文),不發明診斷', () => {
    // 這個模組的原則:寧可顯示真實的(即使是難懂的)原文,也不要自信的假診斷
    expect(describeError({ isTrusted: true })).toBe('{"isTrusted":true}')
  })

  it('null / undefined / 數字不會拋錯', () => {
    expect(() => describeError(null)).not.toThrow()
    expect(() => describeError(undefined)).not.toThrow()
    expect(() => describeError(42)).not.toThrow()
    expect(typeof describeError(null)).toBe('string')
  })

  it('name 與 message 相同時不重複印兩次', () => {
    const e = Object.create({ name: 'Oops', message: 'Oops' })
    expect(describeError(e)).toBe('Oops')
  })
})
