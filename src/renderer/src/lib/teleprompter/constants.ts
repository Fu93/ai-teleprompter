// 提詞引擎視覺與切塊常數(自 flowprompt-v3 shared/contracts.js 移植)

export const PhraseVisuals = {
  PREV_LINE_OPACITY: 0.32,
  ACTIVE_LINE_OPACITY: 1,
  NEXT_LINE_OPACITY: 0.62,

  INACTIVE_PHRASE_OPACITY: 0.72,
  ACTIVE_PHRASE_OPACITY: 0.95,
  UPCOMING_PHRASE_OPACITY: 0.88,
  NEXT_UPCOMING_PHRASE_OPACITY: 0.78,

  READ_AHEAD_NEXT_OPACITY: 0.78,
  READ_AHEAD_UPCOMING_OPACITY: 0.55,

  LINE_HEIGHT: 1.7,
  MAX_LINES_PER_SENTENCE: 2,
  TARGET_CHARS_PER_LINE_MIN: 32,
  TARGET_CHARS_PER_LINE_MAX: 42,

  PHRASE_TRANSITION_MS: 180,
  COLOR_TRANSITION_MS: 200,
  SENTENCE_CROSSFADE_MS: 250,
  SENTENCE_EASING_PX: 6,

  // 逐句模式下每分鐘詞數基準(rate=1 時的朗讀速度)
  DEFAULT_WPM: 120,
  // 單一短語最短停留時間,避免快語速時畫面閃爍
  MIN_PHRASE_DURATION_MS: 800,
  // 句尾停頓區間(額外疊加在句末短語上)
  SENTENCE_PAUSE_MIN_MS: 250,
  SENTENCE_PAUSE_MAX_MS: 400,
  // 預先顯示下一句的提前量
  UPCOMING_PHRASE_ADVANCE_MS: 500
} as const

export const PhraseChunkingRules = {
  MIN_WORDS_PER_PHRASE: 2,
  MAX_WORDS_PER_PHRASE: 4,

  /** 斷句標點(中英全半形、破折號、刪節號、CJK 引號) */
  PUNCTUATION_BREAKS: /[,.，。！!？?；;：:—–\-…」』》】]/,

  CONJUNCTIONS_BEFORE: [
    'but', 'and', 'so', 'because', 'although', 'though',
    'however', 'therefore', 'moreover', 'furthermore', 'nevertheless'
  ] as readonly string[],

  PREPOSITIONS_BEFORE: [
    'for', 'with', 'about', 'in terms of', 'regarding', 'concerning',
    'despite', 'except', 'besides', 'unlike', 'versus'
  ] as readonly string[],

  CN_CONJUNCTIONS: ['但是', '而且', '所以', '因為', '雖然', '不過', '然而'] as readonly string[]
} as const
