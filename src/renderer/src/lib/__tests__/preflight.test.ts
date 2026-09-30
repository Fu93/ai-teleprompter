/**
 * preflight.test.ts — 「這台電腦還差什麼」的判斷邏輯。
 *
 * 這是一個純函式,所以可以窮舉。窮舉的價值在於**分級**那一組:
 * 「沒裝 Ollama」與「裝了但沒拉模型」必須給不同的指引,「本地 Whisper 還沒
 * 下載」與「AI 完全不能用」也必須分開 —— 把它們混成一個紅色警告,
 * 會讓只有其中一個問題的人以為整個程式壞了。
 *
 * 另一組同樣重要:什麼時候**不該**出聲。設定還沒載完時宣布「你少三樣東西」,
 * 是一個假紅字;全部準備好時還留著卡片,是在訓練使用者忽略它。
 */
import { describe, expect, it } from 'vitest'
import {
  evaluatePreflight,
  OLLAMA_DOWNLOAD_URL,
  SUGGESTED_OLLAMA_MODEL,
  type PreflightInput
} from '../preflight'
import type { AppSettings } from '@shared/types'

/** 只給到判斷會用到的欄位,其他用 cast 補空 —— 這條測試不關心其他設定。 */
const baseSettings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    ai: {
      provider: 'ollama',
      ollama: { baseUrl: 'http://127.0.0.1:11434', model: SUGGESTED_OLLAMA_MODEL },
      openaiCompatible: { baseUrl: '', apiKey: '', model: '' }
    },
    stt: {
      engine: 'local',
      localModel: 'base',
      language: 'zh',
      cloud: { baseUrl: '', apiKey: '', model: '' }
    },
    ...over
  }) as unknown as AppSettings

const input = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  settings: baseSettings(),
  ollamaModels: ['qwen2.5:7b'],
  ollamaReachable: true,
  cloudSttKeyPresent: false,
  cloudAiKeyPresent: false,
  ...over
})

const ids = (over: Partial<PreflightInput> = {}): string[] =>
  evaluatePreflight(input(over)).items.map((i) => i.id)

