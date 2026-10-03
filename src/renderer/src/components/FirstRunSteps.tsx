/**
 * FirstRunSteps.tsx — 「你走到第幾步了」的卡片(判斷在 lib/onboarding.ts)。
 *
 * 為什麼是一張可忽略的卡片而不是精靈:見 onboarding.ts 檔頭第一點。
 * 擋路的精靈會讓只想看看浮層長什麼樣的人永遠進不去,而「進不去」比
 * 「沒提醒」更致命。
 *
 * ── 為什麼總覽頁只有這一張進度卡(2026-10-03)──
 *   原本下面還有第二張「開始三部曲」(建立第一份講稿 / 個人化校準 /
 *   跑一場錄音轉錄),兩張都是三欄按鈕格、都有進度語意、步驟定義不同。
 *   新使用者一開場看到六個任務、兩套說法,而且 FirstRunSteps 自己的
 *   aria-label 就自稱「開始三部曲」—— 兩個同名的東西在講不同的三步。
 *   現在只剩這一張(它是唯一接上 preflight 的一張),校準則降級成卡片
 *   底部的一行提醒(needsCalibration):它確實該被提醒,但它不是「能不能
 *   開始」的一步,所以不該佔一格進度。
 *
 * 刻意做的事:
 *   - 三步全部顯示,**不隱藏已完成的**。使用者需要看到「麥克風 ✓ / 模型 ✗」
 *     這種對照,才能知道自己卡在哪;只顯示未完成的那一步,他就以為 App
 *     每次都在催他做同一件事。
 *   - 完成的步驟**不可點**。做成灰色且 cursor-default,而不是灰掉還能按 ——
 *     「按了沒反應」與「看起來就不能按」要能分辨,否則使用者會一直試。
 *   - 完成後自動收合成一行,而不是留一個「3/3 已完成」的大卡片:
 *     已經達成的目標不需要持續佔版面,而 Dashboard 上方還有 preflight。
 *   - 每顆按鈕帶 data-effect-id:效果稽核要能驗「按下去真的到那一頁」。
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Check, Circle, Loader, Mic, Ruler, Sparkles, Type } from 'lucide-react'
import {
  evaluateOnboarding,
  firstBlockingHow,
  hasPromptedBefore,
  type OnboardingInput,
  type OnboardingResult
} from '../lib/onboarding'
import type { PreflightResult } from '../lib/preflight'
import { cn } from '../lib/utils'

const ICONS = { mic: Mic, model: Sparkles, 'first-prompt': Type } as const

export interface FirstRunStepsProps {
  /** 麥克風真的用過一次(有存下來的會議或練習) */
  micEverWorked: boolean
  /** preflight 的判定結果(AI 還差什麼) */
  preflight: PreflightResult | null
  /** 有沒有至少一份有內容的講稿 */
  hasScript: boolean
  /**
   * 還沒做過個人化校準(沒有 personal.profile)。
   *
   * 校準決定浮層的字級與滾動速度 —— 沒做也能用,只是用到的是預設值。
   * 所以它是「卡片底部的一行提醒」而不是第四步:三步的定義是「能不能開始」,
   * 而校準是「開始得好不好」。混進來會讓進度條數到 4,也讓「3 分鐘上手」
   * 這句標題變成謊話。
   */
  needsCalibration?: boolean
  onNavigate: (page: 'settings' | 'record' | 'practice' | 'scripts' | 'calibration') => void
}

