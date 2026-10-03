/**
 * onboarding.ts — 首用「3 分鐘成功路徑」的判斷。
 *
 * ── 這個檔案存在的問題 ──
 *   全新使用者下載這個 App 之後,要在 3 分鐘內完成三件事:麥克風能用、
 *   AI 模型可用、第一段提詞成功。而原本的狀態是這三件事各自在不同頁面、
 *   不同時機、用不同的方式被要求,使用者要自己把三個線頭接起來:
 *     - 麥克風:按「開始練習」或「開始聆聽」才知道能不能用
 *     - 模型:總覽頁有一張 preflight 卡片,但它講的是「AI 還差什麼」,
 *             與「我現在能不能開始」不是同一個問題
 *     - 提詞:要自己先有一份有內容的講稿才知道浮層長什麼樣
 *   也就是說:三件事各自都有提示,但沒有地方告訴他「你已經走到第幾步」。
 *
 * ── 三個刻意的設計 ──
 *
 * 1. **不擋路。** 這不是入口精靈,而是一張可以完全忽略的卡片。理由見
 *    `preflight.ts` 檔頭第一點:擋路的精靈會讓只想看浮層長什麼樣的人永遠
 *    進不去,而「進不去」比「沒提醒」更致命。評分使用者三個月後的使用經驗,
 *    記住的是「它擋我」,不是「它提醒我」。
 *
 * 2. **每一步的完成狀態都來自「已經發生過的事」,不是「查權限 API」。**
 *    這一點是量測出來的,不是推測:`navigator.permissions.query({name:
 *    'microphone'})` 在 Electron 上回 `prompt` 的機率遠高於 `granted`
 *    (Electron 的 permission handler 預設不查詢實際授權狀態),所以用它的話
 *    第一步會**永遠**顯示「未完成」—— 使用者明明已經成功錄過音,畫面卻說他
 *    還沒設定好。那比沒有這張卡片更糟:它讓人懷疑自己記錯了。
 *    改成讀「有沒有成功過」的證據(真的存下一場會議/練習、真的開過有內容的
 *    浮層),這件事一旦成立就不會再變,也不會撒謊。
 *
 * 3. **不重複 preflight 已經講的東西。** 「AI 還差什麼」(缺模型、缺金鑰)
 *    是 preflight 的工作;這裡只回答「能不能開始了」。兩者刻意分開:
 *    把缺模型的細節搬過來會讓這張卡片變成第二個 preflight,而使用者在
 *    總覽頁會看到兩張都在講 Ollama 的卡片。
 */
import type { PreflightResult } from './preflight'

export type OnboardingStepId = 'mic' | 'model' | 'first-prompt'

export type OnboardingStepState = 'done' | 'todo' | 'blocked'

export interface OnboardingStep {
  id: OnboardingStepId
  /** 標題:使用者一眼知道自己站在哪裡 */
  title: string
  /** 這一步要做的具體動作,不是「完成設定」這種空話 */
  action: string
  state: OnboardingStepState
  /**
   * blocked = 有東西擋著,而且那個東西**他現在做不到**(例如模型沒下載,
   * 而下載要在終端機打指令)。
   * todo   = 他現在就能做。
   *
   * 區分這兩者的理由:「todo 可以點下去」是使用者在 3 分鐘裡唯一能依靠的
   * 線索。一律顯示成同一種可點狀態,會讓他點了三下才發現其中一個根本按不動。
   */
  /** 點下去要去哪 */
  target?: 'settings' | 'record' | 'practice' | 'scripts'
}

export interface OnboardingInput {
  /**
   * 麥克風真的用過一次了。
   *
   * 證據 = 有任何一場會議或練習被存下來。不用 `permissions.query`:
   * 見檔頭第二點。
   */
  micEverWorked: boolean
  /**
   * AI 模型現在可用。
   *
   * 由 preflight 的 blocking 判定給出,不重新實作 —— 兩份邏輯一定會漂移,
   * 而漂移的結果是「卡片說可以開始、按下去被擋」。
   */
  modelReady: boolean
  /**
   * 還差什麼才能讓模型可用(給 blocked 步驟一個具體的「怎麼做」)。
   * 直接取 preflight 第一個 blocking 項目的 how —— 同一句話,同一個出處。
   */
  modelBlocker?: string
  /** 有沒有至少一份**有內容**的講稿 */
  hasScript: boolean
  /** 有沒有真的把有內容的講稿推上浮層過(存起來的旗標,不是推算) */
  hasPrompted: boolean
}