describe('evaluatePreflight', () => {
  describe('什麼時候不該出聲', () => {
    it('設定還沒載完:什麼都不報,而不是報「你少一堆東西」', () => {
      const r = evaluatePreflight({ ...input(), settings: null })
      expect(r.items).toEqual([])
      expect(r.severity).toBe('ready')
      expect(r.blocking).toBe(false)
    })

    it('AI 準備好時:只剩本地 STT 的下載提示,而且那不是阻擋', () => {
      // 注意:本地 Whisper 的提示**永遠**存在 —— 模型快取由 transformers 管理,
      // renderer 看不到它下載過沒有,所以只能事先告知「第一次會等」。
      // 因此 severity 在本地 STT 下不會是 'ready';真正該問的是「能不能開始」,
      // 那是 blocking。
      const r = evaluatePreflight(input())
      expect(r.items.map((i) => i.id)).toEqual(['stt-local-download'])
      expect(r.blocking).toBe(false)
    })

    it('雲端 STT 且有金鑰時:真的什麼都不缺', () => {
      const s = baseSettings()
      s.stt.engine = 'cloud'
      const r = evaluatePreflight(input({ settings: s, cloudSttKeyPresent: true }))
      expect(r.items).toEqual([])
      expect(r.severity).toBe('ready')
    })
  })

  describe('AI 模型:三種狀態必須是三種不同的指引', () => {
    it('Ollama 連不上 → 擋路,而且給下載連結', () => {
      const r = evaluatePreflight(input({ ollamaReachable: false, ollamaModels: null }))
      expect(r.blocking).toBe(true)
      const item = r.items.find((i) => i.id === 'ai-ollama-down')
      expect(item).toBeTruthy()
      expect(item!.severity).toBe('blocking')
      expect(item!.how).toContain(OLLAMA_DOWNLOAD_URL)
      expect(item!.action).toEqual({ kind: 'external', url: OLLAMA_DOWNLOAD_URL })
    })

    it('連得上但沒有模型 → 擋路,而且給**可複製的指令**', () => {
      const r = evaluatePreflight(input({ ollamaModels: [], ollamaReachable: true }))
      expect(r.blocking).toBe(true)
      const item = r.items.find((i) => i.id === 'ai-ollama-no-model')
      expect(item).toBeTruthy()
      // 這是整個功能存在的原因:使用者要在自己的終端機打這行字
      expect(item!.command).toBe(`ollama pull ${SUGGESTED_OLLAMA_MODEL}`)
      expect(item!.how).toContain('終端機')
    })

    it('有模型 → 不報', () => {
      expect(ids()).not.toContain('ai-ollama-no-model')
      expect(ids()).not.toContain('ai-ollama-down')
    })

    it('還在查(ollamaModels 為 null)且連不上時,不能說「沒有模型」', () => {
      // null = 還沒查完,不是「查完了是空的」。混淆這兩者會給錯的指引:
      // 對真的沒裝的人說「去 pull 一個模型」是白費一趟。
      const r = evaluatePreflight(input({ ollamaModels: null, ollamaReachable: false }))
      const aiIds = r.items.map((i) => i.id).filter((id) => id.startsWith('ai-'))
      expect(aiIds).toEqual(['ai-ollama-down'])
      expect(aiIds).not.toContain('ai-ollama-no-model')
    })

    it('雲端 provider 卻沒填金鑰 → 擋路,且不該再提 Ollama', () => {
      const s = baseSettings()
      s.ai.provider = 'openai-compatible'
      const r = evaluatePreflight(input({ settings: s, cloudAiKeyPresent: false }))
      expect(r.items.map((i) => i.id)).toContain('ai-cloud-no-key')
      expect(r.items.map((i) => i.id)).not.toContain('ai-ollama-no-model')
    })

    it('雲端 provider 有金鑰 → AI 那一項不報', () => {
      const s = baseSettings()
      s.ai.provider = 'openai-compatible'
      expect(ids({ settings: s, cloudAiKeyPresent: true })).not.toContain('ai-cloud-no-key')
    })
  })

  describe('語音辨識:分「第一次要等一下」與「不能用」', () => {
    it('本地 Whisper:只是 notice,不是 blocking', () => {
      const r = evaluatePreflight(input())
      const item = r.items.find((i) => i.id === 'stt-local-download')
      expect(item).toBeTruthy()
      // 這一項只影響第一次錄音,而且有進度條。把一個只影響第一次的等待
      // 升級成擋路級,會讓人以為程式壞了。
      expect(item!.severity).toBe('notice')
      expect(r.blocking).toBe(false)
      expect(r.severity).toBe('notice')
    })

    it('本地 Whisper 的說明要帶實際大小,不是「會下載模型」', () => {
      const item = evaluatePreflight(input()).items.find((i) => i.id === 'stt-local-download')!
      expect(item.how).toMatch(/\d+\s*MB/)
    })

    it('換成 small 也要反映實際大小', () => {
      const s = baseSettings()
      s.stt.localModel = 'small'
      const item = evaluatePreflight(input({ settings: s })).items.find((i) => i.id === 'stt-local-download')!
      expect(item.how).toContain('500MB')
    })

    it('雲端 STT 沒金鑰 → blocking', () => {
      const s = baseSettings()
      s.stt.engine = 'cloud'
      const r = evaluatePreflight(input({ settings: s, cloudSttKeyPresent: false }))
      expect(r.items.map((i) => i.id)).toContain('stt-cloud-no-key')
      expect(r.blocking).toBe(true)
    })

    it('雲端 STT 沒金鑰時必須提醒音訊會被送出去', () => {
      const s = baseSettings()
      s.stt.engine = 'cloud'
      const item = evaluatePreflight(input({ settings: s })).items.find((i) => i.id === 'stt-cloud-no-key')!
      expect(item.how).toContain('音訊')
    })
  })

  describe('嚴重度分級', () => {
    it('只有 notice → severity=notice,blocking=false', () => {
      const r = evaluatePreflight(input())
      expect(r.severity).toBe('notice')
      expect(r.blocking).toBe(false)
    })

    it('AI 擋路 + STT notice → 整體是 blocking,但 notice 仍然列出', () => {
      const r = evaluatePreflight(input({ ollamaModels: [] }))
      expect(r.severity).toBe('blocking')
      // notice 不能因為有 blocking 就被吃掉 —— 使用者要一次看齊所有要做的事
      expect(r.items.map((i) => i.id).sort()).toEqual(['ai-ollama-no-model', 'stt-local-download'])
    })

    it('兩個都擋路時 blocking 仍是 true', () => {
      const s = baseSettings()
      s.stt.engine = 'cloud'
      const r = evaluatePreflight(input({ settings: s, ollamaModels: [], cloudSttKeyPresent: false }))
      expect(r.blocking).toBe(true)
      expect(r.severity).toBe('blocking')
    })
  })

  describe('每一項都要有可執行的下一步', () => {
    it('不該有任何一項是「沒有 action 也沒有 command」', () => {
      const cases: PreflightInput[] = [
        input({ ollamaModels: [] }),
        input({ ollamaReachable: false, ollamaModels: null })
      ]
      const s1 = baseSettings()
      s1.ai.provider = 'openai-compatible'
      cases.push(input({ settings: s1, cloudAiKeyPresent: false }))
      const s2 = baseSettings()
      s2.stt.engine = 'cloud'
      cases.push(input({ settings: s2, cloudSttKeyPresent: false }))
      cases.push(input())

      for (const c of cases) {
        for (const item of evaluatePreflight(c).items) {
          expect(item.action ?? item.command, `${item.id} 沒有任何下一步`).toBeTruthy()
        }
      }
    })

    it('指引是中文句子,而且不是「請檢查設定」這種無法執行的說法', () => {
      for (const item of evaluatePreflight(input({ ollamaModels: [] })).items) {
        expect(item.how.length).toBeGreaterThan(12)
        expect(item.how).toMatch(/[一-鿿]/)
      }
    })
  })
})
