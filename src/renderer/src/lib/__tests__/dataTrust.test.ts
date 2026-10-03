/**
 * dataTrust.test.ts — 「你的資料去了哪裡」的判斷。
 *
 * 這組測試守的是一個很單純但很容易壞掉的性質:**面板不得對使用者說謊**。
 * 具體來說是三條:
 *   1. 從本地引擎切到雲端,面板必須跟著變(靜態文案會是最糟的失效方式,
 *      因���它看起來完全正常)
 *   2. 沒有填 Base URL 時必須明說「尚未設定」,不能留白 —— 留白會被讀成
 *      「不會上傳」
 *   3. 端點只到主機名:完整 URL 的 path/query 可能有 token
 */
import { describe, it, expect } from 'vitest'
import { buildDataTrust, hasExternalTransfer, backupExcludesKeys } from '../dataTrust'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { AppSettings } from '@shared/types'

const keys = { secureStoreHasSttKey: false, secureStoreHasAiKey: false }

const cloudStt = (baseUrl: string): AppSettings => ({
  ...DEFAULT_SETTINGS,
  stt: { ...DEFAULT_SETTINGS.stt, engine: 'cloud', cloud: { baseUrl, apiKey: 'sk-x', model: 'whisper' } }
})

const cloudAi = (baseUrl: string): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ai: {
    provider: 'openai-compatible',
    ollama: DEFAULT_SETTINGS.ai.ollama,
    openaiCompatible: { baseUrl, apiKey: 'sk-x', model: 'gpt-4o-mini' }
  }
})

const rowOf = (rows: ReturnType<typeof buildDataTrust>, id: string) =>
  rows.find((r) => r.id === id)

describe('buildDataTrust', () => {
  it('預設(本地引擎)沒有任何一列會離開這台電腦', () => {
    const rows = buildDataTrust({ settings: DEFAULT_SETTINGS, ...keys })
    expect(hasExternalTransfer(rows)).toBe(false)
    // 講稿與逐字稿永遠是本機 —— 即使他改了雲端設定也一樣,
    // 而那正是使用者最需要被保證的一件事
    expect(rowOf(rows, 'scripts')?.kind).toBe('local')
    expect(rowOf(rows, 'sessions')?.kind).toBe('local')
  })

  it('切到雲端 STT:面板必須主動變,不能維持原話', () => {
    const rows = buildDataTrust({ settings: cloudStt('https://api.groq.com/openai/v1'), ...keys })
    expect(hasExternalTransfer(rows)).toBe(true)
    const stt = rowOf(rows, 'stt')
    expect(stt?.kind).toBe('upload')
    expect(stt?.warn).toBe(true)
    expect(stt?.where).toContain('groq.com')
  })

  it('切到雲端 AI:逐字稿會送到那裡 —— 這件事必須寫出來', () => {
    const rows = buildDataTrust({ settings: cloudAi('https://api.openai.com/v1'), ...keys })
    const ai = rowOf(rows, 'ai')
    expect(ai?.kind).toBe('upload')
    // 具體到「什麼內容」:只寫「會上傳」不足以讓他判斷要不要繼續用
    expect(ai?.where).toContain('摘要')
    expect(ai?.where).toContain('發言')
  })

  it('端點只顯示主機名,path 與 query 不進畫面', () => {
    const rows = buildDataTrust({
      settings: cloudAi('https://ai.example.com/v1/tenant-9999?key=leaked'),
      ...keys
    })
    const where = rowOf(rows, 'ai')?.where ?? ''
    expect(where).toContain('ai.example.com')
    expect(where).not.toContain('tenant-9999')
    expect(where).not.toContain('leaked')
  })

  it('未填 Base URL:明說尚未設定,不��白', () => {
    // 留白會被讀成「不會上傳」—— 而他確實選了雲端引擎。
    // 這個誤讀的代價是他以為資料安全,實際上他一開錄音就會被擋下。
    const rows = buildDataTrust({ settings: cloudStt(''), ...keys })
    const stt = rowOf(rows, 'stt')
    expect(stt?.kind).toBe('upload')
    expect(stt?.where).toContain('尚未設定')
    expect(stt?.where).not.toBe('')
  })

  it('金鑰:填了要說明存哪、備份裡有沒有', () => {
    const rows = buildDataTrust({
      settings: cloudAi('https://api.openai.com/v1'),
      secureStoreHasAiKey: true,
      secureStoreHasSttKey: false
    })
    const keysRow = rowOf(rows, 'keys')
    expect(keysRow?.where).toContain('Windows 加密儲存區')
    // 這是「為了使用者好」的限制,必須寫在畫面上 —— 默默做等於他以為備份完整
    expect(keysRow?.where).toContain('不會寫進備份')
  })

  it('沒填金鑰時說明不需要(本地引擎本來就不要)', () => {
    const rows = buildDataTrust({ settings: DEFAULT_SETTINGS, ...keys })
    expect(rowOf(rows, 'keys')?.where).toContain('不需要')
  })

  it('Panic 救援在雲端 AI 下要單獨列出(它會送上下文)', () => {
    const off = buildDataTrust({ settings: cloudAi('https://api.openai.com/v1'), ...keys })
    expect(rowOf(off, 'panic')).toBeDefined()
    // 關掉 AI 模式之後就不再送 —— 面板要反映實際行為而不是設定的預設值
    const on = buildDataTrust({
      settings: {
        ...cloudAi('https://api.openai.com/v1'),
        scenario: { ...DEFAULT_SETTINGS.scenario, aiModeEnabled: false }
      },
      ...keys
    })
    expect(rowOf(on, 'panic')).toBeUndefined()
  })

  it('設定還沒載完時回空陣列,而不是半套的清單', () => {
    // 半套的清單比沒有更糟:它會漏掉「會上傳」那一列,而那正是最重要的。
    expect(buildDataTrust({ settings: null, ...keys })).toEqual([])
  })

  it('每一列都要有 what 與 where —— 缺一列就等於沒回答', () => {
    const rows = buildDataTrust({ settings: cloudStt('https://api.groq.com/v1'), ...keys })
    expect(rows.length).toBeGreaterThan(3)
    for (const r of rows) {
      expect(r.what.length, `${r.id} 缺 what`).toBeGreaterThan(1)
      expect(r.where.length, `${r.id} 缺 where`).toBeGreaterThan(1)
    }
  })

  it('備份排除金鑰的宣稱與程式行為一致(見 backup.test.ts 的對應斷言)', () => {
    // 兩條測試各管一件事:那條證明程式行為,這條證明面板沒有誇大。
    // 若哪天 backup.ts 真的開始寫入金鑰,那條會紅 —— 而這條會提醒你
    // 面板的文案也必須跟著改。
    expect(backupExcludesKeys()).toBe(true)
  })
})
