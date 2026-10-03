/**
 * practiceAnswer.ts — 練習答案的組裝(單一出處)。
 *
 * 為什麼要抽出來:同一個答案原本在三處各自組裝(反饋成功 / 取消 / 失敗),
 * 而「取消反饋」那條路徑把 `partial` 寫死成 true —— 於是**逐字稿完整、
 * 只是不想等 AI 評論**的答案,在畫面上被標成
 * 「逐字稿可能不完整(當時語音辨識逾時或有段落失敗)」。
 * 那是一則錯誤的診斷:使用者會以為自己的麥克風或模型出狀況。
 *
 * `partial` 的語意只有一個:逐字稿本身不完整(辨識逾時或有段落失敗)。
 * 「沒有拿到反饋」是另一件事 —— 它由 `feedback` 的缺席表示,
 * 畫面上顯示「未評分」,不再借用 partial 的旗標。
 */
import type { PracticeAnswer, PracticeFeedback } from '@shared/types'

export interface BuildPracticeAnswerArgs {
  question: string
  transcript: string
  answerStart: number
  answerEndedAt: number
  /** 逐字稿不完整(辨識逾時或段落失敗)。取消/失敗的**反饋**不影響這個旗標。 */
  partial: boolean
  /** 沒給 = 未評分(取消或 AI 反饋失敗);答案與逐字稿一律保留。 */
  feedback?: PracticeFeedback
}

export function buildPracticeAnswer(args: BuildPracticeAnswerArgs): PracticeAnswer {
  const answer: PracticeAnswer = {
    question: args.question,
    answerTranscript: args.transcript,
    durationSec: Math.max(0, (args.answerEndedAt - args.answerStart) / 1000),
    // false 時不落欄位(而不是存 false):PracticeAnswer.partial 是「有這件事才標」
    // 的可選旗標,存 false 會讓備份裡多一個語意模糊的欄位。
    partial: args.partial || undefined
  }
  if (args.feedback) answer.feedback = args.feedback
  return answer
}
