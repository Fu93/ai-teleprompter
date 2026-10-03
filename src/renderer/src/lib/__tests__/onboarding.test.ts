/**
 * onboarding.test.ts — 首用三步的判斷。
 *
 * 這組測試的重點不是「算得對」,而是**三個不會說謊的性質**:
 *   1. 麥克風步驟只由「真的用過」決定(不依賴權限 API 的假設)
 *   2. preflight 還在查(回 null)時,模型步驟**絕不**是 done
 *   3. 標題與動作文案不含內部代碼或診斷術語
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { evaluateOnboarding, firstBlockingHow, hasPromptedBefore, markPrompted } from '../onboarding'
import { evaluatePreflight, type PreflightResult } from '../preflight'
import { DEFAULT_SETTINGS } from '@shared/types'

const base = {
  micEverWorked: false,
  modelReady: false,
  hasScript: false,
  hasPrompted: false
}

describe('evaluateOnboarding', () => {
  it('全新使用者三步都未完成,且每一步都給得出具體動作', () => {
    const r = evaluateOnboarding(base)
    expect(r.complete).toBe(false)
    expect(r.doneCount).toBe(0)
    expect(r.steps).toHaveLength(3)
    // 「完成設定」這種空話不算動作:每一步都要有他可以照著做的東西
    for (const s of r.steps) {
      expect(s.action.length).toBeGreaterThan(4)
      expect(s.action).not.toMatch(/完成設定|設定好|請設定/)
    }
  })

  it('麥克風只看「真的用過」,不看任何權限假設', () => {
    // 這一條是這一輪量出來的取捨:permissions.query 在 Electron 上幾乎恆回
    // prompt,所以「查權限」會讓這一步永遠是未完成。證明力在於這裡只餵
    // evidence,沒有任何欄位可以影響它。
    const r = evaluateOnboarding({ ...base, micEverWorked: true })
    expect(r.steps.find((s) => s.id === 'mic')?.state).toBe('done')
    const r2 = evaluateOnboarding({ ...base, micEverWorked: false })
    expect(r2.steps.find((s) => s.id === 'mic')?.state).toBe('todo')
  })

  it('模型未就緒是 blocked 而非 todo —— 他現在按了也做不到', () => {
    const r = evaluateOnboarding({ ...base, modelReady: false, modelBlocker: '先安裝並啟動 Ollama' })
    const step = r.steps.find((s) => s.id === 'model')
    expect(step?.state).toBe('blocked')
    // 阻擋項必須把 preflight 的原話帶過來,不要改寫成別的說法
    expect(step?.action).toBe('先安裝並啟動 Ollama')
  })

  it('三步全完成時 complete 為 true 且 count 為 3', () => {
    const r = evaluateOnboarding({
      micEverWorked: true,
      modelReady: true,
      hasScript: true,
      hasPrompted: true
    })
    expect(r.complete).toBe(true)
    expect(r.doneCount).toBe(3)
  })

  it('「有講稿」不等於「提詞成功過」—— 兩者是不同的一步', () => {
    // 空白講稿也會開出空浮層,所以有講稿只能讓這一步變成 todo。
    const r = evaluateOnboarding({ ...base, hasScript: true })
    const step = r.steps.find((s) => s.id === 'first-prompt')
    expect(step?.state).toBe('todo')
    expect(r.doneCount).toBe(0)
  })

  it('完成狀態只由最後一步的旗標決定,不受其他步影響', () => {
    // 反向依賴是一種常見的實作錯誤(例如「三步都做過就當提詞過了」)。
    // 那會讓一個只做過校準的人看見「第一段提詞 ✓」。
    const r = evaluateOnboarding({ ...base, micEverWorked: true, modelReady: true, hasScript: true })
    expect(r.doneCount).toBe(2)
    expect(r.steps.find((s) => s.id === 'first-prompt')?.state).toBe('todo')
  })
})

describe('firstBlockingHow', () => {
  it('只取第一個阻擋項的第一行,不去重複 preflight 的細節', () => {
    const res = evaluatePreflight({
      settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'ollama' } },
      ollamaModels: null,
      ollamaReachable: false,
      cloudSttKeyPresent: false,
      cloudAiKeyPresent: false
    })
    const how = firstBlockingHow(res)
    expect(how).toBeTruthy()
    // 只取第一行:完整的多段說明是 preflight 卡片的工作,
    // 這裡再複述一次會讓總覽頁出現兩份 Ollama 教學
    expect(how).not.toContain('\n')
  })

  it('沒有阻擋項時回 undefined,不給一句泛泛的說明', () => {
    const res = evaluatePreflight({
      settings: DEFAULT_SETTINGS,
      ollamaModels: ['qwen2.5:7b'],
      ollamaReachable: true,
      cloudSttKeyPresent: false,
      cloudAiKeyPresent: false
    })
    // 本地 STT 只有 notice 級,所以沒有 blocking
    expect(firstBlockingHow(res)).toBeUndefined()
  })

  it('null(preflight 還在查)時回 undefined —— 不得宣稱準備好了', () => {
    expect(firstBlockingHow(null as PreflightResult | null)).toBeUndefined()
  })
})

/**
 * 單元測試的環境是 `node`(vitest.config.ts),**沒有 localStorage**。
 *
 * 這一點值得停下來:第一版這組測試直接用 localStorage,結果「標記後讀得到」
 * 紅在 `expected false to be true` —— 而**產品碼在這裡是正確的**(try/catch
 * 吃掉 ReferenceError,回 false)。也就是說那條測試量到的是「node 裡沒有
 * localStorage」,不是「旗標寫不進去」。
 *
 * 這正是本專案記載過最多次的失敗模式:一條抓不到目標的斷言,長得跟防線
 * 一模一樣。所以這裡顯式 stub 一個 localStorage 進來 —— 讓測試真正驗到
 * 「寫了讀得到」,並且另外用一條測試鎖住「不可得時不拋錯」。
 */
function stubLocalStorage(): Map<string, string> {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  })
  return map
}

describe('提詞里程碑旗標', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('預設是沒提詞過', () => {
    stubLocalStorage()
    expect(hasPromptedBefore()).toBe(false)
  })

  it('標記後讀得到', () => {
    const map = stubLocalStorage()
    markPrompted()
    expect(hasPromptedBefore()).toBe(true)
    expect(map.get('ai-tp.firstrun.prompted')).toBe('1')
  })

  it('localStorage 不可得時安靜退回「沒提詞過」,而不是拋錯', () => {
    // 隱私模式 / 環境沒有 localStorage。拋錯會讓整張卡片掛掉,
    // 而那比多問一次嚴重得多。
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {}
    })
    expect(() => markPrompted()).not.toThrow()
    expect(hasPromptedBefore()).toBe(false)
  })
})