export function FirstRunSteps({
  micEverWorked,
  preflight,
  hasScript,
  needsCalibration,
  onNavigate
}: FirstRunStepsProps): JSX.Element | null {
  const [hasPrompted, setHasPrompted] = useState(hasPromptedBefore)

  // 「推過浮層」這個旗標可能是在**別的頁面**寫下的(講稿頁的「開始提詞」)。
  // 使用者回到總覽頁時這裡還記得 false,卡片就會永遠停在 2/3 —— 直到他
  // 重新整理。所以回到焦點時重讀一次,這不是多餘的保險,是唯一正確的行為。
  const refresh = useCallback((): void => {
    setHasPrompted(hasPromptedBefore())
  }, [])
  useEffect(() => {
    window.addEventListener('focus', refresh)
    window.addEventListener('ai-tp:prompted', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('ai-tp:prompted', refresh)
    }
  }, [refresh])

  // 模型就緒與「還差什麼」都取自 preflight,不重新實作一套判斷。
  const modelReady = !!preflight && !preflight.items.some((i) => i.severity === 'blocking')
  const input: OnboardingInput = {
    micEverWorked,
    modelReady,
    modelBlocker: firstBlockingHow(preflight),
    hasScript,
    hasPrompted
  }
  const result: OnboardingResult = evaluateOnboarding(input)

  const go = (step: (typeof result.steps)[number]): void => {
    // 已完成的步驟不導航:它沒有東西要「完成」,導航過去只會讓使用者
    // 以為漏了什麼。寫在這裡而不是讓按鈕 disabled,是為了讓稽核與鍵盤
    // 都不必理解這條規則 —— 一個不渲染的按鈕比一個看得見但沒反應的按鈕誠實。
    if (step.state === 'done') return
    if (step.target) {
      onNavigate(step.target)
      return
    }
    // (這裡原本有一行 `if (step.id === 'first-prompt' && hasScript) markPrompted()`,
    //  但它永遠不可達:每個步驟都有 target,上面那行就 return 了。而且語意也不對
    //  ——「點了這一步」不等於「提詞成功」,完成旗標的唯一寫入者是
    //  markPromptSucceeded()(真的把有內容的講稿推上浮層之後才寫)。
    //  看起來在做事的死碼比沒有更糟:它讓「點擊就算完成」變成一個
    //  有人信以為真的行為。)
  }

  if (result.complete) {
    return (
      <div
        data-onboarding="complete"
        data-effect-scope="onboarding"
        className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-4 py-2.5 text-[11px] text-ink-300"
      >
        <Check size={13} className="shrink-0 text-emerald-400" />
        <span className="flex-1">三個步驟都完成過了 —— 接下來直接用就好。</span>
      </div>
    )
  }

  return (
    <div
      data-onboarding="card"
      data-effect-scope="onboarding"
      className="card p-4"
      // 給稽核一個穩定的錨點:「這張卡片是不是三步」;名稱跟著標題走 ——
      // 它原本叫「開始三部曲」,而頁面上另一張卡的字面標題就叫那個名字,
      // 兩個同名的東西在講不同的三步(下一行的 aria-label 與該卡的 aria-label
      // 在 DOM 裡同時存在,任何用名稱找元素的自動化都會指到錯的那一張)。
      aria-label={`3 分鐘上手,已完成 ${result.doneCount} / ${result.steps.length} 步`}
    >
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={14} className="text-accent-400" />
        <span className="text-xs font-semibold text-ink-100">3 分鐘上手</span>
        <span className="text-[11px] text-ink-400">
          {result.doneCount} / {result.steps.length} 完成 · 隨時可以跳過
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {result.steps.map((step) => {
          const Icon = ICONS[step.id]
          const done = step.state === 'done'
          return (
            <button
              key={step.id}
              type="button"
              // 穩定身分:標題文案會改,而稽核的控制項 key 需要不隨文案變動,
              // 否則它每次改文案都會變成一顆「未登記」的控制項。
              data-effect-id="onboarding-step"
              onClick={() => go(step)}
              aria-label={`${step.title}:${step.action}`}
              className={cn(
                'flex flex-col items-start gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                done
                  ? 'cursor-default border-emerald-500/20 bg-emerald-500/8'
                  : 'cursor-pointer border-white/10 bg-white/4 hover:border-accent-500/50 hover:bg-accent-500/8'
              )}
            >
              <span className="flex w-full items-center gap-1.5">
                {done ? (
                  <Check size={14} className="shrink-0 text-emerald-400" />
                ) : step.state === 'blocked' ? (
                  <Loader size={14} className="shrink-0 text-amber-400" />
                ) : (
                  <Circle size={14} className="shrink-0 text-ink-400" />
                )}
                <Icon size={13} className="shrink-0 text-ink-300" />
                <span className={cn('truncate text-xs font-medium', done ? 'text-ink-400' : 'text-ink-100')}>
                  {step.title}
                </span>
              </span>
              <span className="line-clamp-2 text-[11px] leading-snug text-ink-400">{step.action}</span>
            </button>
          )
        })}
      </div>
      {needsCalibration && (
        // 校準提醒:一行、可點、可忽略。用「建議」而不是「必須」開頭 —— 它真的
        // 不是必須(沒有它也開得了浮層),而阻擋級的步驟會在格子上顯示成 blocked,
        // 不會被藏在這裡。原本這件事是總覽頁第二張卡(「開始三部曲」)在講的,
        // 那張卡已經移除(見檔頭),這個提醒是它唯一該留下的資訊。
        <button
          type="button"
          data-effect-id="onboarding-calibration"
          onClick={() => onNavigate('calibration')}
          className="mt-2.5 flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] text-ink-400 transition-colors hover:bg-white/5 hover:text-ink-300"
        >
          <Ruler size={12} className="shrink-0" />
          <span className="flex-1">
            建議先做「個人化校準」(兩個小測驗量眼距與語速)—— 字級與滾動速度會自動配成你的最適值。
          </span>
        </button>
      )}
    </div>
  )
}