export interface OnboardingResult {
  steps: OnboardingStep[]
  /** 三步都完成 */
  complete: boolean
  /** 已完成幾步(用於「2/3」的顯示) */
  doneCount: number
}

export function evaluateOnboarding(input: OnboardingInput): OnboardingResult {
  const steps: OnboardingStep[] = [
    {
      id: 'mic',
      title: '麥克風可用',
      action: '錄 10 秒話,看到逐字稿就算成功',
      state: input.micEverWorked ? 'done' : 'todo',
      target: 'record'
    },
    {
      id: 'model',
      title: 'AI 模型可用',
      action: input.modelBlocker ?? '到設定頁測試連線',
      state: input.modelReady ? 'done' : 'blocked',
      target: 'settings'
    },
    {
      id: 'first-prompt',
      title: '第一段提詞',
      action: input.hasScript ? '打開提詞浮層跟著唸' : '先寫一段講稿',
      state: input.hasPrompted ? 'done' : 'todo',
      // 不需要三元:「有沒有講稿」只影響 action 文案,兩種情況都去講稿頁
      // (原本寫成 input.hasScript ? 'scripts' : 'scripts' —— 一個 no-op,
      //  讀起來卻像兩條路,與它下面那段不可達的 markPrompted 一起誤導人)。
      target: 'scripts'
    }
  ]

  const doneCount = steps.filter((s) => s.state === 'done').length
  return { steps, complete: doneCount === steps.length, doneCount }
}

/**
 * 從 preflight 結果取出「AI 還差什麼」的第一句。
 *
 * 只取第一個 blocking 項:這張卡片不是 preflight 的複製品,列三個阻擋項
 * 只會讓它變長。使用者要看完整的,preflight 卡片就在同一頁的正上方。
 */
export function firstBlockingHow(preflight: PreflightResult | null): string | undefined {
  const blocking = preflight?.items.find((i) => i.severity === 'blocking')
  return blocking?.how.split('\n')[0]
}

// ===== 「我推過浮層了」這個旗標 =====
//
// 存在的原因:「有講稿」不等於「提詞成功過」。空白講稿也會開出一個空浮層
// (Scripts 頁有擋,Dashboard 的清單鈕原本沒有)。所以完成狀態必須讀
// 「真的把有內容的內容推上去了」這個事實。
//
// 放 localStorage 而不是 settings.json:它是**一次性里程碑**,不是使用者
// 調校的偏好。放 settings 會讓它出現在備份裡,使用者的第一次成功提詞
// 會跟著備份跑到別的電腦上,然後那台電腦一開就顯示「3/3 已完成」。
const PROMPTED_KEY = 'ai-tp.firstrun.prompted'

/** 是否真的推過有內容的浮層。讀取失敗時回 false(寧可多問一次,不可聲稱完成)。 */
export function hasPromptedBefore(): boolean {
  try {
    return localStorage.getItem(PROMPTED_KEY) === '1'
  } catch {
    return false
  }
}

/** 記下「第一次提詞成功」。localStorage 不可得時靜默放棄 —— 記不住不是錯誤。 */
export function markPrompted(): void {
  try {
    localStorage.setItem(PROMPTED_KEY, '1')
  } catch {
    /* 隱私模式:記不住只是下次還會再問一次 */
  }
}

/**
 * 記下「第一次提詞成功」+ 通知正在看畫面的那張卡片。
 *
 * 為什麼要包成一支,而不是讓呼叫端自己 markPrompted() + dispatchEvent:
 *   成功開浮層的地方有兩處 —— 總覽頁的「開始提詞」與提詞講稿頁的同一顆鈕。
 *   原本只有總覽頁那條路寫旗標,於是「先在講稿頁按開始提詞」的使用者回到
 *   總覽頁時,3 分鐘上手會停在 2/3 並寫著「打開提詞浮層跟著吧」—— 而他剛剛
 *   才做過那件事。進度顯示說謊比不顯示更糟:它會讓人以為自己漏了什麼。
 *
 *   呼叫時機仍然是「真的 show 成功之後」,不是按下钮的那一刻(提前寫等於
 *   把一次失敗也算成完成)。集中成一支之後,「成功」的定義只有一份。
 */
export function markPromptSucceeded(): void {
  markPrompted()
  window.dispatchEvent(new Event('ai-tp:prompted'))
}
